# KeyLoom 服务架构与运维说明

本文档描述当前仓库的实际部署形态、功能边界和日常运维方法，面向有一些计算机基础的维护者。本文档属于本地运维资料，按当前需求不提交到 GitHub。

## 1. 服务定位

KeyLoom 是运行在 Cloudflare Workers 上的 AI API 中转站：用户登录后创建自己的下游 API Key，服务根据模型目录选择管理员配置的上游渠道，转发请求，并在流式响应中统计 token 用量和扣费。

当前线上入口：

- Web/API：`https://keyloom.cc.cd`
- Worker 服务名：`keyloom-api`
- 项目分支：`feature/keyaos-platform`
- GitHub：`https://github.com/buzhiyouqiu-crypto/ai-proxy-cloudflare`

这是 Platform 模式部署：用户认证使用 Clerk，管理员由 Clerk 用户 ID 识别，充值能力可选接入 Stripe。

## 2. 架构总览

```text
浏览器 / OpenAI SDK / 下游 API Key
              |
              v
Cloudflare Worker: keyloom-api
  ├─ Clerk 认证：登录、会话、管理员身份
  ├─ API Key 认证：/v1/* 下游调用
  ├─ Dispatcher：按模型匹配可用渠道
  ├─ Provider Adapter：固定渠道或自定义 OpenAI-compatible 渠道
  ├─ Billing：Usage Durable Object + D1 记录用量、钱包和支付
  └─ 静态资源：Worker Assets 提供前端 dist
       |                 |                  |
       v                 v                  v
     D1               R2（可选）          上游 AI 服务商
  keyloom-db       keyloom-vaults       OpenAI-compatible API
```

一次普通请求大致经过以下步骤：

1. 请求到达 Worker，经过 CORS、Clerk 会话或下游 API Key 鉴权。
2. Dispatcher 根据请求模型查询 `model_catalog`，找到已启用且健康的渠道。
3. Provider Adapter 使用 D1 中加密保存的上游凭证访问上游 API；文本请求走 JSON，图片生成/编辑分别走 JSON 或 multipart/form-data。
4. Worker 透传文本、流式或图片响应，同时解析上游返回的 usage；图片接口没有 token usage 时按图片单价计费。
5. 用量写入 Durable Object/D1，并根据模型价格扣减用户余额。

## 3. 当前 Cloudflare 资源

仓库中的 `wrangler.toml` 当前配置为：

| 资源 | 当前值 | 作用 |
|---|---|---|
| Worker | `keyloom-api` | 运行 API、前端和定时任务 |
| D1 | `keyloom-db` | 用户、API Key、渠道、模型、钱包、支付和日志等关系数据 |
| D1 ID | `2724cd7c-166a-402a-a553-1e27f74a8422` | 当前生产数据库 ID |
| Durable Object | `USAGE_DO` | 处理用量累计，减少并发扣费冲突 |
| Worker Assets | `./dist` | Vite 构建后的前端静态资源 |
| R2 | `keyloom-vaults` | 已创建，但不在当前 Keyaos 核心请求链路中 |

注意：`keyloom-vaults` 是之前 AI Vault/Octopus 流程使用的存储桶。当前 KeyLoom 的用户、渠道和计费数据主要放在 D1；除非后续代码显式加入 R2 binding，否则不能把 R2 视为当前业务数据的主存储。

## 4. 已有功能

### 用户侧

- Clerk 注册、登录、退出和会话管理。
- 创建、查看、删除用户 API Key。
- 查看可用模型目录。
- 通过 OpenAI-compatible API 调用聊天模型。
- 支持 `/v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1/embeddings` 和 `/v1/models` 等接口，具体以当前路由实现为准。
- 支持 OpenAI 风格图片接口 `/v1/images/generations` 和 `/v1/images/edits`；前者接收 JSON，后者接收 multipart/form-data。
- Responses API 支持常用的非流式和 SSE 流式请求，并在内部转换为 Chat Completions，因此会复用现有的模型路由、故障转移、用量统计和余额扣费链路。使用 Codex 等客户端时，`base_url` 应指向 `https://keyloom.cc.cd/v1`。
- 当前不保存 Responses 响应，`previous_response_id`、后台任务、conversation 以及内置工具等依赖服务端状态的能力暂不支持；自定义上游仍需提供 Chat Completions 兼容接口。
- 对请求用量进行统计，并使用模型目录中的输入/输出价格计算费用。
- 可选 Stripe 充值、自动充值和支付回调。

