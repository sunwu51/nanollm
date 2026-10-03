<div align="center">

<img src="assets/logo.svg" alt="nanollm" width="96" height="96" />

# nanollm

**轻量、本地化的 LLM 网关 —— 一个入口聚合多个模型供应商**

兼容 OpenAI Chat / Responses、Anthropic Messages 与 OpenAI 图片接口，支持兜底分组、Codex / Claude 订阅、用量统计与定时模型任务。

[![npm version](https://img.shields.io/npm/v/nanollm?color=7c5cff)](https://www.npmjs.com/package/nanollm)
[![npm downloads](https://img.shields.io/npm/dm/nanollm?color=14b8a6)](https://www.npmjs.com/package/nanollm)
[![license](https://img.shields.io/npm/l/nanollm)](package.json)
[![GitHub stars](https://img.shields.io/github/stars/sunwu51/nanollm?style=social)](https://github.com/sunwu51/nanollm)

[English](README.md) · **简体中文**

[特性](#特性) · [快速开始](#快速开始) · [完整配置](#完整配置示例) · [Web 界面](#web-界面) · [部署](#部署) · [架构文档](docs/architecture.md)

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/nanollm)

</div>

---

一个类似 `litellm` 的 LLM 模型代理服务，主打轻量和本地化，适合个人在本地聚合多个模型。

## 特性

- **多协议接入**：可配置 `chat/completions`（下称 chat）、`responses`、`messages` 三种文本接口，以及 OpenAI 图片 `images/generations`、`images/edits` 接口的供应商（暂不支持 Google 接口），并同时对外暴露这些接口（带 `/v1` 前缀）；三种文本协议之间可以互相转换，转换规则见 [docs/converters.md](docs/converters.md)。
- **请求改写**：可配置修改请求的 `headers` 和 `body`（`body` 支持深度合并），还支持 `body_expression` / `response_expression` 动态表达式。
- **兜底分组**：设置兜底分组后，调用的模型下游失败时会自动尝试分组内的其他模型。
- **订阅供应商**：支持 OpenAI Codex 订阅和 Claude Pro/Max 订阅，在管理页登录即可作为模型供应商使用。
- **热更新与管理页**：`/admin` 提供表单式配置管理（含模型连通性测试、拉取上游模型列表）；`models`、`fallback`、`server.ttfb_timeout`、`record.max_size` 保存后立即生效，`server.port` 和 `server.auth.token` 写回后需重启进程。
- **监控与用量**：`/status` 展示模型健康状态与按日 token 用量；`/record` 保存最近请求并支持回放，对 debug 很有用。
- **定时模型任务**：`/jobs` 按 cron 定时调用多个模型，保存作品并支持历史对比与人工审核。
- **持久化可选**：默认内存存储；`--storage sqlite` 可使用本地 SQLite 文件或远程 libSQL/quicSQL 服务。
- **安全与运维**：可选 Bearer Key 认证；支持 SIGTERM/SIGINT 优雅停机；支持 Docker / Railway 一键部署与多平台二进制包。

## 快速开始

**1. 创建最简配置。** 新建 `config.yaml`，只需要写端口，供应商和模型都不用提前配置：

```yaml
server:
  port: 3000
```

**2. 启动。**

```bash
npx nanollm@latest --config /path/to/config.yaml
```

如果当前目录就有 `config.yaml`，也可以直接运行 `npx nanollm`；配置文件路径也可以通过环境变量 `CONFIG_PATH` 指定。npm 发布包不会包含配置文件，需要自己创建。

**3. 在管理页中配置。** 打开 `http://localhost:3000/admin`，添加供应商、模型和 fallback 分组等。点击“保存并应用”后配置立即生效，并且**会自动回写到 `config.yaml`**，不需要手动编辑文件（当然手动改文件也会被自动加载）。如果要把服务暴露到本机以外，请先配置 [Bearer Key 认证](#bearer-key-认证)。

**4. 调用。** 配置好的模型即可通过下面的接口使用：

| 入口 | 说明 |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat 接口 |
| `POST /v1/responses` | OpenAI Responses 接口 |
| `POST /v1/messages` | Anthropic Messages 接口 |
| `POST /v1/images/generations`、`/v1/images/edits` | OpenAI 图片接口（原样透传） |
| `POST /v1/alpha/search`（以及 `/alpha/search`） | Codex alpha 搜索接口透传，只改写 `model` 字段，表达式配置不生效 |
| `GET /v1/models` | 对外提供的模型列表 |
| `/admin`、`/status`、`/record`、`/jobs` | 配置管理、监控与用量、请求记录、定时任务页面 |
| `GET /health` | 健康检查（不需要认证） |

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"glm5.1","messages":[{"role":"user","content":"hello"}]}'
```

## 完整配置示例

上面的最简配置之外，所有选项都可以写在 `config.yaml` 里（也都能在 `/admin` 中编辑）。下面是一个涵盖常见场景的完整示例，初次使用不必照搬，按需取用即可：

```yaml
server:
  port: 3000 # default 3000
  ttfb_timeout: 5000 # optional, upstream first-byte timeout in ms

record:
  max_size: 100 # optional, default 10

providers:
  # 普通共享供应商：集中保存协议、地址和 API Key
  # 也可以不配置providers直接在model中指定base_url和api_key
  - name: deepseek
    provider: openai-chat
    base_url: https://api.deepseek.com/v1
    api_key: ${DEEPSEEK_API_KEY}

  # OpenAI Codex 订阅：不配置 base_url 和 api_key
  - name: codex-subscription
    provider: openai-subscription

  # Claude Pro/Max 订阅：不配置 base_url 和 api_key，在 /admin 登录
  - name: claude-subscription
    provider: claude-subscription

models:
  - name: gpt-5.4-a
    # responses规范
    provider: openai-responses
    base_url: https://example.com/v1
    api_key: YOUR_KEY1
    model: openai/gpt-5.4

  - name: gpt-5.4-b
    # responses规范
    provider: openai-responses
    base_url: https://example.com/v1
    api_key: YOUR_KEY1
    model: openai/gpt-5.4
      
  - name: glm5.1
    # chat/completions规范
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: YOUR_KEY2
    model: glm5.1
    image: true # optional, default true; only effective for openai-chat provider
    ttfb_timeout: 3000 # optional, overrides server.ttfb_timeout
    allow_h2: false # optional, default false; enable HTTP/2 ALPN for this upstream
    proxy: http://127.0.0.1:7890 # optional, overrides providers[*].proxy and HTTPS_PROXY/HTTP_PROXY for this model
    headers:
      user-agent: nanollm
    body:
      temperature: 1
      store: false
      text: '{"verbosity":"high"}'
    body_expression: |
      ({
        ...body,
        messages: body.messages?.map((message) => ({
          ...message,
          updatedAt: Date.now()
        }))
      })
  
  - name: claude-sonnet-4-6
    # messages规范
    provider: anthropic
    base_url: https://example.com/v1
    api_key: ${YOUR_KEY3_FROM_ENV_VAR}
    model: claude-sonnet-4-6
    ignore_invalid_history: true # optional, default true; Anthropic转换时丢弃空signature的thinking历史

  - name: gpt-image-1
    # OpenAI 图片接口规范（images/generations、images/edits）
    provider: openai-image
    base_url: https://example.com/v1
    api_key: YOUR_KEY4
    model: gpt-image-1

  - name: deepseek-shared
    custom_provider: deepseek
    model: deepseek-chat

  - name: codex-subscription-model
    custom_provider: codex-subscription
    model: gpt-5

fallback:
  gpt-5.4:
    - gpt-5.4-a
    - gpt-5.4-b
    - glm5.1
```

对外提供的模型为所有 `models[i].name` 和 `fallback.[group_name]`，例如上面的示例配置就提供了：

```
gpt-5.4-a
gpt-5.4-b
glm5.1
claude-sonnet-4-6
gpt-image-1
deepseek-shared
codex-subscription-model
gpt-5.4
```

这样 8 个模型，其中 `gpt-5.4` 是兜底分组名。使用这个模型时，会在分组内寻找可用的模型，尝试顺序按 `max(0, 最近 5 分钟失败次数 - 1)` 升序；如果分数相同，则保持配置里的原始顺序。

## 配置详解

### 共享供应商配置

多个模型使用相同的协议、上游地址和 API Key 时，可以在顶层 `providers` 中集中配置，然后通过 `models[*].custom_provider` 引用：

```yaml
providers:
  - name: deepseek
    provider: openai-chat
    base_url: https://api.deepseek.com/v1
    api_key: ${DEEPSEEK_API_KEY}

models:
  - name: deepseek-chat
    custom_provider: deepseek
    model: deepseek-chat
  - name: deepseek-reasoner
    custom_provider: deepseek
    model: deepseek-reasoner
```

`providers[*].name` 必须唯一，引用的供应商必须存在。配置了 `custom_provider` 的模型不需要再写 `provider`、`base_url` 和 `api_key`；运行时会从供应商配置展开这些连接字段。模型自身的其他高级字段仍然按原方式配置。

两种模型连接方式互斥：

- 直接连接：模型配置 `provider`、`base_url`、`api_key`。
- 共享供应商：模型只配置 `custom_provider`，不能同时配置上述三个直接连接字段。

普通共享供应商的 `provider` 支持 `openai-chat`、`openai-responses`、`anthropic` 和 `openai-image`。

### OpenAI subscription

Codex 订阅只能在顶层 `providers` 中配置，不能直接写成模型的 `provider`：

```yaml
providers:
  - name: my-codex-subscription
    provider: openai-subscription

models:
  - name: gpt-subscription
    custom_provider: my-codex-subscription
    model: gpt-5
```

`openai-subscription` 不接受 `base_url` 或 `api_key`。保存配置后，在 `/admin` 展开该供应商并点击“登录”，按页面显示的 Device Code 完成授权。登录成功后，页面会显示“已登录”，并提供“重新登录”和“查询用量”。

凭据以明文 JSON 保存到 `<config.yaml 所在目录>/openai-subscription/<uuid>.json`，内容包含 access token、refresh token、过期时间、账户 ID 和供应商名称等信息。nanollm 会在 token 到期前自动刷新并更新该文件，因此该目录需要限制访问并持久化。

Railway 使用 `/data/config.yaml` 时，凭据位于 `/data/openai-subscription/<uuid>.json`。将 volume 挂载到 `/data` 即可同时保存配置和登录状态，服务端可以直接通过管理页完成 Device Code 登录。

Codex 订阅请求会透传客户端同时提供的 `originator` 与 `User-Agent`；缺少其中任一项时使用一组配对的 Codex CLI 默认值。默认版本、`originator` 和 UA 在 `src/subscriptions/subscription-client-compat.ts` 中维护，升级兼容版本时修改该文件。

### Claude subscription

Claude Pro / Max 订阅同样只能在顶层 `providers` 中配置，模型通过 `custom_provider` 引用，按 Anthropic Messages 协议（`/v1/messages`）调用上游：

```yaml
providers:
  - name: my-claude-subscription
    provider: claude-subscription

models:
  - name: claude-sonnet-subscription
    custom_provider: my-claude-subscription
    model: claude-sonnet-4-5
```

`claude-subscription` 不接受 `base_url` 或 `api_key`。Claude 没有 Device Code 登录，流程是：保存配置后在 `/admin` 展开该供应商并点击“登录”，在新打开的 Claude 授权页完成授权；浏览器随后跳转到 `https://platform.claude.com/oauth/code/callback?code=...&state=...`，把地址栏中的完整 URL（或该页面显示的 `code#state`）粘贴回管理页弹窗并点击“完成登录”。登录会话 10 分钟内有效。登录成功后同样显示“已登录”、“重新登录”和“查询用量”（5 小时 / 7 天窗口利用率）。

Claude Code 的兼容版本与默认 User-Agent，以及 Codex CLI 的默认身份常量，集中保存在 `src/subscriptions/subscription-client-compat.ts`；升级对应 CLI 兼容版本时请同步更新这里的版本及 Claude beta 标识。Claude 请求若客户端未传 `x-claude-code-session-id`，网关会按 UTC 日期与请求中的 `x-forwarded-for` 首个地址（或 `x-real-ip`、`cf-connecting-ip`）生成当日稳定值，IP 部分以 SHA-256 摘要形式写入。

凭据以明文 JSON 保存到 `<config.yaml 所在目录>/claude-subscription/<uuid>.json`（access token、refresh token、过期时间、scopes、订阅类型、账户邮箱等），在到期前 5 分钟自动刷新。请求上游时使用 `Authorization: Bearer`，并参考 Claude Code 的请求头：`anthropic-beta` 总是包含 `oauth-2025-04-20` 与 `claude-code-20250219`（与客户端传入的 beta 合并）；缺失时补 `Accept`、`User-Agent`、`x-app`、`x-stainless-*` 和 `anthropic-dangerous-direct-browser-access` 默认值，流式请求补 `x-stainless-helper-method: stream`，每个缺少 `x-client-request-id` 的请求生成新 UUID。客户端传入的这些头以及模型配置中的 `headers` 可覆盖默认值。

Claude 订阅请求若没有现成的 billing system block，会在最终请求体的 `system` 数组前插入 `x-anthropic-billing-header: cc_version=<CLI版本>.<指纹>; cc_entrypoint=cli;` 文本。指纹按首条用户消息计算，CLI 版本取最终出站 `claude-cli/*` UA 的版本或上述默认版本；不会添加 `cch`。


### Bearer Key 认证

如果你希望给整个 nanollm 网关加一层访问认证，可以配置：

```yaml
server:
  auth:
    token: ${NANOLLM_AUTH_TOKEN}
```

- `server.auth.token` 为空或不配置时，认证关闭。
- 运行中，修改 `server.auth.token` 会写回配置文件，但和 `server.port` 一样需要重启进程后才会真正生效。
- 一旦配置，除了 `/health` 以外，其余入口都要求认证，包括 `/`、`/status`、`/record`、`/admin`、`/jobs`、`/v1/models` 和 `/v1/*`。
- 认证只保护访问 nanollm 本身，不会替代或覆盖 `models[*].api_key`，也不会转发到上游模型供应商。

API 客户端使用标准 Bearer header：

```bash
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer $NANOLLM_AUTH_TOKEN"
```

如果你用 OpenAI SDK 或兼容客户端，把这个 token 当成访问 nanollm 的 API key 即可。

浏览器打开页面时，可以用一次性 URL token 入口：

```text
http://localhost:3000/admin?token=YOUR_TOKEN
http://localhost:3000/status?token=YOUR_TOKEN
http://localhost:3000/record?token=YOUR_TOKEN
http://localhost:3000/jobs?token=YOUR_TOKEN
```

首次用 `?token=` 或 Bearer header 认证成功后，nanollm 会写入同源认证 cookie。之后同一浏览器里直接访问 `/admin`、`/status`、`/record`、`/jobs`，以及这些页面内部的 `fetch` 请求，都不需要再重复带 `?token=`。

### 动态请求体表达式

`models[*].body_expression` 可以在请求发往上游前动态改写最终 request body。表达式运行时会拿到变量 `body`，并且必须同步返回新的 body；执行顺序是先应用 `body` 深度合并，再执行 `body_expression`。旧字段 `bodyExpression` 仍兼容。

```yaml
models:
  - name: gpt-5.4-a
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: YOUR_KEY1
    model: openai/gpt-5.4
    body_expression: |
      ({
        ...body,
        messages: body.messages?.map((message, index) => ({
          ...message,
          content: index === 0 ? `${message.content}\nextra prompt` : message.content
        }))
      })
```

### 动态响应表达式

`models[*].response_expression` 在上游响应转换为客户端协议之前执行，只对 JSON 和 SSE 响应生效。表达式会获得 `response` 以及只读的上游响应头对象 `headers`；header 名统一为小写，例如 `headers["x-request-id"]`。`headers` 仅用于观察和校验，不会自动转发或改写客户端响应头。旧字段 `responseExpression` 仍兼容。

非流式 JSON 使用表达式返回值作为后续响应；流式响应会在向客户端发送数据前缓冲到带模型信息的启动事件。流式表达式用于观察或校验，返回值不会改写 SSE；抛出异常会终止当前候选并进入现有 fallback 流程。流式请求的响应缺少 `Content-Type` 时仍按 SSE 处理。

```yaml
models:
  - name: gpt-5.4
    provider: openai-responses
    base_url: https://example.com/v1
    api_key: YOUR_KEY
    model: gpt-5.4
    response_expression: |
      (() => {
        const actualModel = headers["x-litellm-model-name"];
        console.log("actual model:", actualModel);
        console.log("upstream request id:", headers["x-request-id"]);
        if (!actualModel?.startsWith("gpt-5.4")) {
          throw new Error(`Unexpected upstream model: ${actualModel}`);
        }
        return response;
      })()
```

### Anthropic 历史 thinking 签名

`models[*].ignore_invalid_history` 目前只影响 `provider: anthropic` 的协议转换，默认值为 `true`。当 OpenAI Chat/Responses 历史消息里的明文 reasoning 被转换到 Anthropic Messages 时，如果对应 `thinking` block 没有 `signature` 或 `signature` 为空字符串，默认会丢弃该 `thinking` block，避免 Anthropic 上游校验空签名时报错。

如果需要保留旧行为，可以显式设置为 `false`，这时无签名 thinking 会继续带着空字符串 `signature` 发往 Anthropic 上游：

```yaml
models:
  - name: claude-sonnet
    provider: anthropic
    base_url: https://example.com/v1
    api_key: YOUR_KEY
    model: claude-sonnet-4-6
    ignore_invalid_history: false
```

### OpenAI 图片接口

`provider: openai-image` 用于代理 OpenAI 图片接口，对外暴露两个入口：

- `POST /v1/images/generations` — 图片生成
- `POST /v1/images/edits` — 图片编辑（支持 `multipart/form-data` 上传）

请求会按原始内容透传给上游，nanollm 不做协议转换，只负责注入鉴权、改写 `headers`、路由和兜底。上游路径会根据入口拼成 `${base_url}/images/generations` 或 `${base_url}/images/edits`。

```yaml
models:
  - name: gpt-image-1
    provider: openai-image
    base_url: https://example.com/v1
    api_key: YOUR_KEY
    model: gpt-image-1
```

注意：

- 图片接口只能命中 `provider: openai-image` 的模型；如果请求的模型（或 fallback 分组里的候选模型）不是该 provider，会返回 `cannot handle image requests` 错误。
- 图片请求同样参与 fallback 兜底和 `/status` 健康统计，行为与文本接口一致。

### HTTP proxy

`models[*].proxy` 可以为单个模型配置请求下游供应商时使用的 HTTP proxy URL；`providers[*].proxy` 可以为引用该供应商（`custom_provider`）的所有模型配置默认 proxy：

```yaml
providers:
  - name: my-provider
    provider: anthropic
    base_url: https://example.com/v1
    api_key: YOUR_KEY
    proxy: http://127.0.0.1:7890

models:
  - name: claude-sonnet
    custom_provider: my-provider
    model: claude-sonnet-4-6
    proxy: http://127.0.0.1:7891 # optional, overrides providers[*].proxy
```

代理优先级为：

1. `models[*].proxy`
2. `providers[*].proxy`（仅对使用 `custom_provider` 的模型生效）
3. `HTTPS_PROXY`
4. `HTTP_PROXY`
5. 直连

当 `proxy` 为空字符串或未配置时，会继续回退到下一级；当前支持 `http://` 和 `https://` 代理 URL。管理页面的供应商和模型卡片中都可以直接编辑 `proxy`。

### 模型名通配符 `*`

`models[*].name` 支持后缀通配写法，可以把一类未显式配置的模型名路由到同一个上游配置：

```yaml
models:
  - name: gpt-*
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: YOUR_KEY
    model: openai/gpt-*

  - name: gpt-5.5-a
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: YOUR_KEY
    model: openai/gpt-5.5

  - name: "*"
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: YOUR_KEY
    model: fallback-model

fallback:
  gpt-5.5:
    - gpt-5.5-a
```

规则：

- `*` 必须只出现一次，并且只能放在结尾。合法例子：`gpt-*`、`claude-*`、`*`；非法例子：`gpt-*-x`、`g*p*t`、`gpt**`。
- 匹配优先级是：精确 fallback 分组名 > 精确 model 名 > 通配 model 名。
- 如果多个通配 model 都能匹配，选择 `*` 前缀最长的那个；前缀长度相同则按 `models` 配置顺序。
- 单独的 `*` 可以匹配任意请求模型名，适合作为最后兜底。
- `/v1/models` 会直接展示配置中的通配名称，例如 `gpt-*` 和 `*`。

以上面配置为例：

- 请求 `gpt-5.5`：优先命中 fallback 分组 `gpt-5.5`。
- 请求 `gpt-5.5-a`：命中同名 model `gpt-5.5-a`。
- 请求 `gpt-5.6`：没有同名分组或同名 model，于是命中 `gpt-*`。
- 请求 `llama-4`：命中最后的 `*`。

通配命中时，下游 `model` 字段里的 `*` 会被替换为请求中被 `models[*].name` 捕获的部分。例如：

- `name: gpt-*`
- 请求模型名：`gpt-5.6`
- 捕获部分：`5.6`
- `model: openai/gpt-*`
- 实际发给上游的 `model`：`openai/gpt-5.6`

如果下游 `model` 中没有 `*`，则始终使用固定模型名；如果下游 `model` 中有多个 `*`，会全部替换为同一个捕获部分。

### `openai-chat` 的图片兼容选项

`models[*].image` 目前只对 `provider: openai-chat` 生效，主要用于兼容不同 OpenAI-compatible chat 服务对图片输入的支持差异。默认值为 `true`。

- `image: true`（默认）：如果请求中包含图片，转为 chat 接口时保留 OpenAI chat 多模态 `content` 数组，例如：

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "请解释这张图" },
    { "type": "image_url", "image_url": { "url": "https://example.com/cat.png" } }
  ]
}
```

- `image: false`：用于 DeepSeek 等只接受 `content: string` 的 chat 上游；图片、文件、音频等非文本内容会降级为字符串描述，文本内容用换行拼接，例如：

```json
{
  "role": "user",
  "content": "请解释这张图\nAttached image: https://example.com/cat.png"
}
```

注意：`image: false` 当前不影响 `provider: openai-responses` 或 `provider: anthropic`，这两类上游仍按各自协议保留图片结构。

## Web 界面

### 配置管理 `/admin`

提供了 `http://localhost:3000/admin` 的本地配置管理页。

- 页面使用表单方式编辑常用配置项：全局设置、供应商、模型列表和 fallback 分组；`server.port` 仅展示当前运行值，不提供页面编辑。
- 常见使用方式是：先新增或修改供应商与模型，再调整 fallback 分组成员顺序，最后点击“保存并应用”立即生效。
- 模型卡片支持发送一条测试消息验证连通性；填写供应商地址和 Key 后可以直接拉取上游模型列表来选择模型。
- 订阅类供应商（`openai-subscription`、`claude-subscription`）在此完成登录、重新登录和用量查询。
- 页面内提供跳转到 `/status`、`/record` 的快捷入口，方便保存后继续查看当前模型状态和最近请求记录。
- 如果只是想放弃当前改动，可以点击“撤销未保存修改”；如果配置文件已被外部改动，可以点击“从服务端刷新”重新加载最新内容。
- 点击保存后会先把表单数据转换成 YAML、校验配置，再原子写回配置文件。
- `models`、`fallback`、`server.ttfb_timeout`、`record.max_size` 会立即热更新到新请求；`server.port` 和 `server.auth.token` 会写回文件，但需要重启进程后才会真正生效。
- 已有模型上未在表单中展开的高级字段会在保存时自动保留。
- 如果你在外部手动修改 `config.yaml`，服务也会自动检测并加载新配置；若新内容非法，则继续保留上一份有效配置并在管理页显示错误。

注意：`/admin` 的设计目标是本机单用户管理，不建议暴露到局域网或公网（公网部署请务必配置 `server.auth.token`）。

### 监控与用量 `/status`

`http://localhost:3000/status` 提供模型健康状态监控，页面下方还有按日统计的 token 用量（总 token、输出 token、缓存命中率及估算费用），可按最近 7 天、30 天或按年查看。

默认情况下，监控数据只存在内存中，进程结束即消失。使用 `--storage sqlite` 启动后，`/status` 会在 SQLite 中保留最近 1 个月的稀疏 5 分钟统计 bucket（页面仍只展示最近 6 小时），用量数据也会一并持久化。

### 请求记录 `/record`

`http://localhost:3000/record` 是采样记录页面，可以查看请求记录，对 debug 非常有用（默认只保留最新 10 次请求，可通过 `record.max_size` 配置修改）。记录页支持回放某次请求（客户端的敏感请求头不会被回放，供应商鉴权使用当前配置）。

请求中的 `data:image/...;base64,...` 图片会按内容哈希去重保存；记录页显示图片引用和大小，点击回放时服务会自动还原原始图片。这样多轮工具调用重复携带同一图片时，只保留一份图片数据。可复制记录中的 `__nanollm_record_image_ref` 值，并通过 `GET /record/images/{hash}` 查看原图；该接口使用与 `/record` 相同的鉴权。使用 `--storage sqlite` 时会持久化最近 `record.max_size` 条请求记录。

### 定时模型任务 `/jobs`
在 `/admin` 点击 **/jobs**，或打开 `/jobs`，新建任务、选择具体模型、填写一条用户消息及五段 cron。调度时区需要明确指定；页面可预览未来 5 次运行时间。Pelican 和简单回复是可编辑的快捷模板，不是固定的任务类型。

任务配置保存在主配置旁的 `jobs.yaml`，两种存储模式都使用这个文件。文件不存在时没有任务，首次保存时创建；手动修改会自动加载。文件格式错误时暂停后续调度并在页面提示，修复后恢复，正在运行的任务继续使用自己的配置快照。保存、启用任务不会立即调用模型；首次执行按照下一次 cron 时间，也可点击 **立即运行**。

```yaml
version: 1
jobs:
  - id: hourly-pelican
    name: 每小时 Pelican 绘图
    enabled: true
    type: model_request
    schedule:
      cron: "0 * * * *"
      timezone: Asia/Singapore
    models: [my-text-model] # config.yaml 中已保存的具体文本模型名称
    request:
      message: >
        Generate an SVG animation embedded in HTML of a pelican riding a bicycle.
        Return only the code, with no explanation.
    execution:
      timeout_ms: 300000
      overlap_policy: skip
      max_attempts: 1
      max_output_bytes: 262144
    retention:
      max_runs: 24
```

执行器按模型自身协议构造一条 user 消息并管理流式请求。模型调用直接使用所选连接，不走 fallback；目标模型为 config.yaml 中配置的文本模型（包括在其中定义的订阅模型）。模型上的 body、headers、表达式等现有覆盖配置继续生效。任务请求经过网关自身的 /v1 路由，消耗供应商额度，出现在 /record 中，并计入模型调用状态与用量统计。

- **memory（默认）**：执行记录、原始文本作品、审核标记及备注保存在内存。重启后清空，Job 配置保留。每任务默认保留最近 24 条已结束记录；全部任务历史另有 64 MiB 内存上限，达到上限时清理最旧的已结束记录。正在执行的记录不参与清理。
- **SQLite**：新增 `job_runs` 表，保留规则同样按每任务的 `max_runs` 执行，作品随记录一起保存和淘汰。重启保留历史，将未结束记录标记为 interrupted。记录按 jobs.yaml 的绝对路径隔离，使用相同路径才能恢复对应历史。

每个任务包含 1–20 个具体模型，单模型输出默认最多 256 KiB，可设置 1–1024 KiB。保留次数可设置 1–168；最多尝试 1–5 次，超时可设置 1 秒至 1 小时。输出截断或超过大小限制不自动重试，其他调用失败按照配置重试，可能产生额外费用。

第一版用于单实例部署，最多同时运行 2 个任务，同一模型连接串行调用。上次任务未结束时跳过新的定时触发；资源繁忙时，其他到期任务等待可用位置。停用只停止后续调度，取消当前运行是单独操作；重启不补停机期间的任务。

页面支持任务列表、编辑、执行历史、多模型结果、HTML/SVG 隔离预览、原始代码及历史并排对比。人工审核支持“待审核 / 正常 / 疑似异常”和备注，仅供展示，不改变路由、fallback 或调度。Pelican 作品不自动评分，调用失败单独显示。删除任务默认保留历史，也可选择同时删除记录、作品与审核信息。

## 存储

如果希望 `/status` 和 `/record` 跨进程重启保留最近数据，可以启用 SQLite 存储：
```bash
npx nanollm --config /path/to/config.yaml --storage sqlite
```

不传 `--storage` 时默认使用 `memory`，行为与旧版本一致。

当 `--storage sqlite` 且未配置远程 SQLite URL 时，会继续使用本地 SQLite 文件，路径固定为 `~/.nanollm/nanollm.sqlite3`。现有本地数据库文件可以直接复用，不需要迁移格式。

如果希望把 SQLite 存储切到远程 libSQL/quicSQL 服务，可以配置以下环境变量：

```bash
export NANOLLM_SQLITE_URL="https://your-sqlite.example.com/app/"
export NANOLLM_SQLITE_AUTH_TOKEN="your-token" # 无鉴权的内网服务可省略
npx nanollm --config /path/to/config.yaml --storage sqlite
```

URL 可以是 HTTP(S) 的 libSQL/quicSQL 服务地址，也可以不配置而使用本地文件。配置 `NANOLLM_SQLITE_URL` 后，`--storage sqlite` 会通过 HTTP 连接远程 SQLite；需要鉴权时额外设置 `NANOLLM_SQLITE_AUTH_TOKEN`。

本程序不再在正常启动流程中执行远程数据库自动迁移。需要迁移已有本地文件时，请先使用仓库中的一次性迁移脚本完成复制和校验，再配置远程 SQLite URL。

HTTP(S)/libSQL 连接每次发送正式数据库请求前，先用独立连接执行只读 `SELECT 1` 探测。
探测失败时按 1、2、4、5 秒（随后保持 5 秒）等待重试，最多 20 次，每次探测超时为 5 秒；
探测成功后立即发送正式请求。批量 SQL 整批探测一次，保持事务和批处理语义。
正式请求失败不会自动重发，避免已提交但响应丢失时重复累加统计；探测耗尽或正式写入失败会记录错误，
这不是保证最终送达的持久化任务队列。探测仅在有数据库操作时触发，不会通过后台心跳阻止休眠。
Railway 模板为 sqld 开启 Serverless，nanollm 保持常驻；查看记录和统计时也可能等待数据库唤醒。

### 数据迁移

本程序不会在正常启动流程中执行数据库自动迁移，需要迁移时请使用仓库中的一次性脚本。

**本地 SQLite 文件 → 远程 SQLite 服务**（例如之前在 Railway 上通过 volume 保存了 `nanollm.sqlite3`）：

1. 准备一个新的远程 SQLite 数据库，并拿到 URL / token（无鉴权内网服务不需要 token）。
2. 从 Railway volume 导出现有的 SQLite 文件。
3. 运行迁移脚本，把本地 SQLite 文件同步到远程服务：

```bash
npm run migrate:turso -- --from /path/to/nanollm.sqlite3
```

也可以显式传 URL / token：

```bash
npm run migrate:turso -- \
  --from /path/to/nanollm.sqlite3 \
  --url libsql://xxx-xxx.aws-ap-northeast-1.turso.io \
  --token your-token
```

脚本会复制当前库里的表结构、数据和索引，适合一次性迁入兼容的远程 SQLite 服务。完成后配置 `NANOLLM_SQLITE_URL` 和可选的 `NANOLLM_SQLITE_AUTH_TOKEN`，继续使用 `--storage sqlite` 启动即可。

**Turso → 自建 sqld / quicSQL**：使用 `npm run migrate:storage -- --help` 查看用法，流程与注意事项见 [.railway/storage-migration.md](.railway/storage-migration.md)。

## 部署

### Railway / Docker

Railway 从 Git 仓库部署时会自动使用仓库根目录的 `Dockerfile`。Docker 构建阶段会编译 Linux x64 Rust helper，最终运行镜像只包含 Node.js、nanollm 和编译好的 helper，不需要在运行容器中安装 Rust，也不依赖 GitHub Release 下载。保持启动命令为空即可使用 Dockerfile 中的默认命令；volume 挂载目录设置为 `/data`，配置和订阅登录凭据都会保存在其中。一键部署模板详见 [.railway/README.md](.railway/README.md)。

### 优雅停机

收到 `SIGTERM` / `SIGINT` 后，nanollm 停止接收新连接和后台任务，等待进行中的请求完成，超过排空期限仍未结束的流式连接会被切断，随后刷写排队中的数据库写入再退出。总超时默认 25 秒，可通过 `NANOLLM_SHUTDOWN_TIMEOUT_MS` 调整。

### 二进制打包说明
GitHub release 按平台提供压缩包。每个压缩包同时包含 nanollm 主程序和 `nanollm-oauth-transport`，解压后必须将两个可执行文件放在同一目录运行。Rust helper 用于 OpenAI subscription 的 OAuth 请求。

npm 发布包包含 Windows x64、Linux x64 和 macOS arm64 三个平台的 helper，`npx nanollm@<version>` 会根据当前平台自动选择。发布工作流会先安装生成的 tarball，确认 helper 路径可解析并完成服务健康检查；配置了仓库 secret `NPM_TOKEN` 时，验证通过的 tarball 会自动发布到 npm。直接从源码运行 `npm publish` 时也会检查三个 helper 是否齐全，避免发布残缺包。

主程序仍使用 `@yao-pkg/pkg` 的 enhanced SEA 模式构建，以兼容当前 `@libsql/client` 在本地 sqlite 模式下对 `@libsql/*` 原生包的动态加载。

`package.json` 里的 `pkg.assets` 显式包含了 `node_modules/@libsql/**/*`，让打包产物在首次运行时可以把对应平台的 `.node` 原生文件解压到本地缓存后再加载；否则独立二进制在 `--storage sqlite` 模式下会报 `Cannot find module '@libsql/<platform>'`。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `CONFIG_PATH` | 配置文件路径，等价于 `--config` |
| `PORT` | 监听端口，优先级高于配置文件里的 `server.port` |
| `LOG_LEVEL` | 日志级别：`debug`、`info`（默认）、`error` |
| `NANOLLM_SQLITE_URL` / `NANOLLM_SQLITE_AUTH_TOKEN` | 远程 libSQL/quicSQL 地址与 token，仅 `--storage sqlite` 生效 |
| `NANOLLM_SHUTDOWN_TIMEOUT_MS` | 优雅停机总超时，默认 25000 |
| `HTTPS_PROXY` / `HTTP_PROXY` | 访问下游供应商的默认代理（优先级见 HTTP proxy 一节） |

配置文件中的 `${ENV_NAME}` 写法会在加载时替换为同名环境变量。

## 项目结构

代码按功能分为 `src/core`、`converters`、`proxy`、`subscriptions`、`storage`、`jobs`、`pages` 七个模块，入口为 `server.ts`。模块职责、依赖规则与请求流程见 [docs/architecture.md](docs/architecture.md)，协议转换细节见 [docs/converters.md](docs/converters.md)。

```bash
npm install
npm run dev        # 监听源码变化启动
npm run typecheck  # 类型检查
npm test           # 运行测试
npm run build      # 构建到 dist/
```

## License

ISC
