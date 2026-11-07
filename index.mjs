// 超算互联网（SCNet）的 Magpie provider 插件。
//
// WorkBuddy/Qoder 流派：多种登录方式逐级兜底，认证完成后模型直接可用——
//   1. 读取超算客户端登录（计算服务桌面端凭据文件，WorkBuddy desktop 方式；主路径）
//   2. 浏览器登录超算互联网（受控窗口 + 自动铸 Key，客户端未装/未登录时）
//   3. 手动配置 API Key（最终兜底）
// 请求一律 Bearer 直连官方 OpenAI 兼容网关 https://api.scnet.cn/api/llm/v1，
// 无签名、无协议改写；Magpie 负责 OpenAI / Anthropic 协议转换。

import {
  BASE,
  CHAT_URL,
  NAME,
  NPM,
  PROVIDER,
  builtinModels,
  fetchModelIds,
  mergeModels,
} from "./models.mjs"
import { readClientAccount, readDesktopCredential, readKeyFromFile } from "./desktop-credentials.mjs"
import { planUsageView, tokenPlanList } from "./console.mjs"
import { DEFAULT_PORT, runBrowserLogin } from "./browser-login.mjs"

const SESSION_DAYS = 365
const USAGE_CACHE_MS = 60_000
let usageCache = { key: "", at: 0, result: null }

// auth.access 三种形态：桌面端/浏览器登录是 JSON 会话；手动 Key 方式是裸 sk- 字符串。
export function parseSession(auth) {
  if (!auth) return null
  const access = auth.access
  if (typeof access === "string") {
    const trimmed = access.trim()
    if (trimmed.startsWith("sk-")) return { mode: "key", key: trimmed }
    try {
      const parsed = JSON.parse(access)
      if (parsed?.mode) return parsed
    } catch {}
  }
  return null
}

function authError(message, expired = true) {
  const error = new Error(message)
  if (expired) error.signIn = "expired"
  return error
}

// 每次请求都拿最新 Key：桌面端优先重读凭据文件（跟随客户端重铸），失败回退登录时快照。
export async function resolveKey(getAuth) {
  const auth = await getAuth()
  const session = parseSession(auth)
  if (!session) throw authError("超算互联网还没有登录，请先完成认证。")
  if (session.mode === "desktop") {
    const fresh = readKeyFromFile(session.keyFile)
    if (fresh) return fresh
    if (session.key) return session.key
    throw authError("超算客户端的凭据文件已不存在（客户端可能重置过），请重新认证。")
  }
  if (session.key) return session.key
  throw authError("登录态里没有可用的 API Key，请重新认证。")
}

function desktopMethod(settings) {
  return {
    type: "oauth",
    label: "读取超算客户端登录（计算服务桌面端）",
    authorize() {
      return {
        instructions:
          "插件会读取本机「计算服务」客户端的模型凭据文件（只读，不复制）：" +
          "%USERPROFILE%\\.sclaw\\agent\\scnet-credentials\\*.json。" +
          "前提是客户端登录过且跑过至少一次对话（首次对话时客户端自动铸造凭据）。" +
          "此后插件每次请求都会重读该文件，客户端重铸 Key 也自动跟上。",
        method: "auto",
        async callback() {
          const credential = readDesktopCredential()
          const account = readClientAccount()
          if (!credential.ok) {
            const suffix = account.ok
              ? `已检测到客户端账号 ${account.userName}，但还没有模型凭据——在客户端里随便发起一次对话后再试。`
              : "未检测到客户端数据目录；若尚未安装客户端，可改用「浏览器登录超算互联网」或「手动配置 API Key」。"
            return { type: "failed", error: `${credential.error} ${suffix}` }
          }

          const session = {
            mode: "desktop",
            key: credential.key,
            keyFile: credential.file,
            keyPreview: credential.key.slice(0, 7),
            accountId: account.ok ? account.userName : "scnet",
          }
          let modelIds = null
          try {
            modelIds = await fetchModelIds(credential.key)
          } catch (error) {
            const message = String(error?.message ?? error)
            if (/401|已失效/.test(message)) {
              return { type: "failed", error: `客户端凭据验证未通过：${message}` }
            }
            // 网络抖动不拦登录；请求时自然暴露。
          }

          return {
            type: "success",
            access: JSON.stringify({ ...session, ...(modelIds ? { modelIds } : {}) }),
            refresh: "",
            expires: Date.now() + SESSION_DAYS * 24 * 3600 * 1000,
            accountId: session.accountId,
            name: account.ok ? account.userName : undefined,
            metadata: { source: "scnet-client", keyFile: credential.file, quota: "none" },
          }
        },
      }
    },
  }
}

function browserMethod(settings) {
  return {
    type: "oauth",
    label: "浏览器登录超算互联网（官网）",
    authorize() {
      return {
        instructions:
          "插件会打开一个专用浏览器窗口（与日常浏览器隔离）进入超算官网登录页，" +
          "用账号密码、短信或扫码登录均可；登录完成后自动读取会话并铸取模型 Key，随后窗口自动关闭。" +
          "官网已登录过的浏览器会话可复用，通常几秒到半分钟完成。",
        method: "auto",
        async callback() {
          const result = await runBrowserLogin({
            port: settings.port,
            timeoutMs: settings.loginTimeoutMs,
          })
          if (!result.ok) return { type: "failed", error: result.error }
          const { session } = result
          return {
            type: "success",
            access: JSON.stringify(session),
            refresh: "",
            expires: Date.now() + SESSION_DAYS * 24 * 3600 * 1000,
            accountId: session.accountId,
            name: session.name,
            metadata: {
              source: "browser-login",
              quota: session.quotaPlan ? "console" : "none",
              consoleCookie: session.consoleCookie,
              quotaPlan: session.quotaPlan,
              email: session.name ? `超算互联网 · ${session.name}` : "超算互联网",
            },
          }
        },
      }
    },
  }
}

