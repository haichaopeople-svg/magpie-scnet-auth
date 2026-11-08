# magpie-scnet-auth

超算互联网（SCNet）的 Magpie provider 插件：**认证一次，模型就能用**。

登录一次之后，所有请求都是官方 OpenAI 兼容 API（`https://api.scnet.cn/api/llm/v1`）上的纯 Bearer 调用——没有签名、没有协议改写、没有需要保持打开的窗口。Magpie 负责 OpenAI / Anthropic 协议转换。

> 本项目与超算互联网 / 曙光智算 / Magpie 官方均无关联，仅供个人学习与自用。使用前请阅读下方「许可与免责声明」。

## 三种登录方式（逐级兜底）

| 方式 | 适用 | 体验 |
|---|---|---|
| **读取超算客户端登录**（推荐） | 装了「计算服务」客户端并登录过 | 秒级完成。插件只读客户端的模型凭据文件，之后每次请求都重读该文件——客户端重铸 Key 自动跟上 |
| **浏览器登录超算互联网** | 没装客户端，或客户端还没跑过对话 | 弹出官网登录页，账号密码/短信/扫码均可；登录后自动铸取模型 Key、窗口自动关闭 |
| **手动配置 API Key** | 服务器、无桌面环境 | 粘贴官网「模型 API → API Keys」创建的 `sk-` Key |

### 方式一：读取超算客户端登录

前提：「计算服务」客户端已登录，且**跑过至少一次对话**（客户端首次对话时自动铸造凭据，文件在 `%USERPROFILE%\.sclaw\agent\scnet-credentials\*.json`）。

插件做的事：只读该文件 → 向官方 `/models` 验证 → 完成。**不复制、不改动**；loader 每次请求重读文件，所以：

- 客户端日后重铸 Key → 插件自动跟随，无需重新登录；
- 凭据文件被删（客户端重置）→ 提示重新认证。

没有凭据文件时：先在客户端里随便发起一次对话，再重新登录；或改用方式二/三。

### 方式二：浏览器登录超算互联网

1. 触发登录后，插件弹出一个**专用浏览器窗口**（Edge 优先、Chrome 兜底；与日常浏览器完全隔离，不读写日常浏览器的任何数据）；
2. 在窗口里登录 scnet.cn（官网登录页，密码/短信/扫码均可）；
3. 插件每 2.5 秒检查一次登录态，读到有效会话即自动：**按客户端同款决策树铸取模型 Key**——先试活动限免 Key（`createActivityApiKey`，即 SCNet-Max 限免用的那种）；不可用（API010010）则走正式成员 Key（`cluster-user-detail` 解析账户 → `api-key/query` 查同名 Key 复用 → `api-key/create` 创建 `scnet-client-member-<userId>`，`serviceTypes:["model"]`）→ **发一轮真实推理验证**（401 当场失败并说明账号未开通）→ 读取套餐信息 → 关闭窗口。全程约几秒到半分钟，5 分钟未登录则超时不保存任何内容。

专用 profile 持久化在 `%LOCALAPPDATA%\magpie-scnet-auth\browser-profile`，会话有效期内再次登录通常免输入。

### 方式三：手动配置 API Key

官网登录 → 「模型 API → API Keys」→ 创建 Key（`sk-` 开头）→ 粘贴给插件。

## 模型

- 登录后插件用官方 `GET /models`（**免费、不消耗 Tokens**）动态列出该 Key 可用的全部模型（客户端同款"automatic"目录）；
- **注意：`/models` 是平台目录，不等于账号可用模型**——不在你套餐/额度内的模型调用会返回 402 Insufficient Balance（实测本机账号 `SCNet-Max` 可用、部分其他模型 402）；错误会原样透传，换一个模型即可；
- 内置目录兜底（元数据取自计算服务客户端 4.1.0）：`SCNet-Max`、`DeepSeek-V4.1-Flash-1017`、`Kimi-K3.1-Pro`、`GLM-5.3`、`Qwen3.8-Max`、`MiniMax-M3` 等 32 个，含上下文窗口 / 输出上限 / 视觉 / 工具调用 / 思考档位；
- 在 Agent 里选择 `scnet/<模型ID>`，例如 `scnet/SCNet-Max`、`scnet/DeepSeek-V4.1-Flash-1017`。