### 管理员侧

管理员进入 `/admin` 后可以：

- 查看用户、用量、钱包和支付相关数据。
- 管理上游凭证和模型目录。
- 在“上游渠道”页面添加自定义渠道。
- 填写渠道名称、Base URL、API Key、官网地址和输入/输出价格。
- 点击“获取模型”，从上游的 `<base_url>/models` 自动读取模型。
- 渠道可以勾选“上游不需要传 API Key”。勾选后模型发现、余额提取和实际请求都不会发送 `Authorization` 头；历史渠道未设置该字段时默认仍按需要 API Key 处理。
- 手动调整模型 ID、展示名称和每百万 token 价格。
- 设置统一价格倍率、启用/禁用渠道。
- 使用受限的余额提取器刷新渠道余额。
- 为图片模型维护每张图片的价格；如果上游只返回图片结果而没有 token usage，则按配置的图片单价扣费。

固定 Provider 和自定义 Provider 都会进入同一个模型目录，由 Dispatcher 统一选择。多个自定义渠道可以绑定同一个规范模型；公开模型详情页只展示一个“自定义渠道”项，管理员展开后可查看匹配的渠道和余额。

当前固定注册了 MiniMax 官方渠道。它使用 MiniMax 的 OpenAI-compatible 地址
`https://api.minimax.cn/v1`，模型目录包含 `MiniMax-M3`、`MiniMax-M2.7` 和
`MiniMax-M2.5`。它按 Token Plan/订阅渠道处理，不把 Token Plan 的 5 小时和周窗口配额伪装成美元余额；“自有密钥”页面刷新时会调用官方
`/v1/token_plan/remains` 接口，并展示类似 `5小时:100% 2h8m · 7天:59% 4d6h` 的快照。MiniMax 的普通按量 API Key 与 Token Plan Key 是两套不同凭证，按量计费场景请使用自定义渠道并手工配置美元配额。

