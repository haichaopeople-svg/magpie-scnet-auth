// 半端到端：用本机超算客户端的真实凭据跑通 官方 API（需要网络）。
// 只打印模型数与用量摘要，绝不打印 Key。node scripts/test-desktop.mjs
import { readDesktopCredential, readClientAccount } from "../desktop-credentials.mjs"
import { fetchModelIds, BASE } from "../models.mjs"

const key = () => {
  const credential = readDesktopCredential()
  if (!credential.ok) {
    console.error("✗ " + credential.error)
    process.exit(1)
  }
  return credential
}

const credential = key()
const account = readClientAccount()
console.log(`凭据文件: ${credential.file}${credential.total > 1 ? `（共 ${credential.total} 份，取最新）` : ""}`)
console.log(`账号: ${account.ok ? account.userName : "(未能读取，跳过)"}`)

console.log("\n[1/3] GET /models（免费）")
let modelIds
try {
  modelIds = await fetchModelIds(credential.key)
  console.log(`  ✓ HTTP 200，${modelIds.length} 个模型`)
  console.log(`  示例: ${modelIds.slice(0, 8).join(", ")}${modelIds.length > 8 ? " …" : ""}`)
} catch (error) {
  console.error("  ✗ " + (error?.message ?? error))
  process.exit(1)
}

console.log("\n[2/3] POST /chat/completions（非流式，max_tokens=512，思考型模型需要余量）")
const chat = await fetch(`${BASE}/chat/completions`, {
  method: "POST",
  headers: { Authorization: `Bearer ${credential.key}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: modelIds.includes("SCNet-Max") ? "SCNet-Max" : modelIds[0],
    messages: [{ role: "user", content: "只回复两个字：成功" }],
    stream: false,
    max_tokens: 512,
  }),
  signal: AbortSignal.timeout(120_000),
}).then((r) => r.json())

if (chat?.choices?.[0]?.message) {
  console.log(`  ✓ 回复: ${JSON.stringify(chat.choices[0].message.content)}`)
  console.log(`  model=${chat.model} usage=${JSON.stringify(chat.usage)}`)
} else {
  console.error("  ✗ " + JSON.stringify(chat).slice(0, 400))
  process.exit(1)
}

console.log("\n[3/3] 流式（SSE，SCNet-Max；注意 /models 是平台目录，未含在套餐里的模型会 402）")
const stream = await fetch(`${BASE}/chat/completions`, {
  method: "POST",
  headers: { Authorization: `Bearer ${credential.key}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: modelIds.includes("SCNet-Max") ? "SCNet-Max" : modelIds[0],
    messages: [{ role: "user", content: "从1数到5，用顿号分隔，不要其他内容" }],
    stream: true,
    max_tokens: 512,
  }),
  signal: AbortSignal.timeout(120_000),
})
if (!stream.ok) {
  console.error(`  ✗ HTTP ${stream.status}: ${(await stream.text()).slice(0, 200)}`)
  process.exit(1)
}
const reader = stream.body.getReader()
const decoder = new TextDecoder()
let events = 0
let text = ""
let buffer = ""
for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })
  for (const line of buffer.split("\n")) {
    if (!line.startsWith("data:")) continue
    const data = line.slice(5).trim()
    if (!data || data === "[DONE]") continue
    try {
      const chunk = JSON.parse(data)
      events += 1
      text += chunk.choices?.[0]?.delta?.content ?? ""
    } catch {}
  }
  buffer = ""
}
console.log(`  ✓ HTTP ${stream.status}，${events} 个 SSE 事件，正文: ${JSON.stringify(text.slice(0, 60))}`)

console.log("\n端到端通过：桌面端凭据 → 官方 OpenAI 兼容 API（非流式 + 流式）")
