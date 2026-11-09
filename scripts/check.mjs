// 离线契约自检（不联网、不读真实凭据内容）。node scripts/check.mjs
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const checks = []
const check = (name, fn) => checks.push([name, fn])

// 1) 模块可加载 + server() 形状
check("server() 契约形状", async () => {
  const { server, parseSession } = await import("../index.mjs")
  assert.equal(typeof server, "function")
  const plugin = await server({}, {})
  assert.equal(typeof plugin.config, "function")
  assert.equal(plugin.auth?.provider, "scnet")
  assert.equal(plugin.auth.methods.length, 3, "三种登录方式")
  assert.equal(plugin.auth.methods[0].type, "oauth")
  assert.equal(plugin.auth.methods[1].type, "oauth")
  assert.equal(plugin.auth.methods[2].type, "api")
  assert.equal(typeof plugin.auth.usage, "function")
  assert.equal(typeof plugin.auth.loader, "function")
  assert.equal(plugin.provider?.id, "scnet")
  assert.equal(typeof plugin.provider?.models, "function")

  // config 注入
  const config = {}
  plugin.config(config)
  const provider = config.provider?.scnet
  assert.equal(provider?.api, "https://api.scnet.cn/api/llm/v1")
  assert.ok(provider?.models?.["SCNet-Max"], "内置目录含 SCNet-Max")

  // parseSession 三形态
  assert.deepEqual(parseSession({ type: "api", access: "sk-abcdef123456" }), { mode: "key", key: "sk-abcdef123456" })
  assert.deepEqual(parseSession({ type: "oauth", access: JSON.stringify({ mode: "desktop", key: "k" }) }), { mode: "desktop", key: "k" })
  assert.equal(parseSession({ type: "oauth", access: "not-json" }), null)
  assert.equal(parseSession(null), null)
})

// 2) loader 端点白名单
check("loader 只放行官方 chat/completions", async () => {
  const { server } = await import("../index.mjs")
  const plugin = await server({}, {})
  const loader = await plugin.auth.loader(async () => ({ type: "api", access: "sk-testtesttest" }))
  assert.equal(loader.baseURL, "https://api.scnet.cn/api/llm/v1")
  const evil = new Request("https://evil.example.com/api/llm/v1/chat/completions", { method: "POST", body: "{}" })
  await assert.rejects(() => loader.fetch(evil), /只放行/)
  const wrongPath = new Request("https://api.scnet.cn/api/other", { method: "POST", body: "{}" })
  await assert.rejects(() => loader.fetch(wrongPath), /只放行/)
})

// 3) 模型目录合并
check("模型目录：内置 + 动态合并", async () => {
  const { builtinModels, mergeModels } = await import("../models.mjs")
  const builtin = builtinModels()
  assert.ok(builtin["SCNet-Max"].limit.context > 0)
  assert.deepEqual(builtin["DeepSeek-V4.1-Flash-1017"].modalities.input, ["text", "image"])
  const merged = mergeModels(["SCNet-Max", "Brand-New-Model"], builtin)
  assert.equal(merged["SCNet-Max"].limit.context, builtin["SCNet-Max"].limit.context)
  assert.equal(merged["Brand-New-Model"].id, "Brand-New-Model")
})

// 4) 桌面凭据：临时假 HOME 下 graceful 失败；假凭据文件能被读出
check("桌面凭据读取（临时目录）", async () => {
  const { readDesktopCredential, readKeyFromFile, extractApiKey } = await import("../desktop-credentials.mjs")
  const fakeHome = mkdtempSync(join(tmpdir(), "scnet-auth-check-"))
  const prev = process.env.USERPROFILE
  process.env.USERPROFILE = fakeHome
  try {
    const missing = readDesktopCredential()
    assert.equal(missing.ok, false)
    assert.ok(missing.error.includes("scnet-credentials"))
    const dir = join(fakeHome, ".sclaw", "agent", "scnet-credentials")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "acc.json"), JSON.stringify({ scnet: { type: "api_key", key: "sk-abc123456789" } }))
    const found = readDesktopCredential()
    assert.equal(found.ok, true)
    assert.equal(found.key, "sk-abc123456789")
    assert.equal(readKeyFromFile(found.file), "sk-abc123456789")
    assert.equal(extractApiKey({ deep: { nested: { type: "api_key", key: "sk-xyz987654321" } } }), "sk-xyz987654321")
    assert.equal(extractApiKey("nope"), null)
  } finally {
    if (prev === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = prev
    rmSync(fakeHome, { recursive: true, force: true })
  }
})

