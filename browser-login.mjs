// 浏览器登录超算互联网（WorkBuddy/Qoder 式的「打开官网登录页 → 自动接管」）。
//
// Windows 上 Chrome/Edge 137+ 的 App-Bound Encryption 封死了读日常浏览器 Cookie 库的路，
// 所以这里用一个**专用 profile 的受控浏览器窗口**：插件自己启动、自己关闭，与日常浏览器
// 完全隔离；profile 持久化在 %LOCALAPPDATA%\magpie-scnet-auth\browser-profile，
// 超算会话 Cookie 有效期内再次登录通常免输入，等几秒即自动完成。
//
// 拿到会话后复刻客户端自己的铸 Key 调用（POST /acx/llm/api-key/mcp/create，
// 名字 SCNet_Client），失败则退化为只读已有 Key；始终不创建普通 Key、不改浏览器设置。

import { spawn } from "node:child_process"
import { mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import {
  ConsoleError,
  currentUserInfo,
  ensureModelKey,
  pickPlan,
  tokenPlanList,
} from "./console.mjs"

export const DEFAULT_PORT = 30814
export const LOGIN_URL =
  "https://www.scnet.cn/ac/api/auth/loginSsoRedirect.action?originalUrl=" +
  encodeURIComponent("https://www.scnet.cn/ui/llm/apikeys")

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function profileDir() {
  const local = process.env.LOCALAPPDATA || join(process.env.USERPROFILE || "", "AppData", "Local")
  return join(local, "magpie-scnet-auth", "browser-profile")
}

export function browserCandidates() {
  const programFiles = process.env.ProgramFiles || "C:\\Program Files"
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)"
  const local = process.env.LOCALAPPDATA || join(process.env.USERPROFILE || "", "AppData", "Local")
  return [
    process.env.SCNET_AUTH_BROWSER,
    join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(local, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    join(local, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean)
}

function findBrowser() {
  const found = browserCandidates().find((path) => existsSync(path))
  if (!found) {
    throw new Error("没有找到 Edge 或 Chrome。请安装其一，或用环境变量 SCNET_AUTH_BROWSER 指定浏览器路径。")
  }
  return found
}

async function fetchJson(url, timeout = 3000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

async function portAlive(port) {
  try {
    await fetchJson(`http://127.0.0.1:${port}/json/version`, 1500)
    return true
  } catch {
    return false
  }
}

// 极简 CDP：只够 Storage.getCookies / Browser.close 用。
class CdpConnection {
  constructor(ws) {
    this.ws = ws
    this.nextId = 0
    this.pending = new Map()
    ws.addEventListener("message", (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.id && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id)
        this.pending.delete(message.id)
        clearTimeout(entry.timer)
        if (message.error) entry.reject(new Error(message.error.message ?? "CDP error"))
        else entry.resolve(message.result ?? {})
      }
    })
  }

  static connect(url, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      const timer = setTimeout(() => {
        try { ws.close() } catch {}
        reject(new Error("CDP 连接超时"))
      }, timeout)
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(new CdpConnection(ws)) }, { once: true })
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP 连接失败")) }, { once: true })
    })
  }

  send(method, params = {}, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} 超时`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async cookies() {
    const reply = await this.send("Storage.getCookies", {})
    return reply.cookies ?? []
  }

  close() {
    try { this.ws.close() } catch {}
  }
}

async function pageTarget(port) {
  try {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, 2500)
    const pages = (Array.isArray(targets) ? targets : []).filter((t) => t.webSocketDebuggerUrl && t.type === "page")
    return (
      pages.find((t) => /scnet\.cn/i.test(String(t.url))) ||
      pages[0] ||
      null
    )
  } catch {
    return null
  }
}

function scnetCookieString(cookies) {
  const pairs = []
  const seen = new Set()
  for (const cookie of cookies) {
    const domain = String(cookie.domain ?? "")
    if (domain !== "scnet.cn" && !domain.endsWith(".scnet.cn")) continue
    const id = `${domain}|${String(cookie.path ?? "/")}|${cookie.name}`
    if (seen.has(id)) continue
    seen.add(id)
    pairs.push(`${cookie.name}=${cookie.value}`)
  }
  return pairs.join("; ")
}

async function readSessionCookie(port) {
  const target = await pageTarget(port)
  if (!target) return ""
  let connection
  try {
    connection = await CdpConnection.connect(target.webSocketDebuggerUrl)
    return scnetCookieString(await connection.cookies())
  } catch {
    return ""
  } finally {
    connection?.close()
  }
}

async function closeBrowser({ port, child }) {
  try {
    const version = await fetchJson(`http://127.0.0.1:${port}/json/version`, 1500)
    if (version?.webSocketDebuggerUrl) {
      const connection = await CdpConnection.connect(version.webSocketDebuggerUrl, 3000)
      try { await connection.send("Browser.close", {}, 3000) } catch {}
      connection.close()
      await sleep(800)
    }
  } catch {}
  try { child?.kill() } catch {}
}

