# Architecture

nanollm is a gateway that exposes OpenAI Chat, OpenAI Responses and Anthropic compatible APIs and forwards them to configured upstream providers. It also ships an admin UI, request recording, status/usage statistics, subscription (OAuth) providers and scheduled model jobs.

## Source layout

```
server.ts            Hono app, all HTTP routes, process startup (entrypoint)
cli.ts               CLI entry (imports server.ts to start it)
converter.ts         Public re-export of src/converters
src/
  core/              Config, auth, request context, shutdown and small shared helpers (no routing logic)
  converters/        Protocol conversion between openai-chat / openai-responses / anthropic
  proxy/             Upstream calls (forward, stream, passthrough) and model utilities
  subscriptions/     Codex / Claude OAuth subscription providers
  storage/           SQLite access, request records, status buckets, usage stats
  jobs/              Scheduled model jobs (jobs.yaml, scheduler, executor, routes, page)
  pages/             Server-rendered HTML pages (admin config, record, status, usage)
scripts/             Storage migration and maintenance scripts (do not import src/)
tests/               Test entrypoints (compiled to .test-dist/ by tsconfig.build.json)
docs/                Reference docs
```

## Request flow

1. `server.ts` authenticates the request (`core/auth`), resolves the model and fallback group (`core/config`, `proxy/fallback`) and binds a request context (`core/request-context`).
2. The request body is normalized and re-encoded for the upstream format (`converters/requests`).
3. `proxy/proxy` calls the upstream. Subscription providers obtain tokens and headers through `subscriptions/*`.
4. The response (or SSE stream) is converted back (`converters/responses`, `converters/streams`) and returned, with errors shaped by `core/error-details` and `core/stream-errors`.
5. `storage/record`, `storage/status` and `storage/usage` persist what happened. `pages/*` render it.
6. `jobs/*` runs model requests on a cron schedule. `server.ts` gives the job executor a sender that calls the app's own `/v1` routes in-process, so job calls go through steps 1-5 (recording, status, usage) like client requests. Job targets are the text models in config.yaml (`jobs/job-model-catalog`); the resolved model is pinned to the request id so the call uses the connection snapshotted when the run started. Results are stored through `jobs/job-run-store`, and each attempt keeps its `request_id` for linking to the record.

## Modules

| Module | Files | Responsibility |
|---|---|---|
| `core` | `config`, `config-manager`, `auth`, `request-context`, `shutdown`, `startup-error`, `error-details`, `http-log`, `response-compression`, `stream-errors` | YAML config parsing and hot reload, bearer auth, per-request context, graceful shutdown, error formatting, response compression |
| `converters` | `shared`, `requests`, `responses`, `streams`, `index` (+ `test`, `testres`) | Normalized types and the three-way protocol conversion. See [converters.md](converters.md) |
| `proxy` | `proxy`, `fallback`, `response-cache`, `model-test`, `upstream-models` | Upstream HTTP calls, fallback-group failure tracking and ordering, in-memory cache of Responses API output items (resolves `item_reference`), model test request builder, upstream model listing |
| `subscriptions` | `openai-subscription`, `claude-subscription`, `claude-subscription-body`, `claude-billing`, `codex-version`, `subscription-client-compat`, `oauth-transport` | OAuth credential storage/refresh, client identity constants, Claude body transform, Rust helper transport |
| `storage` | `sqlite`, `record`, `status`, `usage` | libsql client with write queue, request records, status buckets, usage by day |
| `jobs` | `jobs`, `job-run-store`, `job-executor`, `job-scheduler`, `job-routes`, `job-model-catalog`, `jobs-page` | Job config store, run history, executor, cron scheduler, HTTP routes, model name resolution, page |
| `pages` | `admin-config-page`, `admin-config-form`, `record-page`, `status-page`, `usage-page`, `logo` | HTML renderers, admin form payload handling, and the shared logo/favicon (`assets/logo.svg`) |

## Dependency rules

```
pages ──► storage, core
jobs ──► proxy, storage, core, converters
proxy ──► subscriptions, converters, storage, core
subscriptions ──► core, proxy/upstream-models
storage ──► core, converters/shared
converters ──► core/request-context
core ──► (nothing)
```

- Imports must go down this list, never up. There are currently no cycles.
- Accepted exceptions: `core/config` imports the `StreamFormat` type from `converters/streams`, and `jobs/jobs` imports a type from `converters/shared` (type-only).
- All relative imports keep the `.js` extension (NodeNext resolution).
- `server.ts` is the only place that wires every module together.

## Build layout

`npm run build` compiles to `dist/` mirroring the source tree (`dist/server.js`, `dist/src/<module>/*.js`). `oauth-transport` locates the Rust helper relative to its own directory, so keep its depth in sync with the candidate paths in `resolveOAuthTransportPath` if it moves again. The release workflow also references `dist/src/subscriptions/oauth-transport.js`.

## Tests

- `tests/run.ts` is the main suite. `tests/jobs.ts`, `tests/subscription-proxy.ts`, `tests/storage-migration.ts` and `tests/shutdown.ts` use `node:test`. New test files must be added to the `test` script in `package.json`.
- `npm run converter:test` runs the converter suite in `src/converters/test.ts`.

## How to extend

- **New provider type**: add config parsing in `core/config`, upstream handling in `proxy/proxy`, and (if OAuth based) a module in `subscriptions/`.
- **New route**: add it in `server.ts`. If it needs more than a few lines, put the logic in the owning module and export a factory such as `createJobRoutes`.
- **New page**: add a renderer in `pages/` that takes data from `storage/` and returns HTML.
- **New scheduled job type**: extend `jobs/jobs` validation and add an executor in `jobs/job-executor`.
