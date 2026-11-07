// 超算控制台（www.scnet.cn/acx）的只读客户端。
//
// 接口是控制台内部端点（可能随网站更新变化），全部收敛在本文件：
//   GET  /user/users/current-user-info            账号身份
//   GET  /charge/account/currentuser/tokenplan/list  Token Plan 套餐与 Credits
//   GET  /llm/api-key/token-plan/query            只读已有套餐 Key
//   POST /llm/api-key/mcp/create                  铸 MCP Key（客户端同款，名字 SCNet_Client）
// 鉴权只靠浏览器登录态 Cookie；响应统一是 {code:"0", data}，401/403 表示未登录。

const ACX = "https://www.scnet.cn/acx"

export class ConsoleError extends Error {
  constructor(message, kind = "error", extra = {}) {
    super(message)
    this.name = "ConsoleError"
    this.kind = kind
    Object.assign(this, extra)
  }
}

export function validateCookie(cookie) {
  const value = String(cookie ?? "").trim()
  if (!value) throw new ConsoleError("控制台 Cookie 为空。", "session")
  if (value.length > 16 * 1024) throw new ConsoleError("控制台 Cookie 异常（超过 16KB）。", "session")
  if (/[\r\n]/.test(value)) throw new ConsoleError("控制台 Cookie 含换行，形状不对。", "session")
  if (!/^[^\s=]+=[^\s=]/.test(value)) throw new ConsoleError("控制台 Cookie 应当是 name=value 形态。", "session")
  return value
}

