# core

Config parsing and hot reload (`config`, `config-manager`), bearer auth, request context (AsyncLocalStorage), graceful shutdown, error formatting, response compression, HTTP logging and the environment proxy fallback (`env-proxy`, honors `NO_PROXY`).

Entry points: `parseConfigText`, `resolveModel`, `ConfigManager`, `runWithRequestContext`.
Imports: nothing from other modules (only type imports from `converters`).
