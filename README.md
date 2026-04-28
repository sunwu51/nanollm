# nanollm

一个类似`litellm`的llm模型代理服务，主打一个轻量和本地化，适合个人本地聚合多个模型的场景。

支持的功能：
- 1 可以配置`chat/completions`(下面称chat), `responses`和`messages`三种接口（暂不支持google接口）的模型供应商，并且同时对外暴露这三种接口，带`/v1`前缀。
- 2 可以配置修改请求中的`headers`和`body`，传自定义数据，其中`body`支持深度合并。
- 3 可以配置兜底方案，设置兜底分组，如果调用的模型下游接口失败，并且在某个分组中，则会尝试分组其他模型。
- 4 支持配置文件热更新和本地管理页：`models`、`fallback`、`server.ttfb_timeout`、`record.max_size` 保存后立即生效，`server.port` 写回后需重启进程。

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
    headers:
      user-agent: nanollm
    body:
      temperature: 1
      store: false
      text: '{"verbosity":"high"}'
  
  - name: claude-sonnet-4-6
    # messages规范
    provider: anthropic
    base_url: https://example.com/v1
    api_key: ${YOUR_KEY3_FROM_ENV_VAR}
    model: claude-sonnet-4-6

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
gpt-5.4
```
这样5个模型，其中`gpt-5.4`是兜底分组名，当使用这个模型的时候，会在下属列表的模型中寻找可用的模型，尝试顺序为按`max(0, 最近5min失败次数-1)`升序；如果分数相同，则保持配置里的原始顺序。

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
- `server.port` 会写回文件，但需要重启进程后才会真正生效。
- 已有模型上未在表单中展开的高级字段会在保存时自动保留。
- 如果你在外部手动修改 `config.yaml`，服务也会自动检测并加载新配置；若新内容非法，则继续保留上一份有效配置并在管理页显示错误。

注意：`/admin/config` 设计目标是本机单用户管理，不建议暴露到局域网或公网。

## Monitor

提供了`http://localhost:3000/status`的监控页面，可以查看模型健康状态。

提供了`http://localhost:3000/record`的采样记录页面，可以查看请求记录，对debug非常有用（默认只保留最新10次请求，可通过`record.max_size`配置修改）。

上述数据都只存在内存中，进程结束即消失，作为一个超轻量工具，没有任何持久化存储。
