# nanollm

一个类似`litellm`的llm模型代理服务，主打一个轻量和本地化，适合个人本地聚合多个模型的场景。

支持的功能：
- 1 可以配置`chat/completions`(下面称chat), `responses`和`messages`三种接口（暂不支持google接口）的模型供应商，并且同时对外暴露这三种接口，带`/v1`前缀。
- 2 可以配置修改请求中的`headers`和`body`，传自定义数据，其中`body`支持深度合并。
- 3 可以配置兜底方案，设置兜底分组，如果调用的模型下游接口失败，并且在某个分组中，则会尝试分组其他模型。

## Configure

Example:

```yaml
server:
  port: 3000 # default 3000
  ttfb_timeout: 5000 # optional, upstream first-byte timeout in ms

models:
  - name: gpt-5.4
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
  primary-group:
    - gpt-5.4
    - claude-sonnet-4-6
    - glm5.1
```
Run the proxy server:
```bash
npx nanollm --config /path/to/config.yaml
```

如果当前目录就有 `config.yaml`，也可以直接运行：
```bash
npx nanollm
```

注意：npm 发布包不会包含作者本地的 `config.yaml`，需要你自己准备配置文件。