async function consoleRequest(cookie, path, { method = "GET", body } = {}) {
  validateCookie(cookie)
  let response
  try {
    response = await fetch(ACX + path, {
      method,
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        Cookie: cookie,
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    throw new ConsoleError(`超算控制台网络请求失败：${error?.message ?? error}`, "network")
  }
  if (response.status === 401 || response.status === 403) {
    throw new ConsoleError("控制台会话已失效，请重新登录。", "session")
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new ConsoleError(`控制台返回了非 JSON 响应（HTTP ${response.status}），接口可能已变更。`, "shape")
  }
  if (payload && typeof payload === "object" && "code" in payload) {
    const code = String(payload.code)
    if (code === "401" || code === "403") {
      throw new ConsoleError("控制台会话已失效，请重新登录。", "session")
    }
    if (code !== "0") {
      throw new ConsoleError(
        `控制台接口返回错误码 ${code}${payload.message ? `：${payload.message}` : ""}`,
        "provider",
        { providerCode: code },
      )
    }
    return payload.data
  }
  if (!response.ok) {
    throw new ConsoleError(`控制台接口 HTTP ${response.status}。`, "http")
  }
  return payload
}

export async function currentUserInfo(cookie) {
  return consoleRequest(cookie, "/user/users/current-user-info")
}

export async function tokenPlanList(cookie) {
  return consoleRequest(cookie, "/charge/account/currentuser/tokenplan/list")
}

export async function tokenPlanKeys(cookie) {
  return consoleRequest(cookie, "/llm/api-key/token-plan/query")
}

// —— 模型 Key 的铸造（照搬「计算服务」客户端 agent 的完整决策树）——
// 1. 先试活动限免 Key：POST /llm/api-key/createActivityApiKey（空 body）
// 2. 失败且 providerCode === API010010 → 正式成员 Key：
//    GET /user/users/cluster-user-detail 解析 {accountId, groupId, createUser}
//    → POST /llm/api-key/query 分页查同名 Key（keyStatus === "100"）
//    → 有则 GET /llm/api-key/detail 复用（掩码 * 视为不可用）
//    → 无则 POST /llm/api-key/create，serviceTypes ["model"] + accessibleModelScope "ALL"
// 注意：不要用 /llm/api-key/mcp/create——那是 web-search 凭据路径，
// 铸出的 Key 过得了 /models 鉴权但推理 401 "Authentication Failed"。

export async function createActivityKey(cookie) {
  return consoleRequest(cookie, "/llm/api-key/createActivityApiKey", { method: "POST", body: {} })
}

const str = (value) => (typeof value === "string" || typeof value === "number" ? String(value).trim() : "")
const unwrap = (value) => (value && typeof value === "object" ? value : {})
const rowsOf = (value) => (Array.isArray(value) ? value.map(unwrap) : [])

// cluster-user-detail → {accountId, groupId, createUser}，校验口径与客户端一致。
// 注意：个人账号（无团队）返回空数组——成员 Key 路径只对团队账号有意义；
// 个人账号的推理权限由活动限免 Key 提供。
export async function clusterUserContext(cookie) {
  const rows = rowsOf(await consoleRequest(cookie, "/user/users/cluster-user-detail"))
  if (!rows.length) {
    throw new ConsoleError(
      "该账号没有模型服务成员身份（个人账号通常由活动限免 Key 提供推理权限，活动 Key 不可用时请改用手动配置）",
      "provider",
    )
  }
  if (rows.some((row) => str(row.memberType).toLowerCase() !== "member")) {
    throw new ConsoleError("SCNet 用户账户异常，请联系团队管理员", "provider")
  }
  const unique = new Map(rows.map((row) => [str(row.accountId), row]))
  if (unique.size !== 1) {
    throw new ConsoleError("当前账号关联多个团队账户，请联系团队管理员确认服务计费账户", "provider")
  }
  const row = [...unique.values()][0]
  const accountId = str(row.accountId)
  const groupId = str(row.groupId)
  const createUser = str(row.userId)
  const status = str(unwrap(row.accountDetail).status).toLowerCase()
  if (!accountId || !groupId || !createUser || status !== "normal") {
    throw new ConsoleError("团队账户信息不完整或已停用，请联系团队管理员", "provider")
  }
  return { accountId, groupId, createUser }
}

async function queryModelKeys(cookie, context) {
  const keys = []
  for (let page = 1; ; page += 1) {
    const data = unwrap(await consoleRequest(cookie, "/llm/api-key/query", {
      method: "POST",
      body: { createUser: context.createUser, accountId: context.accountId, groupId: context.groupId, serviceType: "model", page, size: 100 },
    }))
    const records = Array.isArray(data) ? data.map(unwrap) : rowsOf(data.records)
    keys.push(...records)
    if (Array.isArray(data) || page >= Number(data.pages || 1)) break
    if (page >= 100) throw new ConsoleError("API Key 列表过长，请在平台清理后重试", "provider")
  }
  return keys
}

// 确保拿到一把有推理权限的模型 Key；返回 {key, source}。失败抛 ConsoleError（中文）。
export async function ensureModelKey(cookie) {
  try {
    const key = extractKeyField(await createActivityKey(cookie))
    if (key) return { key, source: "createActivityApiKey" }
    throw new ConsoleError("SCNet service credential is unavailable", "shape")
  } catch (error) {
    if (!(error instanceof ConsoleError && error.providerCode === "API010010")) throw error
  }

  const context = await clusterUserContext(cookie)
  const keyName = `scnet-client-member-${context.createUser}`
  const keys = await queryModelKeys(cookie, context)
  const mine = keys.find(
    (row) =>
      str(row.apiKeyName) === keyName &&
      str(row.accountId) === context.accountId &&
      str(row.createUser) === context.createUser &&
      str(row.keyStatus) === "100" &&
      row.id,
  )
  if (mine) {
    const detail = unwrap(await consoleRequest(cookie, `/llm/api-key/detail?id=${encodeURIComponent(str(mine.id))}`))
    if (str(detail.accountId) !== context.accountId || str(detail.createUser) !== context.createUser || str(detail.keyStatus) !== "100") {
      throw new ConsoleError("客户端 API Key 归属或状态已变更，请重新登录后重试", "provider")
    }
    const key = extractKeyField(detail)
    if (!key || key.includes("*")) {
      throw new ConsoleError("SCNet service credential is unavailable（Key 被掩码，请在平台重置后重试）", "shape")
    }
    return { key, source: "api-key/detail" }
  }
  if (keys.some((row) => str(row.apiKeyName) === keyName && str(row.accountId) === context.accountId)) {
    throw new ConsoleError("同名 Key 已失效或受限，请在平台检查该 Key 的状态后重试", "provider")
  }
  const created = unwrap(await consoleRequest(cookie, "/llm/api-key/create", {
    method: "POST",
    body: {
      createUser: context.createUser,
      apiKeyName: keyName,
      serviceTypes: ["model"],
      accessibleModelScope: "ALL",
      groupId: context.groupId,
      accountId: context.accountId,
    },
  }))
  const key = extractKeyField(created)
  if (!key) throw new ConsoleError("SCNet service credential is unavailable", "shape")
  return { key, source: "api-key/create" }
}

// 从控制台响应里递归找 key 形态的字段（apiKey/apikey/key/secret/token）。
export function extractKeyField(value, depth = 0) {
  if (depth > 6) return null
  if (typeof value === "string") {
    const trimmed = value.trim()
    return /^(sk-|sc-)[A-Za-z0-9_=-]{8,}$/.test(trimmed) ? trimmed : null
  }
  if (!value || typeof value !== "object") return null
  for (const name of ["apiKey", "apikey", "key", "secret", "token"]) {
    if (typeof value[name] === "string" && value[name].trim()) return value[name].trim()
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractKeyField(item, depth + 1)
      if (found) return found
    }
    return null
  }
  for (const child of Object.values(value)) {
    const found = extractKeyField(child, depth + 1)
    if (found) return found
  }
  return null
}

// 控制台返回的 "YYYY-MM-DD HH:MM:SS" 视为中国标准时间。
export function parseCnDate(raw) {
  if (!raw || typeof raw !== "string") return undefined
  const trimmed = raw.trim()
  if (!/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(trimmed)) {
    const parsed = new Date(trimmed)
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
  }
  const withZone = trimmed.replace(" ", "T") + (trimmed.length === 10 ? "T00:00:00" : "") + "+08:00"
  const parsed = new Date(withZone)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

function firstFinite(row, names) {
  for (const name of names) {
    const value = Number(row?.[name])
    if (Number.isFinite(value) && value >= 0) return value
  }
  return undefined
}

export function planIdOf(row) {
  return String(row?.resourceAccountId ?? "")
}

// 从套餐列表里挑一个可用套餐：优先有余额的，再选最先到期的。
export function pickPlan(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row && typeof row === "object")
  const usable = list.filter((row) => {
    if (row.status && row.status !== "enable") return false
    const until = parseCnDate(row.maxExpireTime || row.expireTime || row.endTime)
    if (until && new Date(until).getTime() <= Date.now()) return false
    return true
  })
  const pool = usable.length ? usable : list
  const scored = pool.map((row) => {
    const total = firstFinite(row, ["totalAmount", "All", "planCredits", "monthlyCredits", "totalCredits"])
    const used = firstFinite(row, ["usedAmount", "used", "usedCredits", "consumeCredits", "consumedCredits", "consume", "usage"])
    const until = parseCnDate(row.maxExpireTime || row.expireTime || row.endTime)
    const remaining = Number.isFinite(total) && Number.isFinite(used) ? Math.max(0, total - used) : Number.NaN
    return { row, total, used, until, remaining, name: row?.name || row?.resourceName || row?.packageName || "Token Plan" }
  })
  scored.sort((a, b) => {
    const ra = Number.isFinite(a.remaining) ? a.remaining : -1
    const rb = Number.isFinite(b.remaining) ? b.remaining : -1
    if (ra !== rb) return rb - ra
    const ta = a.until ? new Date(a.until).getTime() : Number.POSITIVE_INFINITY
    const tb = b.until ? new Date(b.until).getTime() : Number.POSITIVE_INFINITY
    return ta - tb
  })
  return scored[0] ?? null
}

const format = (value) => Number(value).toLocaleString("en-US", { maximumFractionDigits: 6 })

// usage 钩子的套餐展示（形状对齐社区 scnet-auth，已验证 Magpie 可显示）。
export function planUsageView(row) {
  const view = pickPlan([row])
  if (!view) throw new ConsoleError("套餐数据为空。", "shape")
  const { total, used, until, name } = view
  if (!Number.isFinite(total) || !Number.isFinite(used)) {
    throw new ConsoleError("套餐额度字段无法解析（接口形状可能已变更）。", "shape")
  }
  const remaining = Math.max(0, total - used)
  const resetsAt = parseCnDate(row?.resetTime || row?.resetAt || row?.nextResetTime || row?.monthResetTime)
  return {
    plan: name,
    until,
    balance: `${format(remaining)} Credits`,
    windows: [
      {
        name: "套餐 Credits",
        used: total > 0 ? (used / total) * 100 : 0,
        amount: used,
        limit: total,
        unit: "Credits",
        display: `已用 ${format(used)} / ${format(total)} · 剩余 ${format(remaining)} Credits`,
        ...(resetsAt ? { resetsAt } : {}),
      },
    ],
  }
}
