// 超算客户端（计算服务）的桌面端凭据读取。
//
// WorkBuddy "desktop's sign-in" 方式的 SCNet 版：客户端的 agent 第一次跑模型时，
// 会把它铸造的 API Key（控制台侧名字叫 SCNet_Client）明文写进
//   %USERPROFILE%\.sclaw\agent\scnet-credentials\<账号指纹>.json
// 形如 {"scnet":{"type":"api_key","key":"sk-…"}}。
// 本模块只做只读；不复制语义留给调用方（loader 每次请求重读文件，
// 客户端日后重铸 Key 自动跟上）。

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

// 凭据目录候选：新布局在前，旧布局候选兜底，环境变量最高。
export function credentialDirs() {
  const home = process.env.USERPROFILE || process.env.HOME || ""
  const dirs = []
  if (process.env.SCNET_CREDENTIALS_DIR) dirs.push(process.env.SCNET_CREDENTIALS_DIR)
  if (home) {
    dirs.push(join(home, ".sclaw", "agent", "scnet-credentials"))
    dirs.push(join(home, ".sclaw", "scnet-credentials"))
  }
  return dirs
}

// 从凭据 JSON 里递归找出 api_key 形态的 key。
export function extractApiKey(value) {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return /^sk-[A-Za-z0-9_-]{8,}$/.test(trimmed) ? trimmed : null
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  if (value.type === "api_key" && typeof value.key === "string" && value.key.trim()) {
    return value.key.trim()
  }
  for (const child of Object.values(value)) {
    const found = extractApiKey(child)
    if (found) return found
  }
  return null
}

function listCredentialFiles(dir) {
  const files = []
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    const file = join(dir, entry.name)
    try {
      const key = extractApiKey(JSON.parse(readFileSync(file, "utf8")))
      if (key) files.push({ key, file, mtime: statSync(file).mtimeMs })
    } catch {}
  }
  return files
}

// 扫所有候选目录，取最近更新的那份凭据。
export function readDesktopCredential() {
  for (const dir of credentialDirs()) {
    const candidates = listCredentialFiles(dir)
    candidates.sort((a, b) => b.mtime - a.mtime)
    if (candidates.length) {
      return { ok: true, ...candidates[0], total: candidates.length }
    }
  }
  return {
    ok: false,
    error:
      "没有找到超算客户端的模型凭据（%USERPROFILE%\\.sclaw\\agent\\scnet-credentials\\*.json）。" +
      "请先在「计算服务」客户端里随便发起一次对话（客户端会自动铸造凭据），再重新登录；" +
      "或改用「浏览器登录超算互联网」/「手动配置 API Key」。",
  }
}

// loader 每次请求重读凭据文件；文件没了返回 null（调用方决定降级策略）。
export function readKeyFromFile(file) {
  if (!file) return null
  try {
    return extractApiKey(JSON.parse(readFileSync(file, "utf8")))
  } catch {
    return null
  }
}

// 客户端配置里的账号名（展示用，读不到不影响登录）。
export function readClientAccount() {
  const appData = process.env.APPDATA || (process.env.USERPROFILE ? join(process.env.USERPROFILE, "AppData", "Roaming") : "")
  if (!appData) return { ok: false }
  try {
    const config = JSON.parse(readFileSync(join(appData, "scnet-client", "config.json"), "utf8"))
    const userName = String(config?.userInfo?.userName ?? "").trim()
    if (userName) return { ok: true, userName }
    return { ok: false }
  } catch {
    return { ok: false }
  }
}

// 客户端是否安装（引导文案用）。
export function clientInstalled() {
  const appData = process.env.APPDATA || (process.env.USERPROFILE ? join(process.env.USERPROFILE, "AppData", "Roaming") : "")
  return Boolean(appData && (() => { try { statSync(join(appData, "scnet-client")); return true } catch { return false } })())
}
