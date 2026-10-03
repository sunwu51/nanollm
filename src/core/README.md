# core

Config parsing and hot reload (`config`, `config-manager`), bearer auth, request context (AsyncLocalStorage), graceful shutdown, error formatting, response compression and HTTP logging.

Entry points: `parseConfigText`, `resolveModel`, `ConfigManager`, `runWithRequestContext`.
Imports: nothing from other modules (only type imports from `converters`).
