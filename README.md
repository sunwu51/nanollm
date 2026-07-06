# nanollm

一个类似`litellm`的llm模型代理服务，主打一个轻量和本地化，适合个人本地聚合多个模型的场景。

支持的功能：
- 1 可以配置`chat/completions`(下面称chat)、`responses`、`messages`三种文本接口，以及 OpenAI 图片`images/generations`和`images/edits`接口（暂不支持google接口）的模型供应商，并且同时对外暴露这些接口，带`/v1`前缀。
- 2 可以配置修改请求中的`headers`和`body`，传自定义数据，其中`body`支持深度合并。
- 3 可以配置兜底方案，设置兜底分组，如果调用的模型下游接口失败，并且在某个分组中，则会尝试分组其他模型。
- 4 支持配置文件热更新和本地管理页：`models`、`fallback`、`server.ttfb_timeout`、`record.max_size` 保存后立即生效，`server.port` 和 `server.auth.token` 写回后需重启进程。

## Configure

Example:

```yaml
server:
  port: 3000 # default 3000
  ttfb_timeout: 5000 # optional, upstream first-byte timeout in ms

record:
  max_size: 100 # optional, default 10

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
    proxy: http://127.0.0.1:7890 # optional, overrides HTTPS_PROXY/HTTP_PROXY for this model
    headers:
      user-agent: nanollm
    body:
      temperature: 1
      store: false
      text: '{"verbosity":"high"}'
    bodyExpression: |
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

fallback:
  gpt-5.4:
    - gpt-5.4-a
    - gpt-5.4-b
    - glm5.1
```
Run the proxy server:
```bash
npx nanollm --config /path/to/config.yaml
```

对外提供的模型为所有`models[i].name`和`fallback.[group_name]`例如上面demo配置就提供了
```
gpt-5.4-a
gpt-5.4-b
glm5.1
claude-sonnet-4-6
gpt-image-1
gpt-5.4
```
这样6个模型，其中`gpt-5.4`是兜底分组名，当使用这个模型的时候，会在下属列表的模型中寻找可用的模型，尝试顺序为按`max(0, 最近5min失败次数-1)`升序；如果分数相同，则保持配置里的原始顺序。

### Bearer Key 认证

如果你希望给整个 nanollm 网关加一层访问认证，可以配置：

```yaml
server:
  auth:
    token: ${NANOLLM_AUTH_TOKEN}
```

- `server.auth.token` 为空或不配置时，认证关闭。
- 运行中，修改 `server.auth.token` 会写回配置文件，但和 `server.port` 一样需要重启进程后才会真正生效。
- 一旦配置，除了 `/health` 以外，其余入口都要求认证，包括 `/`、`/status`、`/record`、`/admin`、`/v1/models` 和 `/v1/*`。
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
```

首次用 `?token=` 或 Bearer header 认证成功后，nanollm 会写入同源认证 cookie。之后同一浏览器里直接访问 `/admin`、`/status`、`/record`，以及这些页面内部的 `fetch` 请求，都不需要再重复带 `?token=`。

### 动态请求体表达式

`models[*].bodyExpression` 可以在请求发往上游前动态改写最终 request body。表达式运行时会拿到变量 `body`，并且必须同步返回新的 body；执行顺序是先应用 `body` 深度合并，再执行 `bodyExpression`。

```yaml
models:
  - name: gpt-5.4-a
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: YOUR_KEY1
    model: openai/gpt-5.4
    bodyExpression: |
      ({
        ...body,
        messages: body.messages?.map((message, index) => ({
          ...message,
          content: index === 0 ? `${message.content}\nextra prompt` : message.content
        }))
      })
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

### 模型级 HTTP proxy

`models[*].proxy` 可以为单个模型配置请求下游供应商时使用的 HTTP proxy URL：

```yaml
models:
  - name: claude-sonnet
    provider: anthropic
    base_url: https://example.com/v1
    api_key: YOUR_KEY
    model: claude-sonnet-4-6
    proxy: http://127.0.0.1:7890
```

代理优先级为：

1. `models[*].proxy`
2. `HTTPS_PROXY`
3. `HTTP_PROXY`
4. 直连

当 `proxy` 为空字符串或未配置时，会继续回退到环境变量；当前支持 `http://` 和 `https://` 代理 URL。

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

也可以指定配置文件运行：
```bash
npx nanollm --config /path/to/config.yaml
```

如果希望 `/status` 和 `/record` 跨进程重启保留最近数据，可以启用 SQLite 存储：
```bash
npx nanollm --config /path/to/config.yaml --storage sqlite
```

