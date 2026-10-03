# nanollm

LLM gateway (OpenAI Chat / Responses / Anthropic compatible). See `docs/architecture.md` for the module layout, dependency rules and request flow.

## Layout
- `server.ts` entrypoint and routes; `src/{core,converters,proxy,subscriptions,storage,jobs,pages}` feature modules; `tests/`; `scripts/`.
- Imports use explicit `.js` extensions and must follow the dependency direction in `docs/architecture.md`.

## Commands
- `npm run typecheck`, `npm test`, `npm run build`, `npm run converter:test`
- New test files must be registered in the `test` script in `package.json`.
