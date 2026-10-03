# proxy

Upstream HTTP calls for every provider format (`proxy.ts`), fallback-group failure tracking (`fallback.ts`), the Responses API item cache (`response-cache.ts`, resolves `item_reference`), the model test request builder and upstream model listing.

Entry points: `forwardRequest`, `forwardStreamRequest`, `passthroughRequest`, `buildModelTestRequest`.
Imports: `core`, `converters`, `subscriptions`, `storage/record`.