## 多账号

供应商页「添加另一个 … 账号」可以并存多个账号，行为如下：

- **网关按顺序优先第一个账号**；额度用完自动换下一个（magpie 内置行为）。想让某个账号优先，在它的账号行点「设为首选」。
- **账号失效自动跳过**：某个账号调用得到 401（比如刚注册、还没开通模型服务的账号），magpie 会把它标记为需要重新登录，请求落到下一个能用的账号上——不会拖死整个供应商。
- **桌面端方式永远跟随客户端当前账号**：凭据文件是客户端写的，客户端切了账号，所有桌面端账号都跟着变。所以桌面端方式建一个账号就有意义；要多账号并存，用浏览器登录或手动 Key。
- **浏览器方式连接的是弹窗里登录的那个账号**：要接第二个账号，重新发起浏览器登录、在弹窗里切换/登录另一个账号即可（同一浏览器配置里后登录的会替换先登录的会话）。
- **登录时的推理探针**：Key 铸出后会真发一轮最小对话；401/403（账号没有推理权限，常见于刚注册未开通的账号）会当场登录失败并说明原因，不会存进一个"看起来登录成功、实际不能用"的账号。402（账号有效但该模型不在套餐内）会正常放行。
- 已失效的账号：在其账号行点「移除」即可删掉本机记录（不影响官网侧的 Key）。

## 剩余额度（Credits）

- 用**浏览器登录**接入的账号会显示套餐名、剩余 Credits、用量进度和到期时间（控制台 `tokenplan/list`）；
- 额度查询失败（会话过期等）**只影响额度显示，不影响模型调用**（推理 Key 长期有效）；重新浏览器登录即可恢复；
- 桌面端凭据 / 手动 Key 接入的账号不查询额度（没有控制台会话），额度行会提示原因。

## 在 ZCode 里使用

Magpie 供应商里启用 `scnet` 后，在 ZCode 的模型供应商加一个 OpenAI 兼容 provider：

- Base URL：`http://127.0.0.1:3425`
- API Key：`magpie`
- 模型：`scnet/SCNet-Max` 等

验证：

```bash
curl http://127.0.0.1:3425/v1/models | grep scnet
curl http://127.0.0.1:3425/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"scnet/SCNet-Max","stream":true,"messages":[{"role":"user","content":"你好"}]}'
```

## 安装 / 移除

```bash
magpie plugin add <本仓库路径>      # 例如 ./magpie-scnet-auth
magpie plugin login scnet          # 选一种登录方式
magpie plugin logout scnet
magpie plugin rm magpie-scnet-auth
```

插件选项（`magpie plugin options scnet '{"port": 30815}'`）：

- `port`（默认 `30814`）：浏览器登录时受控窗口的调试端口；
- `loginTimeoutMs`（默认 `300000`）：浏览器登录等待超时。

## 隐私与安全

- **读什么**：桌面端方式只读 `scnet-credentials` 目录下的 JSON 与客户端 `config.json` 的账号名；浏览器方式只读受控窗口里 `*.scnet.cn` 的 Cookie。不碰日常浏览器、不碰其他网站的任何数据。
- **存什么**：API Key（与可选的控制台 Cookie）保存在 Magpie 凭据文件 `~/.config/magpie/plugin-auth.json`；桌面端方式额外记一个凭据文件路径用于每请求重读。
- **发哪里**：模型请求只发 `https://api.scnet.cn`；控制台会话只发 `https://www.scnet.cn` 固定接口。两者都 `redirect: "error"`，不跟随重定向，凭据不外泄。
- **不做什么**：不重置任何 Key、不购买套餐、不修改浏览器或系统设置；浏览器登录创建的 Key 严格复刻客户端自身的 Key 生命周期（活动限免 Key / `scnet-client-member-<userId>` 成员 Key），可在平台 API Keys 页随时查看。

