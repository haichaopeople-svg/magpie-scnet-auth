// 控制台接口勘察（排查接口变更时用）。
//   node scripts/probe-console.mjs "<Cookie 整串>"
//   node scripts/probe-console.mjs "<Cookie>" --mint      # 追加：跑一遍铸 Key 决策树
// 只打印形状与打码后的值，不打印完整 Key/Cookie。
import {
  ConsoleError,
  currentUserInfo,
  ensureModelKey,
  extractKeyField,
  pickPlan,
  tokenPlanKeys,
  tokenPlanList,
} from "../console.mjs"

const cookie = process.argv[2] ?? process.env.SCNET_CONSOLE_COOKIE ?? ""
const doMint = process.argv.includes("--mint")
if (!cookie) {
  console.error('用法: node scripts/probe-console.mjs "<Cookie 整串>" [--mint]')
  console.error("Cookie 获取: 登录 www.scnet.cn → F12 → Network → 刷新 → 任一 acx 请求的 Request Headers → Cookie")
  process.exit(1)
}

const mask = (value) => (typeof value === "string" ? value.slice(0, 6) + "…" : value)
const show = (label, fn) => {
  console.log(`\n=== ${label} ===`)
  try {
    const data = fn()
    if (data instanceof Promise) {
      return data.then((d) => console.log(JSON.stringify(d, (k, v) => (typeof v === "string" && /key|token|cookie/i.test(k) ? mask(v) : v), 1).slice(0, 2000)))
    }
    console.log(JSON.stringify(data, (k, v) => (typeof v === "string" && /key|token|cookie/i.test(k) ? mask(v) : v), 1).slice(0, 2000))
  } catch (error) {
    if (error instanceof ConsoleError) console.log(`✗ [${error.kind}]${error.providerCode ? ` code=${error.providerCode}` : ""} ${error.message}`)
    else console.log("✗ " + (error?.message ?? error))
  }
  return Promise.resolve()
}

await show("GET /user/users/current-user-info", () => currentUserInfo(cookie))
await show("GET /charge/account/currentuser/tokenplan/list", async () => {
  const rows = await tokenPlanList(cookie)
  const plan = pickPlan(rows)
  return { rows: Array.isArray(rows) ? rows.length : typeof rows, picked: plan ? { name: plan.name, id: planIdMask(plan.row), total: plan.total, used: plan.used, until: plan.until } : null }
})
function planIdMask(row) { return String(row?.resourceAccountId ?? "").slice(0, 4) + "…" }
await show("GET /llm/api-key/token-plan/query", async () => {
  const data = await tokenPlanKeys(cookie)
  return { shape: Array.isArray(data) ? `array(${data.length})` : typeof data, keyFound: Boolean(extractKeyField(data)) }
})
if (doMint) {
  await show("铸 Key 决策树（活动 Key → 成员 Key）", async () => {
    const { key, source } = await ensureModelKey(cookie)
    return { source, keyPreview: key.slice(0, 8) + "…", keyLength: key.length }
  })
}
console.log("\n勘察完成。")