// 5) Cookie 校验规则
check("控制台 Cookie 校验", async () => {
  const { validateCookie, parseCnDate, pickPlan } = await import("../console.mjs")
  assert.throws(() => validateCookie(""), /为空/)
  assert.throws(() => validateCookie("abc"), /name=value/)
  assert.throws(() => validateCookie("a=b\nc=d"), /换行/)
  assert.equal(validateCookie(" sessionid=x "), "sessionid=x")
  assert.equal(parseCnDate("2026-11-07 18:00:00"), new Date("2026-11-07T18:00:00+08:00").toISOString())
  assert.equal(parseCnDate("2026-11-07"), new Date("2026-11-07T00:00:00+08:00").toISOString())
  const view = pickPlan([
    { resourceAccountId: "p2", status: "enable", totalAmount: 100, usedAmount: 40, expireTime: "2027-01-01 00:00:00", name: "B" },
    { resourceAccountId: "p1", status: "enable", totalAmount: 200, usedAmount: 10, expireTime: "2026-12-01 00:00:00", name: "A" },
  ])
  assert.equal(view.row.name, "A", "优先剩余多者")
})

// 6) 每个登录方法的 authorize 形状（不真正执行浏览器流程）
check("authorize 形状", async () => {
  const { server } = await import("../index.mjs")
  const plugin = await server({}, {})
  for (const method of plugin.auth.methods.slice(0, 2)) {
    const flow = method.authorize()
    assert.equal(flow.method, "auto")
    assert.equal(typeof flow.instructions, "string")
    assert.equal(typeof flow.callback, "function")
  }
})

// 7) usage 分支（离线：无套餐/无 Cookie 都给引导文案，不抛异常、不登出）
check("usage 分支文案", async () => {
  const { server } = await import("../index.mjs")
  const plugin = await server({}, {})
  const usage = plugin.auth.usage
  const signIn = (r) => r.signIn

  // 桌面端（无控制台会话）
  const desktop = await usage(async () => ({ type: "oauth", access: JSON.stringify({ mode: "desktop", key: "sk-abc123456789" }) }))
  assert.equal(signIn(desktop), "kept")
  assert.ok(desktop.error.includes("未连接账号额度"), desktop.error)

  // 浏览器登录但登录时没查到套餐（quota: none）——不应打接口，直接给引导
  const browserNoPlan = await usage(async () => ({
    type: "oauth",
    access: JSON.stringify({ mode: "browser", key: "sk-abc123456789", consoleCookie: "a=b", quotaPlan: "" }),
    metadata: { quota: "none" },
  }))
  assert.equal(signIn(browserNoPlan), "kept")
  assert.ok(browserNoPlan.error.includes("没有 Token Plan 套餐记录"), browserNoPlan.error)

  // 手动 Key
  const manual = await usage(async () => ({ type: "api", access: "sk-abc123456789" }))
  assert.equal(signIn(manual), "kept")
  assert.ok(manual.error.includes("未连接账号额度"), manual.error)

  // 有套餐记录的形状（合成行，验证 planUsageView 数学）
  const withPlan = await usage(async () => ({
    type: "oauth",
    access: JSON.stringify({ mode: "browser", key: "sk-abc123456789", consoleCookie: "a=b", quotaPlan: "p1" }),
    metadata: { quota: "console", consoleCookie: "a=b", quotaPlan: "p1" },
  })).catch((e) => ({ error: String(e) }))
  // 无网络环境下 tokenplan/list 会失败——只要求不登出、错误信息是中文
  assert.equal(signIn(withPlan), "kept")
})

// 8) 活动限免 Key 的提取（会话回归，2026-11-09）：
//    真实返回 {"apiKey":"sk-NTcz…=","baseUrl":…,"model":…}，Key 是 base64 形态（可含 + / = 结尾）；
//    旧字段白名单不验形状，掩码 Key（sk-N****MzY=）会被当可用 Key 放行，后续推理 401 误报「没有推理权限」。
//    另注：当天首次登录失败（service credential is unavailable）的真实原因是新账号开通延迟
//    —— createActivityApiKey 返回成功但无 Key，与解析无关（已改为轮询重试，见 console.mjs）。
check("活动限免 Key 提取（回归）", async () => {
  const { extractKeyField } = await import("../console.mjs")
  const real = "sk-NTczLTExOTE4NjMxOTMzLTE3OTQxODk2NDgyMzY="
  assert.equal(extractKeyField({ apiKey: real, baseUrl: "https://api.scnet.cn/api/llm/v1", model: "MiniMax-M2.5" }), real)
  assert.equal(extractKeyField({ apiKey: "sk-abc+def/ghi=" }), "sk-abc+def/ghi=", "base64 里的 + / = 也要收")
  assert.equal(extractKeyField({ data: { credentials: { value: "sk-Zm9vYmFyYmF6" } } }), "sk-Zm9vYmFyYmF6", "任意嵌套字段也要找")
  assert.equal(extractKeyField({ apiKey: "sk-N****MzY=" }), null, "掩码 Key 不可用")
  assert.equal(extractKeyField({ apiKey: "" }), null)
  assert.equal(extractKeyField({ model: "MiniMax-M2.5", baseUrl: "https://api.scnet.cn" }), null, "非 Key 字符串不能误判")
})

let failed = 0
for (const [name, fn] of checks) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  ✗ ${name}\n    ${error?.stack ?? error}`)
  }
}
console.log(failed === 0 ? `\n全部 ${checks.length} 项通过` : `\n${failed}/${checks.length} 项失败`)
process.exit(failed === 0 ? 0 : 1)