## 前置要求

- **Magpie**（插件宿主自带 Bun 运行时，无需另装依赖）；独立用 Node 跑脚本需 Node ≥ 22；
- **以 Windows 为准**：桌面端凭据方式依赖 Windows 上安装的「计算服务」客户端；浏览器登录支持 Edge / Chrome（其他平台可用手动 Key 方式）；
- 一个能登录 scnet.cn 的账号（三种登录方式见下）。

## 已知限制

- 桌面端方式要求客户端至少跑过一次对话（否则凭据文件不存在）；
- 浏览器登录需要 Edge 或 Chrome（Windows 默认安装的 Edge 即可）；组策略禁用调试端口时退回手动方式；
- 控制台接口是内部端点，可能随官网更新变化——全部收敛在 `console.mjs`，出问题时用 `scripts/probe-console.mjs` 勘察；
- 图片输入：目录里声明视觉能力的模型（`input: ["text","image"]`）按 OpenAI 协议直传，以平台实际支持为准；
- 套餐外的模型调用返回 402（见「模型」一节），插件不猜账号可用集——以实际调用为准。

## 许可与免责声明

本项目以 [MIT License](LICENSE) 开源。**MIT 只覆盖本仓库中的源代码**，不涉及、也不授予任何平台侧的权利。

- **无关联**：本项目与超算互联网（SCNet）、曙光智算、「计算服务」客户端、Magpie 均无关联，未获得任何形式的授权或背书；文中出现的名称与商标归各自权利人所有。
- **用途限定**：仅供个人学习、研究协议交互方式之用，请自用。**不要**用于商业运营、对外转供、批量自动化调用——平台明示 Token Plan 仅限本人在 AI 工具中交互式使用，违规可能导致 Key 被封。
- **平台条款自审**：本插件调用的部分控制台接口是未公开的内部端点，可能随平台更新失效或违反平台服务条款。是否使用、如何使用，由你自行判断并承担后果（包括账号限流、封禁、Key 失效等风控措施）。
- **无担保**：软件按「现状」提供，不附带任何明示或默示的担保。作者不对使用本软件造成的任何损失（含账号处罚、数据丢失、费用损失）承担责任——这是 MIT 协议的一部分。
- **不含凭据**：仓库任何文件都不包含 Cookie、API Key 或账号信息；登录凭据只保存在你本机的 Magpie 凭据文件中。发现安全问题请走负责任披露（issue 私信作者），不要公开贴凭据。
- **异议处理**：如权利人认为本项目侵害其合法权益，请提 issue 或联系作者，核实后会及时下架或调整。

> **Disclaimer (English summary — the Chinese section above governs):** This is an independent,
> non-commercial personal project for studying API interoperability. It is not affiliated with,
> endorsed by, or authorized by SCNet /曙光智算 or Magpie. It contains no credentials and stores
> none in the repository. Users are responsible for complying with the platform's terms of
> service; account actions taken by the platform are the user's own risk. The software is
> provided "AS IS" under the MIT License, without warranty of any kind. Rights holders may
> request removal via issues.

## 开发

```bash
node scripts/check.mjs          # 离线契约自检（不联网、不读真实凭据）
node scripts/test-desktop.mjs   # 真实凭据半端到端：/models + 非流式 + 流式
node scripts/probe-console.mjs "<Cookie>" [--create]   # 控制台接口勘察
```

## 目录

```
index.mjs               # 插件导出：config 注入 / 三种登录方法 / usage / loader / 动态模型目录
desktop-credentials.mjs # 计算服务客户端凭据读取（只读）
browser-login.mjs       # 受控浏览器窗口 + 极简 CDP + 自动铸 Key
console.mjs             # 控制台接口客户端（统一 {code:"0"} 校验与中文报错）
models.mjs              # 内置模型目录（源自客户端 4.1.0）+ 动态合并 + /models 发现
scripts/                # check / test-desktop / probe-console
```
