<div align="center">

<img src="assets/logo.svg" alt="nanollm" width="96" height="96" />

# nanollm

**A lightweight, local-first LLM gateway: one endpoint for all your model providers**

Compatible with OpenAI Chat / Responses, Anthropic Messages and the OpenAI image API, with fallback groups, Codex / Claude subscriptions, usage statistics and scheduled model jobs.

[![npm version](https://img.shields.io/npm/v/nanollm?color=7c5cff)](https://www.npmjs.com/package/nanollm)
[![npm downloads](https://img.shields.io/npm/dm/nanollm?color=14b8a6)](https://www.npmjs.com/package/nanollm)
[![license](https://img.shields.io/npm/l/nanollm)](package.json)
[![GitHub stars](https://img.shields.io/github/stars/sunwu51/nanollm?style=social)](https://github.com/sunwu51/nanollm)

**English** · [简体中文](README-cn.md)

[Features](#features) · [Quick start](#quick-start) · [Full config](#full-configuration-example) · [Web UI](#web-ui) · [Deployment](#deployment) · [Architecture](docs/architecture.md)

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/nanollm)

</div>

---

nanollm is a `litellm`-like proxy for LLM APIs. It stays small and runs locally, which makes it a good fit for aggregating several model providers on your own machine.

## Features

- **Multiple protocols**: configure providers for `chat/completions` (chat), `responses` and `messages` text APIs plus the OpenAI image APIs (`images/generations`, `images/edits`), and expose all of them under the `/v1` prefix. The three text protocols are converted into each other; see [docs/converters.md](docs/converters.md). Google APIs are not supported yet.
- **Request rewriting**: modify request `headers` and `body` (the body is deep-merged), or use `body_expression` / `response_expression` for dynamic rewriting.
- **Fallback groups**: if the model you call fails upstream and belongs to a fallback group, the other members of the group are tried.
- **Subscription providers**: use an OpenAI Codex subscription or a Claude Pro/Max subscription as a provider after logging in from the admin page.
- **Hot reload and admin page**: `/admin` is a form-based config editor with model connectivity tests and upstream model listing. `models`, `fallback`, `server.ttfb_timeout` and `record.max_size` apply immediately after saving; `server.port` and `server.auth.token` are written back and need a restart.
- **Monitoring and usage**: `/status` shows model health and daily token usage; `/record` keeps recent requests and can replay them, which is very useful for debugging.
- **Scheduled model jobs**: `/jobs` calls several models on a cron schedule, stores the outputs, and supports history comparison and manual review.
- **Optional persistence**: in-memory by default; `--storage sqlite` uses a local SQLite file or a remote libSQL/quicSQL service.
- **Security and operations**: optional Bearer key auth, graceful shutdown on SIGTERM/SIGINT, Docker / Railway deployment and per-platform binaries.

## Quick start

**1. Create a minimal config.** Create `config.yaml` with just a port. No providers or models are needed up front:

```yaml
server:
  port: 3000
```

**2. Start it.**

```bash
npx nanollm@latest --config /path/to/config.yaml
```

If there is a `config.yaml` in the current directory you can simply run `npx nanollm`; the path can also be set with the `CONFIG_PATH` environment variable. The npm package does not ship a config file, so you need to create your own.

**3. Configure in the admin page.** Open `http://localhost:3000/admin` and add providers, models, fallback groups and so on. Clicking "Save and apply" takes effect immediately and **writes the result back to `config.yaml`**, so you never have to edit the file by hand (hand edits are still picked up automatically). Before exposing the service beyond your machine, set up [Bearer key authentication](#bearer-key-authentication).

**4. Call it.** Once models are configured they are available through these endpoints:

| Endpoint | Description |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat API |
| `POST /v1/responses` | OpenAI Responses API |
| `POST /v1/messages` | Anthropic Messages API |
| `POST /v1/images/generations`, `/v1/images/edits` | OpenAI image APIs (passed through as is) |
| `POST /v1/alpha/search` (and `/alpha/search`) | Codex alpha search passthrough; only the `model` field is rewritten and expressions do not apply |
| `GET /v1/models` | Models exposed by the gateway |
| `/admin`, `/status`, `/record`, `/jobs` | Config admin, monitoring and usage, request records, scheduled jobs |
| `GET /health` | Health check (never requires auth) |

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"glm5.1","messages":[{"role":"user","content":"hello"}]}'
```

## Full configuration example

Beyond the minimal config above, every option can be written in `config.yaml` (and edited in `/admin`). Below is a full example covering the common scenarios; you do not need to copy it all, just take what you need:

```yaml
server:
  port: 3000 # default 3000
  ttfb_timeout: 5000 # optional, upstream first-byte timeout in ms

record:
  max_size: 100 # optional, default 10

providers:
  # Shared provider: keeps protocol, URL and API key in one place.
  # You can also skip providers and set base_url and api_key on each model.
  - name: deepseek
    provider: openai-chat
    base_url: https://api.deepseek.com/v1
    api_key: ${DEEPSEEK_API_KEY}

  # OpenAI Codex subscription: no base_url or api_key
  - name: codex-subscription
    provider: openai-subscription

  # Claude Pro/Max subscription: no base_url or api_key, log in from /admin
  - name: claude-subscription
    provider: claude-subscription

models:
  - name: gpt-5.4-a
    # responses protocol
    provider: openai-responses
    base_url: https://example.com/v1
    api_key: YOUR_KEY1
    model: openai/gpt-5.4

  - name: gpt-5.4-b
    provider: openai-responses
    base_url: https://example.com/v1
    api_key: YOUR_KEY1
    model: openai/gpt-5.4

  - name: glm5.1
    # chat/completions protocol
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
    # messages protocol
    provider: anthropic
    base_url: https://example.com/v1
    api_key: ${YOUR_KEY3_FROM_ENV_VAR}
    model: claude-sonnet-4-6
    ignore_invalid_history: true # optional, default true; drop thinking blocks with an empty signature when converting to Anthropic

  - name: gpt-image-1
    # OpenAI image API (images/generations, images/edits)
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

The models exposed by the gateway are every `models[i].name` plus every fallback group name. The example above exposes eight models:

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

`gpt-5.4` is a fallback group. When it is requested, the members are tried in ascending order of `max(0, failures in the last 5 minutes - 1)`; members with the same score keep their configured order. Values written as `${ENV_NAME}` are replaced with the environment variable of the same name when the config is loaded.

## Configuration guide

### Shared providers

When several models use the same protocol, upstream URL and API key, define them once under top-level `providers` and reference them with `models[*].custom_provider`:

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

`providers[*].name` must be unique and referenced providers must exist. A model with `custom_provider` must not also set `provider`, `base_url` or `api_key`; those fields are expanded from the provider at runtime. All other model fields work as usual. Ordinary shared providers support `openai-chat`, `openai-responses`, `anthropic` and `openai-image`.

### OpenAI subscription

A Codex subscription can only be declared under top-level `providers`, not as a model's `provider`:

```yaml
providers:
  - name: my-codex-subscription
    provider: openai-subscription

models:
  - name: gpt-subscription
    custom_provider: my-codex-subscription
    model: gpt-5
```

`openai-subscription` accepts neither `base_url` nor `api_key`. After saving the config, expand the provider in `/admin`, click "Login" and finish the Device Code flow shown on the page. Once logged in, the page shows "logged in" with "Re-login" and "Query usage" actions.

Credentials are stored as plain JSON in `<directory of config.yaml>/openai-subscription/<uuid>.json` (access token, refresh token, expiry, account ID, provider name). nanollm refreshes the token before it expires and updates the file, so restrict access to that directory and keep it on persistent storage. On Railway with `/data/config.yaml`, the credentials live in `/data/openai-subscription/<uuid>.json`; mounting a volume at `/data` keeps both the config and the login state.

Codex subscription requests pass through the client's `originator` and `User-Agent` when both are present; otherwise a matching pair of Codex CLI defaults is used. These defaults live in `src/subscriptions/subscription-client-compat.ts`; edit that file when upgrading the compatible version.

### Claude subscription

Claude Pro / Max subscriptions are also declared under `providers`, referenced through `custom_provider`, and called with the Anthropic Messages protocol (`/v1/messages`):

```yaml
providers:
  - name: my-claude-subscription
    provider: claude-subscription

models:
  - name: claude-sonnet-subscription
    custom_provider: my-claude-subscription
    model: claude-sonnet-4-5
```

`claude-subscription` accepts neither `base_url` nor `api_key`. Claude has no Device Code flow: after saving, expand the provider in `/admin`, click "Login", and authorize on the Claude page that opens. The browser then redirects to `https://platform.claude.com/oauth/code/callback?code=...&state=...`; paste the full URL (or the `code#state` value shown on that page) back into the dialog and click "Complete login". A login session is valid for 10 minutes. After login, the page offers "Re-login" and "Query usage" (5-hour and 7-day window utilization).

Credentials are stored as plain JSON in `<directory of config.yaml>/claude-subscription/<uuid>.json` (access token, refresh token, expiry, scopes, subscription type, account email) and refreshed 5 minutes before expiry. Requests use `Authorization: Bearer` and mimic Claude Code headers: `anthropic-beta` always includes `oauth-2025-04-20` and `claude-code-20250219` (merged with the client's betas); missing `Accept`, `User-Agent`, `x-app`, `x-stainless-*` and `anthropic-dangerous-direct-browser-access` get defaults, streaming requests add `x-stainless-helper-method: stream`, and every request without `x-client-request-id` gets a fresh UUID. Client headers and the model's `headers` override these defaults. If the client did not send `x-claude-code-session-id`, the gateway derives a per-UTC-day stable value from the first address in `x-forwarded-for` (or `x-real-ip`, `cf-connecting-ip`); the IP is only hashed with SHA-256.

When the request has no billing system block, a text block `x-anthropic-billing-header: cc_version=<CLI version>.<fingerprint>; cc_entrypoint=cli;` is prepended to `system`. The fingerprint is computed from the first user message, and the CLI version comes from the outgoing `claude-cli/*` User-Agent or the default version; `cch` is never added. The compatible Claude Code and Codex CLI identities are kept in `src/subscriptions/subscription-client-compat.ts`.

### Bearer key authentication

To protect the whole gateway, configure:

```yaml
server:
  auth:
    token: ${NANOLLM_AUTH_TOKEN}
```

- An empty or missing `server.auth.token` disables authentication.
- Changing `server.auth.token` from the admin page writes it back to the file but, like `server.port`, only takes effect after a restart.
- Once set, every entry except `/health` requires authentication: `/`, `/status`, `/record`, `/admin`, `/jobs`, `/v1/models` and `/v1/*`.
- Authentication only protects access to nanollm. It does not replace `models[*].api_key` and is never forwarded to upstream providers.

API clients use a standard Bearer header, so with the OpenAI SDK or any compatible client just use the token as the API key:

```bash
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer $NANOLLM_AUTH_TOKEN"
```

In a browser you can authenticate once through a URL token:

```text
http://localhost:3000/admin?token=YOUR_TOKEN
http://localhost:3000/status?token=YOUR_TOKEN
http://localhost:3000/record?token=YOUR_TOKEN
http://localhost:3000/jobs?token=YOUR_TOKEN
```

After the first successful `?token=` or Bearer authentication, nanollm sets a same-origin auth cookie, so later visits to `/admin`, `/status`, `/record` and `/jobs`, and the `fetch` calls made by those pages, no longer need `?token=`.

### Dynamic request body expression

`models[*].body_expression` rewrites the final request body before it is sent upstream. The expression receives `body` and must synchronously return the new body. The `body` deep merge is applied first, then `body_expression`. The legacy `bodyExpression` field is still accepted.

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

### Dynamic response expression

`models[*].response_expression` runs before the upstream response is converted to the client protocol and only applies to JSON and SSE responses. It receives `response` and a read-only object `headers` with the upstream response headers (names are lower-cased, e.g. `headers["x-request-id"]`). `headers` is for observation and validation only; it is never forwarded or used to rewrite client headers. The legacy `responseExpression` field is still accepted.

For non-streaming JSON the return value becomes the response. Streaming responses are buffered until the startup event that carries the model information; streaming expressions are for observation or validation only, their return value does not rewrite the SSE stream, and a thrown error aborts the current candidate and enters the normal fallback flow. A streaming response without a `Content-Type` is still treated as SSE.

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

### Anthropic history thinking signatures

`models[*].ignore_invalid_history` only affects `provider: anthropic` conversions and defaults to `true`. When plain-text reasoning from OpenAI Chat/Responses history is converted to Anthropic Messages and the resulting `thinking` block has a missing or empty `signature`, the block is dropped by default so the Anthropic upstream does not reject the empty signature. Set it to `false` to keep the old behavior and send such blocks with an empty-string `signature`:

```yaml
models:
  - name: claude-sonnet
    provider: anthropic
    base_url: https://example.com/v1
    api_key: YOUR_KEY
    model: claude-sonnet-4-6
    ignore_invalid_history: false
```

### OpenAI image API

`provider: openai-image` proxies the OpenAI image API and exposes two endpoints:

- `POST /v1/images/generations`: image generation
- `POST /v1/images/edits`: image editing (supports `multipart/form-data` uploads)

Requests are passed through unchanged; nanollm does no protocol conversion and only injects authentication, rewrites `headers`, routes and falls back. The upstream URL is `${base_url}/images/generations` or `${base_url}/images/edits`.

```yaml
models:
  - name: gpt-image-1
    provider: openai-image
    base_url: https://example.com/v1
    api_key: YOUR_KEY
    model: gpt-image-1
```

- Image endpoints can only hit models with `provider: openai-image`. If the requested model (or a candidate in its fallback group) is not of that provider, a `cannot handle image requests` error is returned.
- Image requests take part in fallback and in the `/status` health statistics just like text requests.

### HTTP proxy

`models[*].proxy` sets the HTTP proxy URL used to reach the upstream for one model, and `providers[*].proxy` sets a default for all models that reference the provider through `custom_provider`:

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

Priority: `models[*].proxy` > `providers[*].proxy` (only for models using `custom_provider`) > `HTTPS_PROXY` > `HTTP_PROXY` > direct connection. An empty or missing `proxy` falls through to the next level. `http://` and `https://` proxy URLs are supported, and `proxy` can be edited on the provider and model cards in the admin page.

### Wildcard model names

`models[*].name` supports a trailing wildcard, which routes a family of unlisted model names to one upstream config:

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

Rules:

- `*` must appear exactly once and only at the end. Valid: `gpt-*`, `claude-*`, `*`. Invalid: `gpt-*-x`, `g*p*t`, `gpt**`.
- Match priority: exact fallback group name > exact model name > wildcard model name.
- If several wildcard models match, the one with the longest prefix before `*` wins; equal prefixes follow the order in `models`.
- A lone `*` matches any requested model name, which makes it a good last resort.
- `/v1/models` lists the wildcard names as configured, such as `gpt-*` and `*`.

With the config above: `gpt-5.5` hits the fallback group, `gpt-5.5-a` hits the model of the same name, `gpt-5.6` hits `gpt-*`, and `llama-4` hits `*`.

On a wildcard hit, every `*` in the upstream `model` is replaced with the part captured by `name`. For `name: gpt-*`, request `gpt-5.6` and `model: openai/gpt-*`, the upstream model is `openai/gpt-5.6`. Without a `*` in `model` the fixed name is always used.

### Image compatibility option for `openai-chat`

`models[*].image` only applies to `provider: openai-chat` and smooths over differences in image input support between OpenAI-compatible chat services. It defaults to `true`.

- `image: true` (default): requests containing images keep the OpenAI chat multimodal `content` array:

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "Explain this picture" },
    { "type": "image_url", "image_url": { "url": "https://example.com/cat.png" } }
  ]
}
```

- `image: false`: for upstreams such as DeepSeek that only accept `content: string`. Images, files, audio and other non-text content are downgraded to text descriptions and joined with newlines:

```json
{
  "role": "user",
  "content": "Explain this picture\nAttached image: https://example.com/cat.png"
}
```

`image: false` does not affect `openai-responses` or `anthropic` upstreams, which keep image structures in their own protocols.

## Web UI

### Config admin: `/admin`

A local configuration page at `http://localhost:3000/admin`.

- Edit the common settings with forms: global settings, providers, models and fallback groups. `server.port` is shown read-only.
- Typical flow: add or edit providers and models, arrange the fallback group members, then click "Save and apply".
- Each model card can send a test message to verify connectivity, and after entering a provider URL and key you can fetch the upstream model list to pick models from.
- Subscription providers (`openai-subscription`, `claude-subscription`) are logged in, re-logged in and queried for usage here.
- Shortcuts lead to `/status` and `/record` so you can check model health and recent requests after saving.
- "Discard unsaved changes" drops your edits; "Refresh from server" reloads the file if it was changed externally.
- Saving converts the form into YAML, validates it and writes the config file atomically.
- `models`, `fallback`, `server.ttfb_timeout` and `record.max_size` hot-reload for new requests; `server.port` and `server.auth.token` are written back but need a restart.
- Advanced fields on existing models that are not shown in the form are preserved on save.
- If you edit `config.yaml` by hand, nanollm detects and loads the change. Invalid content is rejected: the last valid config stays active and the error is shown in the admin page.

Note: `/admin` is designed for single-user local management. Do not expose it to a LAN or the public internet without setting `server.auth.token`.

### Monitoring and usage: `/status`

`http://localhost:3000/status` shows model health. Below it is a daily token usage view (total tokens, output tokens, cache hit rate and estimated cost) that can be switched between the last 7 days, 30 days and a calendar year.

By default this data lives in memory and disappears when the process exits. With `--storage sqlite`, `/status` keeps one month of sparse 5-minute buckets in SQLite (the page still shows the last 6 hours) and usage data is persisted as well.

### Request records: `/record`

`http://localhost:3000/record` lists sampled requests and is very useful for debugging. By default only the latest 10 requests are kept; change it with `record.max_size`. A recorded request can be replayed (sensitive client headers are not replayed, and provider authentication uses the current config).

Images in requests (`data:image/...;base64,...`) are stored once per content hash. The record page shows image references and sizes, and replay restores the original images, so a multi-turn tool conversation that keeps carrying the same image stores it only once. Copy a `__nanollm_record_image_ref` value and open `GET /record/images/{hash}` to view the original; that endpoint uses the same authentication as `/record`. With `--storage sqlite` the latest `record.max_size` records are persisted.

### Scheduled model jobs: `/jobs`

Open `/jobs` (or click **/jobs** in `/admin`), create a job, pick concrete models, enter one user message and a five-field cron expression. The schedule time zone must be explicit, and the page previews the next 5 run times. "Pelican" and "simple reply" are editable templates, not fixed job types.

Job config is saved in `jobs.yaml` next to the main config and is used by both storage modes. Without the file there are no jobs; it is created on first save, and manual edits are reloaded automatically. If the file is malformed, scheduling is paused and the page shows the error until it is fixed; running jobs keep using their own config snapshot. Saving or enabling a job does not call a model immediately: the first run happens at the next cron time, or click **Run now**.

```yaml
version: 1
jobs:
  - id: hourly-pelican
    name: Hourly pelican drawing
    enabled: true
    type: model_request
    schedule:
      cron: "0 * * * *"
      timezone: Asia/Singapore
    models: [my-text-model] # concrete text model names saved in config.yaml
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

The executor builds one user message in each model's own protocol and manages the streaming request. Calls use the selected connection directly and do not go through fallback. Configured text models and models from the OpenAI and Claude subscription catalogs are supported; subscription models do not need to be added to config.yaml, and catalog loading errors are shown in the form. Existing per-model overrides (body, headers, expressions) still apply. Job requests consume provider quota and count towards model call status and usage statistics.

- **memory (default)**: runs, raw text outputs, review marks and notes are kept in memory and cleared on restart (job config is kept). By default the latest 24 finished runs per job are kept; all job history also shares a 64 MiB memory cap, and when it is reached the oldest finished runs are dropped. Running runs are never evicted.
- **SQLite**: adds a `job_runs` table. Retention follows each job's `max_runs`, and outputs are stored and evicted together with their runs. History survives restarts, and unfinished runs are marked `interrupted`. Records are isolated by the absolute path of `jobs.yaml`, so history is only restored when the same path is used.

Each job has 1–20 concrete models. Output per model defaults to at most 256 KiB (configurable from 1 to 1024 KiB), retention can be 1–168 runs, attempts 1–5, and the timeout from 1 second to 1 hour. Truncated or oversized output is not retried automatically; other call failures are retried as configured, which may cost extra.

The first version targets single-instance deployments: at most 2 jobs run at the same time, and calls to one model connection are serialized. If the previous run of a job has not finished, the new scheduled trigger is skipped; when resources are busy, other due jobs wait for a free slot. Disabling a job only stops future scheduling (cancelling the current run is a separate action), and runs missed during downtime are not made up.

The page offers a job list, editing, run history, multi-model results, sandboxed HTML/SVG preview, raw code, and side-by-side comparison with earlier runs. Manual review supports "unreviewed / normal / suspect" plus a note; it is for display only and does not change routing, fallback or scheduling. Pelican outputs are not scored automatically and call failures are shown separately. Deleting a job keeps its history by default, or you can delete the runs, outputs and reviews with it.

## Storage

Without `--storage` the default is `memory`: `/status`, usage and `/record` data is lost when the process exits. To keep recent data across restarts, enable SQLite:

```bash
npx nanollm --config /path/to/config.yaml --storage sqlite
```

With `--storage sqlite` and no remote SQLite URL, a local SQLite file at `~/.nanollm/nanollm.sqlite3` is used. An existing local database file can be reused as is; no format migration is needed.

To store data in a remote libSQL/quicSQL service instead, set these environment variables:

```bash
export NANOLLM_SQLITE_URL="https://your-sqlite.example.com/app/"
export NANOLLM_SQLITE_AUTH_TOKEN="your-token" # can be omitted for an unauthenticated private service
npx nanollm --config /path/to/config.yaml --storage sqlite
```

The URL is the address of an HTTP(S) libSQL/quicSQL service. Before every real database request over HTTP(S)/libSQL, nanollm first runs a read-only `SELECT 1` probe on a separate connection. A failed probe is retried after 1, 2, 4 and then 5 seconds (staying at 5 seconds) up to 20 times, with a 5-second timeout per probe, and the real request is sent as soon as a probe succeeds. A batch of SQL statements is probed once as a whole, keeping transaction and batch semantics. A failed real request is never resent automatically, to avoid double counting when a write was committed but its response was lost. Exhausted probes or failed writes are logged; this is not a durable delivery queue. Probes only run when there is a database operation, so no background heartbeat keeps the database awake. The Railway template enables Serverless for sqld while nanollm stays running, so viewing records and statistics may wait for the database to wake up.

### Data migration

Normal startup never migrates databases. Use the one-off scripts in the repository when you need to move data.

**Local SQLite file → remote SQLite service** (for example a `nanollm.sqlite3` that used to live on a Railway volume):

1. Prepare a new remote SQLite database and get its URL and token (no token is needed for an unauthenticated private service).
2. Export the existing SQLite file from the Railway volume.
3. Run the migration script:

```bash
npm run migrate:turso -- --from /path/to/nanollm.sqlite3
```

or pass the URL and token explicitly:

```bash
npm run migrate:turso -- \
  --from /path/to/nanollm.sqlite3 \
  --url libsql://xxx-xxx.aws-ap-northeast-1.turso.io \
  --token your-token
```

The script copies tables, data and indexes, which suits a one-time move into a compatible remote service. Afterwards set `NANOLLM_SQLITE_URL` (and optionally `NANOLLM_SQLITE_AUTH_TOKEN`) and keep starting with `--storage sqlite`.

**Turso → self-hosted sqld / quicSQL**: run `npm run migrate:storage -- --help`; the procedure and caveats are in [.railway/storage-migration.md](.railway/storage-migration.md).

## Deployment

### Railway / Docker

Railway builds from the repository's root `Dockerfile` automatically. The Docker build compiles the Linux x64 Rust helper, and the final image only contains Node.js, nanollm and the compiled helper, so Rust is not needed at runtime and nothing is downloaded from GitHub Releases. Leave the start command empty to use the Dockerfile default, and mount a volume at `/data`, which holds both the config and subscription login credentials. The one-click template is described in [.railway/README.md](.railway/README.md).

### Graceful shutdown

On `SIGTERM` / `SIGINT`, nanollm stops accepting new connections and background work, waits for in-flight requests, cuts streaming connections that are still open after the drain deadline, and flushes queued database writes before exiting. The overall timeout defaults to 25 seconds and can be changed with `NANOLLM_SHUTDOWN_TIMEOUT_MS`.

### Binary packages

GitHub releases ship one archive per platform. Each archive contains the nanollm executable and `nanollm-oauth-transport`; after extracting, keep both executables in the same directory. The Rust helper performs the OAuth requests for OpenAI subscriptions.

The npm package bundles helpers for Windows x64, Linux x64 and macOS arm64, and `npx nanollm@<version>` picks the one for the current platform. The release workflow installs the generated tarball, checks that the helper path resolves and that the service passes a health check, and publishes the verified tarball to npm when the repository secret `NPM_TOKEN` is set. Running `npm publish` from source also checks that all three helpers are present so an incomplete package is never published.

The main program is still built with `@yao-pkg/pkg` in enhanced SEA mode so that the dynamic loading of `@libsql/*` native packages by the current `@libsql/client` in local SQLite mode keeps working. `pkg.assets` in `package.json` explicitly includes `node_modules/@libsql/**/*`, so the packaged binary can extract the platform's `.node` file into a local cache on first run; without it a standalone binary fails with `Cannot find module '@libsql/<platform>'` in `--storage sqlite` mode.

## Environment variables

| Variable | Description |
| --- | --- |
| `CONFIG_PATH` | Config file path, same as `--config` |
| `PORT` | Listening port; takes priority over `server.port` in the config |
| `LOG_LEVEL` | Log level: `debug`, `info` (default) or `error` |
| `NANOLLM_SQLITE_URL` / `NANOLLM_SQLITE_AUTH_TOKEN` | Remote libSQL/quicSQL URL and token, only used with `--storage sqlite` |
| `NANOLLM_SHUTDOWN_TIMEOUT_MS` | Graceful shutdown timeout, default 25000 |
| `HTTPS_PROXY` / `HTTP_PROXY` | Default proxy for upstream providers (see the HTTP proxy section for priority) |

## Project structure

The code is split into seven modules: `src/core`, `converters`, `proxy`, `subscriptions`, `storage`, `jobs` and `pages`, with `server.ts` as the entry point. See [docs/architecture.md](docs/architecture.md) for responsibilities, dependency rules and the request flow, and [docs/converters.md](docs/converters.md) for the protocol conversion details.

```bash
npm install
npm run dev        # start with file watching
npm run typecheck  # type check
npm test           # run tests
npm run build      # build to dist/
```

## License

ISC