MiniMax 官方接口参考：[OpenAI 兼容模型列表](https://platform.minimaxi.com/docs/api-reference/models/openai/list-models)、[OpenAI 兼容对话接口](https://platform.minimaxi.com/docs/api-reference/text-chat-openai)、[Token Plan 与 API Key 说明](https://platform.minimaxi.com/docs/token-plan/faq)。

## 5. 自定义上游渠道

自定义渠道要求上游至少兼容以下接口：

- `GET <base_url>/models`
- `POST <base_url>/chat/completions`
- 可选：`POST <base_url>/embeddings`
- 可选：`POST <base_url>/images/generations`、`POST <base_url>/images/edits`

Base URL 建议填到 `/v1` 层级，例如：

```text
https://example.com/v1
```

不要把 API Key 写进 Base URL。KeyLoom 会把它加到 `Authorization: Bearer <key>` 请求头，并使用加密后的形式保存。

### 模型价格

输入和输出价格的单位是 USD/1M tokens；图片模型还可以配置 USD/张的图片价格。价格必须按实际上游账单填写，否则用户扣费会偏高或偏低。上游模型的价格、上下文长度和别名变化时，需要管理员手动刷新或修改目录。上游图片接口如果返回 usage，系统优先使用可解析的 usage；无法得到 token usage 时使用模型的图片单价作为兜底。

### 余额提取器

余额提取器兼容 CC Switch 风格的配置，但当前实现是受限解析器，不会在 Worker 运行时执行任意 JavaScript。Cloudflare Workers 禁止运行时 `eval`/`new Function`，因此只支持请求配置、响应字段读取、局部变量、简单算术，以及 `display`/`extra` 文本拼接。例如 MiniMax 的 Token Plan 响应会被内置识别；其他渠道可以返回金额，或用百分比 `unit` 加 `display`/`extra` 表达窗口配额：

```js
({
  request: {
    url: "https://example.com/api/balance",
    method: "GET",
    headers: {
      Authorization: "Bearer {{API_KEY}}"
    }
  },
  extractor: function(response) {
    return {
      remaining: Number(response.data.balance),
      unit: "USD"
    };
  }
})
```

如果服务商需要签名算法、复杂分页、POST JSON 或任意自定义脚本，当前提取器可能无法工作，需要为该服务商增加专用适配器。

## 6. 配置项和密钥

### 必需的生产密钥

通过 Cloudflare Worker Secrets 设置，不要写进 Git：

| 名称 | 用途 |
|---|---|
| `ENCRYPTION_KEY` | 加密上游 API Key 等敏感凭证 |
| `CLERK_SECRET_KEY` | Worker 校验 Clerk 会话和读取用户信息 |
| `PLATFORM_OWNER_ID` | 管理员 Clerk 用户 ID，例如 `user_...` |

### 可选配置

| 名称 | 用途 |
|---|---|
| `STRIPE_SECRET_KEY` | 创建充值和支付请求 |
| `STRIPE_WEBHOOK_SECRET` | 验证 Stripe webhook |
| `LOCAL_SYNC` | 开发或特殊场景下使用本地 Provider 同步逻辑 |
| `CNY_USD_RATE` | 人民币价格换算美元的汇率，当前默认值为 `7` |
| `ADMIN_TOKEN` | 旧 Core 模式兼容项，Platform 模式不应作为主要登录方式 |

前端构建变量：

```text
VITE_CLERK_PUBLISHABLE_KEY=pk_live_...
```

Publishable Key 可以出现在前端构建中；Clerk Secret Key、Stripe Secret Key、上游 API Key 和 `ENCRYPTION_KEY` 不能暴露给浏览器。

## 7. 限制与容量估算

### 应用本身的限制

当前版本没有实现“每个用户每天 N 次请求”的业务配额，也没有内置完整的 IP 限速、WAF、滥用检测或并发队列。实际可用量由以下因素共同决定：

- Cloudflare Workers/D1 的计划限制。
- 上游服务商的 QPS、余额和并发限制。
- Stripe、Clerk 等第三方服务的账户计划限制。
- Worker CPU、内存和单次请求子请求数量。

### 当前请求体边界

Worker 会在解析 JSON 或 multipart 请求前检查请求体大小，避免异常大请求直接占用 CPU/内存：

- 普通 `/api/*` JSON 请求：最大 2 MiB。
- 聊天、消息、嵌入和图片接口：最大 10 MiB；其中图片编辑请求的文件也计入该上限。
- 超过上限时返回 `413 Request body too large`，不会继续访问上游。

这些是应用层硬上限，不等同于 Cloudflare 账户的整体请求配额；图片编辑若需要更大的原图，需要先压缩或后续单独调整限制。

如果准备公开给陌生用户使用，应在 Cloudflare Dashboard 增加 WAF/Rate Limiting，并在应用层增加按用户、API Key、IP 的限流和每日额度。

### Cloudflare Workers

按当前 Cloudflare 官方文档，Workers Free 计划包含每天 100,000 次 Worker 请求，按 UTC 午夜重置；超过后可能返回 1027。Free 计划单次 CPU 时间为 10 ms、内存 128 MB、单次最多 50 个子请求。Workers Paid 计划最低 5 美元/月，包含每月 1,000 万次请求和 3,000 万 CPU 毫秒，超出后按量计费。

参考：[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)、[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)。

### D1

免费 D1 计划的主要额度是每天 500 万行读取、每天 10 万行写入和账户总计 5 GB；单个数据库免费上限约 500 MB。请求日志、usage、价格蜡烛和计费写入都会消耗 D1 配额。定时任务每分钟触发一次，因此一天约有 1,440 次定时触发，虽然每次实际读写量取决于同步和自动充值逻辑。

参考：[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)、[D1 limits](https://developers.cloudflare.com/d1/platform/limits/)。

### R2

当前 R2 桶不参与普通 AI 请求转发。Cloudflare R2 Standard 免费额度包含每月 10 GB-month 存储、100 万次 Class A 操作和 1,000 万次 Class B 操作，互联网出口通常不单独收取费用；实际账单仍取决于存储类型和超额使用。

参考：[R2 pricing](https://developers.cloudflare.com/r2/pricing/)。

### 结论

个人测试、小范围内测可以使用 Free 资源；正式公开中转服务建议至少使用 Workers Paid，并额外设置应用层限流。上游 AI 调用费用不包含在 Cloudflare 费用中，通常才是主要成本。

### 调度与负载分配

当前 Dispatcher 不是严格的 Round Robin，也不是按连接数的实时负载均衡。它会先读取模型对应的可用渠道和凭证，排除禁用或被标记为不健康的候选，再按“上游输入价 × 渠道价格倍率”排序，优先尝试成本较低的渠道；同价候选会打散顺序。某个上游返回非 2xx 或发生网络异常时，会继续尝试下一个候选。

Platform 模式下，平台渠道使用全局上游凭证池；BYOK/自有密钥请求只使用当前用户自己的凭证。每条自定义模型目录记录还会保留所属渠道 ID，因此即使多个渠道绑定同一个规范模型，调度器也只会把该记录交给对应渠道的凭证，并使用该渠道自己的上游模型 ID。是否能真正形成多渠道分担，还取决于同一个规范模型是否已经绑定到多个启用中的渠道，并且这些渠道的上游模型 ID 映射正确。

### 图片接口调用

对外 Base URL 是站点地址加 `/v1`。图片生成使用 JSON：

```bash
curl https://keyloom.cc.cd/v1/images/generations \
  -H "Authorization: Bearer $KEYLOOM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2.5-flare","prompt":"一只在月光下的猫","size":"1024x1024"}'
```

图片编辑使用 multipart/form-data：

```bash
curl https://keyloom.cc.cd/v1/images/edits \
  -H "Authorization: Bearer $KEYLOOM_API_KEY" \
  -F "model=gpt-image-2.5-flare" \
  -F "prompt=添加夕阳效果" \
  -F "image=@input.png"
```

### `No API key available` 的含义

这个错误不一定表示 D1 中没有上游 Key。当前实现会在候选渠道都无法完成请求（凭证缺失、模型 ID 不匹配、上游返回 401/404/429/5xx 或网络失败）后返回统一错误。排查时应同时检查 Worker tail、模型目录、渠道健康状态和 D1 的错误详情。

自定义渠道的 `provider` 标识应使用固定值 `custom`，页面展示名称只是管理员可见的渠道名；例如规范模型 `minimax/minimax-m3` 发送到某个自定义渠道时，上游模型 ID 必须映射为该服务商实际接受的 `minimax-m3`。若上游返回 `model_not_found`，优先核对这个映射、Base URL 和上游账号权限。

## 8. 部署流程

### 本地开发

Wrangler 当前要求 Node.js 22 或更高版本。基本流程：

```bash
nvm use 22
npm install
npm run typecheck
npm run build
```

本地密钥放在 `.dev.vars` 或本地环境文件中，不能提交。生产密钥应在 Cloudflare Dashboard 或 Wrangler Secrets 中设置，例如：

```bash
npx wrangler secret put ENCRYPTION_KEY --name keyloom-api
npx wrangler secret put CLERK_SECRET_KEY --name keyloom-api
npx wrangler secret put PLATFORM_OWNER_ID --name keyloom-api
```

部署前先应用 D1 迁移：

```bash
npx wrangler d1 migrations apply keyloom-db --remote
npm run build
npx wrangler deploy
```

如果使用 Cloudflare Git 集成，构建目录应是项目根目录，构建命令为 `npm run build`，部署命令应能执行 D1 迁移和 `wrangler deploy`。不要再把 `ui/dist` 当成当前项目的资源目录；当前 Worker 配置使用根目录下的 `dist`。

## 9. 上线后检查

建议按以下顺序检查：

1. 打开 `https://keyloom.cc.cd/health`，确认 Worker 可达。
2. 打开 `/api/models`，确认公开模型目录有数据。
3. 用 Clerk 登录，确认能进入 `/dashboard`。
4. 确认管理员用户 ID 与 `PLATFORM_OWNER_ID` 完全一致。
5. 进入 `/admin/channels` 添加一个测试渠道，获取模型并保存。
6. 在 `/dashboard/api-keys` 创建下游 API Key。
7. 使用 `/v1/models`、`/v1/chat/completions` 和 `/v1/responses` 做一次小额测试。
8. 使用 `/v1/images/generations` 和 `/v1/images/edits` 各做一次小文件测试。
9. 检查钱包扣费、usage 记录和 Worker 日志。

示例请求：

```bash
curl https://keyloom.cc.cd/v1/chat/completions \
  -H "Authorization: Bearer $KEYLOOM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-model-id",
    "messages": [{"role": "user", "content": "hello"}]
  }'
```

## 10. 日常运维

### 查看日志

```bash
npx wrangler tail keyloom-api --format pretty
```

同时可以在 Cloudflare Dashboard 的 Workers → `keyloom-api` → Logs/Observability 查看请求、错误和采样数据。

### 常见故障

| 现象 | 优先检查 |
|---|---|
| 登录按钮无反应 | `VITE_CLERK_PUBLISHABLE_KEY`、Clerk 生产实例域名、浏览器控制台和网络请求 |
| 登录成功但没有管理员菜单 | `CLERK_SECRET_KEY` 是否正确、`PLATFORM_OWNER_ID` 是否是当前 Clerk 用户 ID |
| `/api/models` 为空 | 渠道是否启用、模型目录是否创建、上游 `/models` 是否可访问 |
| `No key available` | 模型 ID 与目录是否完全匹配，渠道是否健康且已启用 |
| 图片接口失败 | 请求是否使用正确的 JSON/multipart 格式、模型是否支持图片、图片请求体是否超过 10 MiB |
| `Invalid token` | 上游 API Key、下游 Key 或 Clerk 会话是否过期；不要把三种 token 混用 |
| `Internal server error` | 先看 `wrangler tail`，重点检查 D1 迁移、`ENCRYPTION_KEY` 和 Clerk Secret |
| 余额刷新失败 | 提取器 URL、请求头、响应字段路径或受限语法是否正确 |
| Error 1027 | Workers Free 每日请求额度耗尽，或有异常流量 |
| D1 quota/limit 错误 | 查看 D1 行读取/写入量、日志写入量和定时任务频率 |

### 密钥轮换

如果上游 Key、Clerk Secret、Stripe Secret 或下游 Key 泄露：

1. 立即在对应服务商后台撤销旧密钥。
2. 生成新密钥并通过 Cloudflare Secret 更新。
3. 上游渠道在 KeyLoom 管理页更新 API Key。
4. 检查 Worker 日志和上游账单，确认没有异常调用。

不要把包含 Cookie、Clerk Session JWT、Stripe Secret 或上游 API Key 的 curl 命令提交到仓库、Issue 或公开聊天中。

## 11. 备份、回滚与升级

- 代码回滚优先使用 Git 的 `git revert <commit>`，再重新部署。
- D1 迁移必须可重复、可审查；不要在生产库直接执行未保存的临时 SQL。
- 升级依赖前先运行 `npm run typecheck`、`npm run build` 和测试。
- 发布前备份 D1，并在 Cloudflare Dashboard 检查 Worker、D1、Durable Object 和 R2 的指标。
- 修改上游渠道或价格前，先保留旧配置；价格错误会直接影响用户余额。

## 12. 当前明确未覆盖的能力

以下内容不能仅靠当前部署自动获得：

- 应用层每天访问次数限制。
- 完整的 IP/用户/API Key 限流和封禁系统。
- 任意 JavaScript 余额提取器执行环境。
- R2 作为当前业务数据库或请求缓存。
- 多区域高可用、队列重试和复杂故障转移策略。
- Stripe 生产收款合规、退款和税务处理。

这些能力需要后续单独设计，尤其是公开运营前的限流、风控、审计和退款流程。