不传 `--storage` 时默认使用 `memory`，行为与旧版本一致。

当 `--storage sqlite` 且未配置 Turso 时，会继续使用本地 SQLite 文件，路径固定为 `~/.nanollm/nanollm.sqlite3`。现有本地数据库文件可以直接复用，不需要迁移格式。

如果希望把 SQLite 存储切到 Turso，可以配置以下环境变量：

```bash
export NANOLLM_TURSO_DATABASE_URL="libsql://xxx-xxx.aws-ap-northeast-1.turso.io"
export NANOLLM_TURSO_AUTH_TOKEN="your-token"
npx nanollm --config /path/to/config.yaml --storage sqlite
```

也兼容 Turso 默认变量名 `TURSO_DATABASE_URL` 和 `TURSO_AUTH_TOKEN`。只要 URL 配好了，`--storage sqlite` 就会优先走 Turso；未配置时自动回退到本地文件模式。

如果希望在第一次切到 Turso 时自动把本地 SQLite 文件导入过去，可以额外设置：

```bash
export NANOLLM_TURSO_AUTO_MIGRATE_FROM="$HOME/.nanollm/nanollm.sqlite3"
```

这个开关只在当前实际连接的是 Turso 时生效。服务启动时会先执行一次导入，再继续启动；同一个源路径的自动迁移完成后会在目标库里记完成标记，后续重启不会重复导入。

如果当前目录就有 `config.yaml`，也可以直接运行：
```bash
npx nanollm
```

注意：npm 发布包不会包含作者本地的 `config.yaml`，需要你自己准备配置文件。


## Config Admin

提供了 `http://localhost:3000/admin` 的本地配置管理页。

- 页面使用表单方式编辑常用配置项：全局设置、模型列表和 fallback 分组；`server.port` 仅展示当前运行值，不提供页面编辑。
- 常见使用方式是：先在 `/admin` 中新增或修改模型，再调整 fallback 分组成员顺序，最后点击“保存并应用”立即生效。
- 页面内提供跳转到 `/status` 和 `/record` 的快捷入口，方便保存后继续查看当前模型状态和最近请求记录。
- 如果只是想放弃当前改动，可以点击“撤销未保存修改”；如果配置文件已被外部改动，可以点击“从服务端刷新”重新加载最新内容。
- 点击保存后会先把表单数据转换成 YAML、校验配置，再原子写回配置文件。
- `models`、`fallback`、`server.ttfb_timeout`、`record.max_size` 会立即热更新到新请求。
- `server.port` 和 `server.auth.token` 会写回文件，但需要重启进程后才会真正生效。
- 已有模型上未在表单中展开的高级字段会在保存时自动保留。
- 如果你在外部手动修改 `config.yaml`，服务也会自动检测并加载新配置；若新内容非法，则继续保留上一份有效配置并在管理页显示错误。

注意：`/admin/config` 设计目标是本机单用户管理，不建议暴露到局域网或公网。

## Monitor

提供了`http://localhost:3000/status`的监控页面，可以查看模型健康状态。

提供了`http://localhost:3000/record`的采样记录页面，可以查看请求记录，对debug非常有用（默认只保留最新10次请求，可通过`record.max_size`配置修改）。

默认情况下，上述数据都只存在内存中，进程结束即消失。使用 `--storage sqlite` 启动后，`/status` 会在 SQLite 中保留最近 1 个月的稀疏 5 分钟统计 bucket（页面仍只展示最近 6 小时），`/record` 会持久化最近 `record.max_size` 条请求记录。

### Turso Migration

如果你之前在 Railway 上通过 volume 保存了 `nanollm.sqlite3`，推荐迁移流程是：

1. 先在 Turso 创建一个新的空数据库，并拿到 URL / token。
2. 从 Railway volume 导出现有的 SQLite 文件。
3. 运行迁移脚本，把本地 SQLite 文件同步到 Turso：

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

脚本会复制当前库里的表结构、数据和索引，适合把现有 Railway volume 数据一次性迁入新的 Turso 库。完成后，只需要在 Railway 配置上面的 Turso 环境变量，并继续使用 `--storage sqlite` 启动即可，不再依赖 volume。

如果你更想在服务第一次连上 Turso 时自动导入，也可以在 Railway 额外配置：

```bash
NANOLLM_TURSO_AUTO_MIGRATE_FROM=/data/.nanollm/nanollm.sqlite3
```

建议首次切换完成后移除这个环境变量，虽然代码会根据完成标记跳过重复导入，但运维上更清晰。
