// Provider 常量与模型目录。
//
// 目录两层（和超算客户端自己的 modelListMode:"automatic" 一致）：
// 内置精选目录兜底（元数据取自客户端 4.1.0 的 models.json），
// 登录后用官方 GET /models（免费、不消耗 Tokens）动态合并覆盖。

export const PROVIDER = "scnet"
export const NAME = "超算互联网 (SCNet)"
export const NPM = "@ai-sdk/openai-compatible"
export const BASE = "https://api.scnet.cn/api/llm/v1"
export const CHAT_URL = "https://api.scnet.cn/api/llm/v1/chat/completions"

// [id, contextWindow, 支持图片输入, 免费标记] —— maxTokens 全系 131072，全部支持工具调用与思考档位。
// 来源：计算服务客户端 4.1.0 内置目录（%USERPROFILE%\.sclaw\agent\models.json）。
// 免费标记：SCNet-Max 目前限免，标 free 后 Magpie 显示「免费」而不是「限制免费」；
// 其他模型套餐外调用会 402，不标免费，需要时在行尾补 true 即可。
const CATALOG = [
  ["SCNet-Max", 1048576, true, true],
  ["DeepSeek-V4.1-Flash-1017", 1048576, true],
  ["DeepSeek-V4.1-Flash", 1048576, true],
  ["DeepSeek-V4-Pro-0813", 1048576, true],
  ["DeepSeek-V4-Flash-0731", 1048576, true],
  ["Kimi-K3.1-Pro", 1048576, true],
  ["Kimi-K3.1-Pro-Highspeed", 1048576, true],
  ["Kimi-K3", 1024000, true],
  ["Kimi-K2.7-Code", 262144, true],
  ["Kimi-K2.6", 262144, true],
  ["Kimi-K2.5", 262144, true],
  ["GLM-5.3", 1048576, true],
  ["GLM-5.3-Flash", 1048576, true],
  ["GLM-5.2", 1048576, false],
  ["GLM-5.2-Base", 131072, true],
  ["GLM-5.1", 206848, false],
  ["GLM-5", 204800, false],
  ["Qwen3.8-Max", 1048576, true],
  ["Qwen3.8-Flash", 1048576, true],
  ["Qwen3.7-Max", 1014784, true],
  ["Qwen3.7-Plus", 1014784, true],
  ["Qwen3.6-Plus", 512000, true],
  ["Qwen3.6-Flash", 1024000, true],
  ["Qwen3.6-27B", 262144, false],
  ["Qwen3.5-122B-A10B", 102400, true],
  ["Qwen3-235B-A22B", 32768, false],
  ["MiniMax-M3.1-Flash", 1048576, true],
  ["MiniMax-M3", 1024000, false],
  ["MiniMax-M2.7", 204800, false],
  ["MiniMax-M2.5", 204800, false],
  ["MiMo-V2.5-Pro", 1024000, false],
  ["Spark-X2.5", 262144, true],
]

function descriptor(id, context, image, free = false) {
  return {
    id,
    name: id,
    reasoning: true,
    tool_call: true,
    modalities: { input: image ? ["text", "image"] : ["text"], output: ["text"] },
    limit: { context, output: 131072 },
    cost: { input: 0, output: 0 },
    ...(free ? { free: true, rate: 0, rateWas: 0 } : {}),
  }
}

export function builtinModels() {
  return Object.fromEntries(CATALOG.map(([id, context, image, free]) => [id, descriptor(id, context, image, free)]))
}

// 内置目录（config 注入与动态发现失败时的兜底）由上方 builtinModels 导出。

function minimal(id) {
  return descriptor(id, 0, false)
}

// 动态 id 列表合并进已有目录：认识的保留元数据，不认识的给最小描述。
export function mergeModels(ids, base) {
  const merged = {}
  for (const raw of ids) {
    const id = String(raw ?? "").trim()
    if (!id) continue
    merged[id] = base?.[id] ?? builtinModels()[id] ?? minimal(id)
  }
  return Object.keys(merged).length ? merged : base
}

// 官方模型列表（免费）；key 无效时抛 Error（message 含 HTTP 状态）。
export async function fetchModelIds(key) {
  let response
  try {
    response = await fetch(`${BASE}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    throw new Error(`模型列表请求失败：${error?.message ?? error}`)
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("API Key 无效或已失效（HTTP 401），请重新认证。")
  }
  if (!response.ok) {
    throw new Error(`模型列表请求失败（HTTP ${response.status}）。`)
  }
  const payload = await response.json().catch(() => null)
  const ids = Array.isArray(payload?.data)
    ? payload.data.map((row) => row?.id).filter(Boolean)
    : null
  if (!ids) throw new Error("模型列表响应形状不符合预期。")
  return ids
}