function keyMethod() {
  return {
    type: "api",
    label: "手动配置 API Key",
    placeholder: "sk-…（官网「模型 API → API Keys」创建的 Key）",
  }
}

export const server = async (_input, options = {}) => {
  const settings = {
    port: DEFAULT_PORT,
    loginTimeoutMs: 300_000,
    ...(options ?? {}),
  }

  return {
    config(config) {
      config.provider ??= {}
      config.provider[PROVIDER] ??= {
        name: NAME,
        npm: NPM,
        api: BASE,
        models: builtinModels(),
      }
    },

    auth: {
      provider: PROVIDER,
      methods: [desktopMethod(settings), browserMethod(settings), keyMethod()],

      // 额度展示：仅当账号在登录时连上了套餐（quota === "console"）才查询；
      // 没套餐/没 Cookie 都给明确的引导文案。查询失败只降级显示，
      // 永不让有效的推理 Key 被登出（signIn 恒为 "kept"）。
      // 结果按会话缓存 60s——控制台接口不是为高频轮询设计的，礼貌一点。
      async usage(getAuth) {
        const auth = await getAuth().catch(() => null)
        const session = parseSession(auth)
        const metadata = auth?.metadata ?? {}
        const cookie = session?.consoleCookie ?? metadata.consoleCookie
        const quotaPlan = session?.quotaPlan ?? metadata.quotaPlan
        const base = { user: session?.accountId ?? metadata.email ?? "", signIn: "kept" }
        const connected = Boolean(quotaPlan) || metadata.quota === "console"

        if (!cookie || !connected) {
          return {
            ...base,
            error: session?.mode === "browser" && cookie
              ? "该账号当前没有 Token Plan 套餐记录 · 购买套餐后重新登录即可显示 Credits"
              : "未连接账号额度 · 用「浏览器登录」接入后显示 Credits",
          }
        }

        const cacheKey = `${base.user}|${quotaPlan}`
        if (usageCache.result && usageCache.key === cacheKey && Date.now() - usageCache.at < USAGE_CACHE_MS) {
          return usageCache.result
        }

        try {
          const rows = await tokenPlanList(cookie)
          const list = Array.isArray(rows) ? rows : []
          if (!list.length) {
            return { ...base, error: "该账号当前没有 Token Plan 套餐记录 · 购买套餐后重新登录即可显示 Credits" }
          }
          const row = quotaPlan
            ? list.find((item) => String(item?.resourceAccountId ?? "") === String(quotaPlan))
            : null
          if (quotaPlan && !row) {
            return { ...base, error: "所选套餐不在当前账号的套餐列表里（可能已更换套餐），请重新登录。" }
          }
          const view = planUsageView(row ?? list[0])
          const result = { ...base, ...view }
          usageCache = { key: cacheKey, at: Date.now(), result }
          return result
        } catch (error) {
          return { ...base, error: error?.message ?? String(error) }
        }
      },

      async loader(getAuth) {
        return {
          baseURL: BASE,
          apiKey: "scnet-plugin",
          async fetch(input, init) {
            const request = input instanceof Request ? input : new Request(input, init)
            const url = new URL(request.url)
            if (url.origin !== "https://api.scnet.cn" || url.pathname !== "/api/llm/v1/chat/completions") {
              throw new Error(`scnet 插件只放行 ${CHAT_URL}，收到：${url.href}`)
            }
            request.signal?.throwIfAborted?.()

            const key = await resolveKey(getAuth)
            const headers = new Headers(request.headers)
            for (const name of ["authorization", "x-api-key", "x-goog-api-key", "cookie", "proxy-authorization"]) {
              headers.delete(name)
            }
            headers.set("authorization", `Bearer ${key}`)
            headers.set("content-type", "application/json")

            const body = request.body == null ? undefined : await request.text()
            return fetch(new Request(url.href, { method: request.method, headers, body, signal: request.signal }), {
              redirect: "error",
            })
          },
        }
      },
    },

    provider: {
      id: PROVIDER,
      // 动态模型目录：官方 GET /models（免费）为主，插件内置目录补元数据（含 free 标记）。
      // 注意基底必须用自己的 builtinModels()——钩子入参 provider.models 是 magpie 已归一化的
      // 列表，自定义字段（free/rate）在那里已被剥掉。
      async models(provider, { auth } = {}) {
        try {
          const session = parseSession(auth)
          const fresh = session?.keyFile ? readKeyFromFile(session.keyFile) : null
          const key = fresh ?? session?.key
          if (!key) return builtinModels()
          const ids = await fetchModelIds(key)
          return mergeModels(ids, builtinModels())
        } catch {
          return builtinModels()
        }
      },
    },
  }
}

export { builtinModels }
export default { id: PROVIDER, server }