function accountNameOf(data) {
  if (!data || typeof data !== "object") return ""
  for (const name of ["userName", "nickName", "nickname", "name", "realName", "account"]) {
    const value = data[name]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

// 登录主流程：返回 {ok, session, error}。永远不抛异常（authorize 回调直接消费）。
export async function runBrowserLogin({ port = DEFAULT_PORT, timeoutMs = 300_000 } = {}) {
  let child = null
  const reused = await portAlive(port)
  if (!reused) {
    let exe
    try {
      exe = findBrowser()
    } catch (error) {
      return { ok: false, error: error.message }
    }
    try {
      mkdirSync(profileDir(), { recursive: true })
    } catch {}
    child = spawn(
      exe,
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir()}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=msSmartScreenPrompt",
        LOGIN_URL,
      ],
      { detached: false, stdio: "ignore", windowsHide: false },
    )
    const up = await (async () => {
      const deadline = Date.now() + 30_000
      for (;;) {
        if (await portAlive(port)) return true
        if (Date.now() > deadline) return false
        await sleep(500)
      }
    })()
    if (!up) {
      await closeBrowser({ port, child })
      return { ok: false, error: `浏览器调试端口 ${port} 没有起来（可能被策略禁止），请改用「手动配置 API Key」。` }
    }
  }

  try {
    // 轮询等登录：每 2.5s 读一次 Cookie 并向控制台验证会话。
    // 我们自己拉起的窗口若被用户关掉（进程退出且端口死了），快速失败，不干等超时。
    const deadline = Date.now() + timeoutMs
    let cookie = ""
    let identity = null
    while (Date.now() < deadline) {
      cookie = await readSessionCookie(port)
      if (cookie) {
        try {
          identity = await currentUserInfo(cookie)
          break
        } catch (error) {
          if (error instanceof ConsoleError && error.kind === "session") identity = null
          else throw error
        }
      }
      if (child && child.exitCode !== null && !(await portAlive(port, 1200))) {
        return { ok: false, error: "登录窗口被关闭了。请重新发起登录，并在弹出的窗口里完成 scnet.cn 的登录。" }
      }
      await sleep(2500)
    }
    if (!identity) {
      return {
        ok: false,
        error: `等待登录超时（${Math.round(timeoutMs / 60000)} 分钟）。请保持弹出的浏览器窗口处于打开状态并在其中完成登录；若窗口被误关，请重新发起登录。`,
      }
    }

    // 会话有效 → 铸 Key（客户端 agent 同款决策树：活动限免 Key → 成员模型 Key）。
    const accountName = accountNameOf(identity)
    let key = null
    let keySource = ""
    try {
      const minted = await ensureModelKey(cookie)
      key = minted.key
      keySource = minted.source
    } catch (error) {
      const reason = error instanceof ConsoleError ? error.message : String(error?.message ?? error)
      return {
        ok: false,
        error:
          `登录成功，但没能取得可用的模型 Key：${reason}。` +
          `请在官网「模型 API → API Keys」页确认账号状态后重试，或用「手动配置 API Key」完成接入。`,
      }
    }

    // 推理探针：/models 只验 Key 形态，推理权限要真发一轮才知道
    // （实测：新注册账号 /models 200 但 chat 401 "Authentication Failed"）。
    // 401/403 = 账号没有推理权限，登录判失败并说清原因；
    // 402/429/400 等 = Key 有效、只是该模型额度/参数问题，照常放行（模型可换）。
    const probe = await fetch("https://api.scnet.cn/api/llm/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "SCNet-Max",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
        max_tokens: 16,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    }).catch((error) => ({ status: 0, error }))
    if (probe.status === 401 || probe.status === 403) {
      return {
        ok: false,
        error:
          `登录成功、Key 也铸出来了，但账号 ${accountName || ""} 没有推理权限（HTTP ${probe.status}）。` +
          `常见于刚注册、还没开通模型服务的账号。请改用已能跑模型的账号重新登录` +
          `（比如在「计算服务」客户端里用过的那个），或先在官网完成该账号的模型服务开通/实名后再试。`,
      }
    }

    // 套餐与额度（尽力而为，拿不到不影响登录）。
    let quotaPlan = ""
    let planName = ""
    try {
      const plan = pickPlan(await tokenPlanList(cookie))
      if (plan) {
        quotaPlan = planIdOf(plan.row)
        planName = plan.name
      }
    } catch {}

    return {
      ok: true,
      session: {
        mode: "browser",
        key,
        keySource,
        consoleCookie: cookie,
        quotaPlan,
        planName,
        accountId: accountName || "scnet",
        name: accountName || undefined,
      },
    }
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) }
  } finally {
    // 登录窗口用完即关；若是从一次遗留会话复用的端口，同样关闭。
    await closeBrowser({ port, child })
  }
}
