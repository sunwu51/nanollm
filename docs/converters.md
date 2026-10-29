# Converter Reference

This document describes how `src/converters` normalizes and denormalizes requests and responses between:

- OpenAI Chat Completions (`openai-chat`)
- OpenAI Responses (`openai-responses`)
- Anthropic Messages (`anthropic`)

The shared intermediate form is `NormalizedRequest`, `NormalizedMessage`, `NormalizedTool`, and `NormalizedResponse` in `src/converters/shared.ts`.

## Request Field Mapping

| Normalized field | OpenAI Chat input | OpenAI Responses input | Anthropic Messages input | Notes |
| --- | --- | --- | --- | --- |
| `model` | `model` | `model` | `model` | Forwarded and overwritten by configured upstream model before provider calls. |
| `maxOutputTokens` | `max_completion_tokens`, fallback `max_tokens` | `max_output_tokens` | `max_tokens` | Denormalizing to Chat always uses `max_completion_tokens`. |
| `messages` | `messages[]` | `instructions` + `input` | `system` + `messages[]` | System/developer messages become Anthropic `system`; Responses leading system/developer messages become `instructions`. |
| `tools` | `tools[]`, legacy `functions[]` | `tools[]` | `tools[]` | Function-style tools survive all protocols; native web search maps between Responses and Anthropic (see Web Search). Responses MCP namespace tools are flattened to qualified function-style names like `mcp__server__tool`; other hosted/server tools and non-MCP namespaces are dropped while normalizing tools. |
| `toolChoice` | `tool_choice`, legacy `function_call` | `tool_choice` | `tool_choice` | Unsupported named choices are filtered out if the named tool was dropped. |
| `metadata` | `metadata` | `metadata` | `metadata.user_id` only | Anthropic denormalization keeps a string `user_id` and drops every other metadata key. |
| `serviceTier` | `service_tier` | `service_tier` | `service_tier` | Mapped per target; see Service Tier Mapping. Values with no counterpart are omitted. |
| `stream` | `stream` | `stream` | `stream` | Chat also emits `stream_options.include_usage` when streaming. |
| `temperature` | `temperature` | `temperature` | `temperature` | Passed through when present. |
| `topP` | `top_p` | `top_p` | `top_p` | Passed through when present. |
| `stopSequences` | `stop` | Not currently emitted | `stop_sequences` | Chat string `stop` normalizes to a one-item array. |
| `parallelToolCalls` | `parallel_tool_calls` | `parallel_tool_calls` | Inverted into `tool_choice.disable_parallel_tool_use` | Anthropic expresses this on `tool_choice`, not as a top-level boolean. |
| `promptCacheKey` | `prompt_cache_key` or `promptCacheKey` | `prompt_cache_key` or `promptCacheKey` | Derived by `core/session-id`: `x-claude-code-session-id` header, `metadata.user_id` session, session/thread/conversation headers, else a hash of client IP + user agent + first user text | Anthropic does not expose the same top-level prompt cache key. |
| `promptCacheRetention` | `prompt_cache_retention` or `promptCacheRetention` | `prompt_cache_retention` or `promptCacheRetention` | Not emitted | OpenAI-only. |
| `safetyIdentifier` | `safety_identifier` | `safety_identifier` | Not emitted | OpenAI-only. |
| `reasoningEffort` | `reasoning_effort`, fallback `reasoning.effort` | `reasoning.effort` | `thinking.type=disabled` → `none`; `thinking.type=adaptive` + `output_config.effort`; fallback old `thinking.enabled.budget_tokens` | Anthropic old budgets map to `low`/`medium`/`high`. Anthropic output: `none` → `thinking.type=disabled`, `minimal` → `low`, other levels use adaptive thinking. |
| `thinkingBudgetTokens` | Not read | Not read | Old `thinking.enabled.budget_tokens` | Kept only as legacy input state; Anthropic output converts it to `output_config.effort` + adaptive thinking. |
| `textVerbosity` | `verbosity` | `text.verbosity` | Not supported | OpenAI-only. |
| `responseFormat` | `response_format` | `text.format` | `output_config.format` | `text`, `json_object` and `json_schema` (name, description, schema, strict) map between Chat and Responses. Anthropic only has a JSON schema format: `json_schema` keeps only its schema there, Anthropic input becomes a schema named `anthropic_output`, and `json_object` becomes a prompt instead (see Anthropic JSON mode). |
| `cacheControl` | Internal default | Internal default | `cache_control` | Anthropic request output defaults to `{ type: "ephemeral" }` at the top level (automatic caching: one breakpoint on the last cacheable block). `json_object` requests add one explicit breakpoint; see Anthropic JSON mode. |

## Message Mapping

| Normalized message/part | OpenAI Chat | OpenAI Responses | Anthropic Messages | Notes |
| --- | --- | --- | --- | --- |
| `system` role | `system` message | Leading `instructions` text when denormalizing | `system` text block | Chat `developer` normalizes separately but denormalizes to Chat `system`. |
| `developer` role | `developer` input; denormalizes to Chat `system` | Leading `instructions` text | `system` text block | Anthropic has no developer role. |
| `user` role text | string or `{ type: "text" }` | `message` with `input_text` | `user` text block/string | Multiple adjacent Anthropic same-role messages are merged. |
| `user` image | `image_url` | `input_image` | `image` URL or base64 source | Missing Responses `image_url` errors. |
| `user` file | `file` part: rejected with 400 | `input_file`: rejected with 400 | `document` with url/base64/file source: rejected with 400; `text`/`content` source becomes text | Files are only forwarded by same-protocol passthrough. See File Content. |
| `input_audio` | Chat `input_audio` | Responses `input_audio` | Not supported | Anthropic user part errors when denormalizing audio. |
| assistant text | `content` text | `message.content[].output_text` | assistant `text` block | Refusals are preserved as `refusal` where supported. |
| assistant thinking | `thinking`, `reasoning`, `reasoning_content` vendor fields | Native Responses `reasoning` items are read; synthetic Chat/Anthropic thinking is not emitted in Responses create requests | Anthropic `thinking` block | Chat input/output reads and writes all three vendor thinking fields. |
| redacted thinking | Not emitted to Chat | Ignored when denormalizing request messages | Anthropic `redacted_thinking` block | Preserved only when source/target can represent it. |
| function tool call | `tool_calls[].function` | `function_call` | assistant `tool_use` | Anthropic `server_tool_use` for tools other than web search also normalizes to this shape. |
| web search | Text note in assistant content | `web_search_call` | `server_tool_use` + `web_search_tool_result` | A `web_search` part kept in order among the assistant parts. See Web Search. |
| web citations | Not emitted | `output_text.annotations[]` `url_citation` | text `citations[]` `web_search_result_location` | Optional `citations` on text parts. Ranges replay to Responses; Anthropic citations are never replayed (text without them is accepted). |
| Responses custom tool call | Wrapped into function-style schema/call | `custom_tool_call` when source was Responses custom | Anthropic `tool_use` | Custom input is wrapped/unwrapped to fit function arguments. |
| tool result | Chat `tool` message | `function_call_output` | user `tool_result` block | Legacy Chat `function` role maps to/from tool result fallback. |
| server tool result | Not distinct | Not distinct | `*_tool_result` blocks normalize to normal tool result | Result content is degraded to text or images. `web_search_tool_result` instead completes its `web_search` part. |

## Tool Mapping

| Tool source | Normalized behavior | Denormalized behavior |
| --- | --- | --- |
| OpenAI Chat `type=function` | Preserved as `kind=function` with JSON schema. | Emits Chat function tool, Responses function tool, or Anthropic tool. |
| OpenAI Chat non-function tools | Dropped during tool normalization. | Not emitted. |
| OpenAI legacy `functions[]` | Added as function-style tools. | Denormalizes to modern `tools[]`; legacy `functions[]` are not regenerated. |
| OpenAI Responses `type=function` | Preserved as function-style tool. `defer_loading` is ignored during normalization. | Emits provider-native function tool without `defer_loading`. |
| OpenAI Responses `type=custom` | Converted to function-style tool with generated schema; tool name is marked as Responses custom. | Back to Responses `custom` only when target is Responses and name was marked; otherwise function-style. |
| OpenAI Responses `type=namespace` tools | Only MCP namespaces are flattened to function-style tools named `mcp__server__tool`. Child function `defer_loading` flags are ignored during normalization. Other namespaces are dropped. | When target is Responses, qualified MCP tool names are grouped back under `type=namespace` tools. Namespace descriptions and lazy-loading metadata are not preserved. |
| OpenAI Responses `web_search` / `web_search_2025_08_26` / `web_search_preview*` | `kind=web_search` with domains, user location, context size and `external_web_access`. | Anthropic `web_search_20250305`; Responses `web_search` (plus `include: ["web_search_call.action.sources"]`); dropped for Chat. See Web Search. |
| Other OpenAI Responses hosted/server tools | Dropped. | Not emitted. |
| Anthropic tool with `input_schema` and no non-function `type` | Preserved as normal function tool. | Emits ordinary Anthropic client tool. |
| Anthropic function tool with `defer_loading=true` | Preserved as a normal function; `defer_loading` is lost. | Emits ordinary Anthropic tool without `defer_loading`. |
| Anthropic `web_search_*` tool named `web_search` | `kind=web_search` with domains, user location and `max_uses`. | See the Responses row above. |
| Other Anthropic server tools such as web fetch, code execution, tool search | Dropped because they do not have `input_schema`. | Not emitted from normalized tools. |

## Special Handling Rules

| Area | Rule | Behavior |
| --- | --- | --- |
| Anthropic final role | Anthropic requests converted from other formats must end with user/tool/function. | If the final normalized message is assistant, a synthetic user message `go on` is appended before denormalizing to Anthropic. Native Anthropic source skips this fix. |
| Anthropic adjacent roles | Anthropic disallows awkward repeated role turns in many cases. | Adjacent messages with the same Anthropic role are merged by concatenating content blocks. |
| Anthropic JSON mode | Anthropic has no `json_object` format; `output_config.format` only takes a JSON schema. | A Chat or Responses `json_object` request emits no `output_config.format`. Instead a text block asking for a single JSON object with no code fences or surrounding text is appended to the last user message, after the merge and after any `tool_result` blocks. The block before the instruction gets the same `cache_control` as the request: clients never resend the instruction, so with only the automatic breakpoint on it the next turn could never read this turn's cache entry. |
| Anthropic tool result adjacency | Anthropic expects tool results to follow the assistant tool use that requested them. | When converting non-Anthropic sources to Anthropic, pending tool results are reordered immediately after the assistant tool call when matching IDs are found later. |
| Anthropic legacy function result | Chat legacy `function` role may use a function name instead of tool call ID. | Pending IDs include both `toolCall.id` and `toolCall.name` when the ID ends with `:legacy`. The emitted `tool_result.tool_use_id` is `<name>:legacy` (sanitized) so it matches the `tool_use`. |
| Anthropic tool ids | Anthropic requires `tool_use.id` / `tool_use_id` to match `^[a-zA-Z0-9_-]+$`. | Requests and responses converted to Anthropic replace any other character with `_` (e.g. `get_weather:legacy` becomes `get_weather_legacy`, `functions.read:0` becomes `functions_read_0`). |
| Anthropic `server_tool_use` | It is a server-side tool call in Anthropic. Web search becomes a `web_search` part; other server tools are normalized as a normal function call. | Non-search server tools denormalize to regular `tool_use`, not `server_tool_use`, so server-tool semantics are lost. |
| Anthropic `*_tool_result` | Server tool results have provider-specific block types. | Any block with type ending in `_tool_result` is accepted and normalized to a normal tool result. Known web/tool-search contents are degraded to text; a `web_fetch_result` keeps the page text for text documents and only the URL otherwise. |
| Anthropic tool search result | `tool_search_tool_result` contains `tool_references`. | It normalizes to a normal tool result whose text is a newline-separated list of `tool_name` values. |
| Anthropic `tool_reference` in `tool_result` | ToolSearch results can put `tool_reference` blocks directly in `tool_result.content[]`. | Each block normalizes to a text part holding its `tool_name`. |
| Anthropic adaptive thinking | New Anthropic thinking uses `thinking.type=adaptive` plus `output_config.effort`. | Normalization reads this first. Denormalization uses this form for every effort except `none`, which emits `thinking.type=disabled` with no effort; `minimal` is sent as `low` because Anthropic has no lower level. |
| Anthropic old budget thinking | Old Anthropic thinking used `thinking.type=enabled` and `budget_tokens`. | Normalization still supports it and maps budgets `<=3000` to `low`, `<=7500` to `medium`, otherwise `high`. |
| Chat thinking content | Providers use different non-standard fields for reasoning text. | Chat message/response conversion reads and writes `thinking`, `reasoning`, and `reasoning_content`. Streams also read/write all three delta fields. |
| Chat reasoning effort | Providers use both top-level `reasoning_effort` and `reasoning.effort`. | Chat request normalization reads both; denormalization emits both. |
| Reasoning effort conversion | The five common levels `low`, `medium`, `high`, `xhigh`, and `max` are preserved across Chat, Responses, and Anthropic. OpenAI Chat and Responses input `ultra` normalizes to `max`. | The `ultra` downgrade applies during protocol conversion; same-format passthrough preserves the original value. Between OpenAI protocols `none`/`minimal` are unchanged; toward Anthropic `none` disables thinking and `minimal` becomes `low`, and Anthropic `thinking.type=disabled` becomes `none`. Supported levels remain model-dependent. |
| OpenAI Responses tool search history | Tool search call/output can appear in historical `input[]`. | `tool_search_call` and `tool_search_output` are logged with `console.warn` and dropped. The following `function_call` remains normal. |
| OpenAI Responses namespace history | Historical Responses `function_call` / `custom_tool_call` items and streamed output items can carry `namespace`. | MCP namespace names are folded into qualified names like `mcp__server__tool` during normalization and are split back to `namespace` + local `name` when denormalizing back to Responses. |
| OpenAI storage defaults | Non-passthrough OpenAI requests should not use server-side stored item references. | Proxy request forwarding sets `store=false` for OpenAI Chat and Responses. |
| OpenAI Responses passthrough item IDs | Responses item `id` fields such as `message.id`, `reasoning.id`, and `function_call.id` point at upstream-persisted item state. | Same-format Responses passthrough removes those item `id` fields when `store=false`; `call_id` and the rest of each item are preserved. |
| Responses reasoning text priority | A Responses `reasoning` item can carry raw `content[reasoning_text]` (open-weight models), a display `summary[summary_text]` (OpenAI models), or both. | Response, stream and request normalization all read `content` first and fall back to `summary`. Streams accept both `reasoning_text.*` and `reasoning_summary_text.*` events, keep the first source per item, and replay a finished `output_item.done` reasoning item that had no deltas. |
| Thinking emitted as Responses reasoning | Clients often drop the display-only `summary` from history but send `encrypted_content` back verbatim; providers that require prior thinking before a tool call then reject the request. | Thinking converted from Chat/Anthropic is written to `summary` for display and also to `encrypted_content` as a `nanollm.reasoning.v1:` carrier holding the text and Anthropic `signature`. Request normalization restores signed thinking from the carrier; same-format Responses passthrough drops carrier items because a real Responses upstream cannot verify them. |
| Reasoning in history from other models | Claude rejects thinking signed by another provider; DeepSeek rejects a tool call it did not issue unless the turn carries thinking. | `proxy/reasoning-history` runs on the final upstream body (converted and passthrough) according to `models[*].reasoning_profile` (auto-detected): drops non-Claude signatures for Claude, adds empty thinking placeholders to foreign tool calls for DeepSeek and leaves DeepSeek-issued calls alone. |
| Responses custom tool input | Responses custom tools are not the same as function tools. | Custom input is wrapped into function arguments when normalizing to common function-style tools, and unwrapped when denormalizing back to Responses custom. |
| Responses namespace tool calls | Responses `function_call`/`custom_tool_call` items can carry a separate `namespace`. | MCP namespace calls are normalized to qualified names like `mcp__server__tool` so non-namespace targets can still route the call, and are split back into `namespace` + local `name` when denormalizing back to Responses. |
| File content | Chat `file`, Responses `input_file` and Anthropic `document` (url/base64/file source) have different shapes and provider-specific file ids. | Not converted. The converter throws `UnsupportedContentError` (HTTP 400). In a fallback group the next candidate is still tried, so a same-protocol member can serve the request by passthrough, and the rejection does not count against the member's fallback ranking. |

## Service Tier Mapping

OpenAI Chat and Responses accept `auto`, `default`, `flex`, `scale`, `priority`; Anthropic accepts `auto`, `standard_only`. Codex clients also send `fast` as an alias of `priority`. Values not listed are omitted so the upstream default applies.

| Source value | To OpenAI Chat / Responses | To Anthropic | Why |
| --- | --- | --- | --- |
| `auto` | `auto` | `auto` | Same meaning. |
| `default` | `default` | `standard_only` | Standard capacity only. |
| `flex` | `flex` | `standard_only` | Anthropic has no cheaper tier; never use priority capacity. |
| `scale` | `scale` | `auto` | Reserved capacity; Anthropic `auto` uses Priority Tier when the org has it. |
| `priority` | `priority` | `auto` | Same as above. |
| `fast` | `priority` | `auto` | Codex alias of priority. |
| `standard_only` | `default` | `standard_only` | Anthropic standard capacity. |

## Unsupported or Erroring Cases

These cases currently fail intentionally instead of silently degrading.

### OpenAI Chat request normalization

| Location | Error condition |
| --- | --- |
| `content[]` `file` part | Rejected with 400 (file content). |
| `messages[].role` | Role is not `system`, `developer`, `user`, `assistant`, `tool`, or `function`. |
| `user.content[]` | Part is not `text`, `image_url`, or `input_audio`. |

### OpenAI Chat request denormalization

| Target | Error condition |
| --- | --- |
| Chat user parts | Normalized user part is not text/refusal, image URL, or audio. |

### OpenAI Responses request normalization

| Area | Error condition |
| --- | --- |
| `input[]` top-level item | Item type is not `message`, `reasoning`, `function_call`, `custom_tool_call`, `function_call_output`, `custom_tool_call_output`, `item_reference`, `tool_search_call`, or `tool_search_output`. `item_reference` is dropped; tool search items are warned and dropped. |
| `message.content[]` | Content part is not `input_text`, `output_text`, `input_image`, `input_file`, `refusal`, or `input_audio`. |
| `input_image` | Missing `image_url`. |
| `input_file` | Always rejected with 400 (file content is not converted). |
| tool output parts | Unsupported part type or missing required image/file payload. |

Common Responses item types that still error if they appear in request `input[]` include:

- `web_search_call`
- `file_search_call`
- `computer_call`
- `computer_call_output`
- `image_generation_call`
- `code_interpreter_call`
- `local_shell_call`
- `local_shell_call_output`
- `shell_call`
- `shell_call_output`
- `apply_patch_call`
- `apply_patch_call_output`
- `mcp_list_tools`
- `mcp_approval_request`
- `mcp_approval_response`
- `mcp_call`
- `compaction`

### OpenAI Responses request denormalization

| Target | Error condition |
| --- | --- |
| Responses instructions | System/developer message contains non-text parts. |
| Responses tool/function output | Normalized tool result contains a part not representable as text/refusal, image, or file. |

### Anthropic request normalization

| Area | Error condition |
| --- | --- |
| user/assistant content block | Block is not a supported message block and does not end with `_tool_result`. |
| `document` | Source is url, base64 or file: rejected with 400 (file content). |
| `document.source.type=content` | Child block is not `text`. |
| ordinary `tool_result.content[]` | Block is not `text`, `image`, `tool_reference`, or a text-source `document`. A url/base64/file `document` is rejected with 400. |

Anthropic content blocks that may still error outside `_tool_result` handling include:

- top-level `search_result`
- top-level `container_upload`
- unknown future content block types

### Anthropic request denormalization

| Target | Error condition |
| --- | --- |
| message role | Normalized role is not `system`, `developer`, `user`, `assistant`, `tool`, or `function`. |
| user parts | Part is not text or image URL. |
| assistant tool calls | Tool call is not function-style. |
| tool result parts | Part is not text or image URL. |
| tools | Normalized tool is not function-style. |
| tool choice | Named tool choice is not function-style. |

## Response Mapping Notes

| Source response | Behavior |
| --- | --- |
| OpenAI Chat | Text/refusal, tool calls, and `thinking`/`reasoning`/`reasoning_content` are normalized. Other provider-specific fields are ignored. |
| OpenAI Responses | `message` (with `url_citation` annotations), `web_search_call`, `function_call`, `custom_tool_call`, and `reasoning` output items are normalized. A blank acknowledgement message (whitespace-only text) ahead of other output is dropped. MCP namespace tool calls are folded to qualified names during normalization, including streamed output items, and split back when denormalizing to Responses. Other output item types are currently ignored, not errored. |
| Anthropic Messages | `text` (with web search `citations`), `thinking`, `redacted_thinking`, `tool_use`, `server_tool_use`, and web search `server_tool_use` / `web_search_tool_result` pairs are normalized. Other response content blocks are currently ignored, not errored. |

## Web Search

Native web search converts between Responses and Anthropic in `src/converters/web-search.ts`. Background and live-test results: `docs/web-search-conversion-research.md`. Each side's search history holds state only its own upstream can verify, so a search is replayed exactly only to the protocol that ran it; elsewhere it degrades.

| Topic | Behavior |
| --- | --- |
| Tool | Responses `web_search*` ↔ Anthropic `web_search_20250305` (basic search; 2026 versions default to dynamic filtering, whose code-execution blocks have no Responses counterpart). Domains and user location map; Anthropic rejects allowed + blocked together, so allowed wins. `max_uses` is dropped toward Responses (`max_tool_calls` also counts page actions). `external_web_access: false` drops the tool for Anthropic (no cache-only mode). Responses requests get `include: ["web_search_call.action.sources"]`. Chat drops the tool. |
| Forced choice | A forced web search choice becomes `auto`: forcing makes GPT loop until `max_messages`, and Opus 5.5 / Sonnet 5.5 / Fable 5.1 reject forced choices. Chat gets no choice. |
| Normalized part | `{ type: "web_search", id, origin, action, status, sources, errorCode?, native? }` inside assistant `parts`, so its order relative to reasoning and text is kept. `native` holds the original Anthropic blocks or Responses item. |
| Anthropic history → Anthropic | Native blocks verbatim (result blocks stay where they were, including a result that arrives after a client tool call). |
| Anthropic history → Responses | `function_call` named `web_search_history` + `function_call_output` listing title, URL, page age and the `cited_text` quotes from the turn's citations. Text before the search becomes its own message item. |
| Responses history → Responses | The native `web_search_call` item. |
| Responses history → Anthropic / Chat, Anthropic history → Chat | A text note in the assistant's voice: query, a retention line ("full page contents were retrieved and read…; only source metadata is kept…") and sources, with titles taken from citations. Claude disowns earlier answers when history shows a search without readable results; the note in its own voice avoids that. |
| Synthesized ids | Searches nanollm shows across protocols carry recognizable ids: a Responses search shown to an Anthropic client is `srvtoolu_nanollm_<ws id>` (action in `input`, marker `encrypted_content`); an Anthropic search shown to a Responses client is `ws_nanollm_<srvtoolu id>`, with the original blocks in a reasoning item whose `encrypted_content` starts with `nanollm.websearch.v1:`. Converted requests restore them to their origin protocol. |
| Same-format passthrough | `proxy` degrades synthesized searches the upstream would reject: Responses carrier items and `ws_nanollm_` calls become `web_search_history` function calls; Anthropic `srvtoolu_nanollm_` pairs become text notes and marker citations are removed. |

### Web search in responses

| Direction | Behavior |
| --- | --- |
| Claude response → Responses client | Parts are emitted in order (`thinking`, search, `thinking`, text) only when the response contains a search; other responses keep the original grouping. Each search becomes a `web_search_call` (`id` `ws_nanollm_<srvtoolu id>`, `action.sources` from the results, `failed` on a search error) followed by a reasoning item whose `encrypted_content` (`nanollm.websearch.v1:` + base64 of the brotli-compressed JSON blocks, quality 5 like request records) carries the original `server_tool_use` / `web_search_tool_result` blocks; clients send it back verbatim and a later request restores the blocks. The decoder also reads the older plain base64 JSON form and caps what a carrier may unpack to, since it comes from the client. Compression takes about 28% off a real search, the most the incompressible `encrypted_content` allows. A search with no result yet (a client tool was called in the same turn) is only carried, with no visible item; the result then appears once in the next response. Text around a search becomes separate `message` items. A cited text block gets a `url_citation` annotation covering the whole block. |
| GPT response → Anthropic client | Each `web_search_call` becomes a `server_tool_use` (`id` `srvtoolu_nanollm_<ws id>`, `input` = `{query, action}`) plus a `web_search_tool_result` with marker `encrypted_content`, `[]` for page actions, and an error result for a failed search. A `url_citation` range cuts the text into blocks (Unicode code points); each cited block carries a `web_search_result_location` with its own words as `cited_text`. `usage.server_tool_use.web_search_requests` counts finished `search` actions. A later request rebuilds the original `web_search_call` from `input.action`. |
| Chat clients | Searches are invisible; only the answer text is returned. |

### Web search in streams

Normalized stream events `web_search_start`, `web_search_done` and `citation` carry searches between the parsers and emitters (Chat emitters ignore them). The same conversions as the non-stream path apply; these are the stream-specific parts.

| Direction | Behavior |
| --- | --- |
| Claude stream → Responses client | The call block is buffered until it stops (its query is then known) and shown as an in-progress `web_search_call` with `searching` events. The result block arrives complete and finishes it (`completed` / `failed`) and emits the carrier reasoning item. The message item is closed before the search and a new one opens after, and once a search was seen every non-text item closes the message first, so the output keeps its real order. `citations_delta` arrives before the text and is announced as `output_text.annotation.added` just before the text is done, covering the whole block. A search still waiting behind a client tool call is closed as soon as any other block starts (so the carrier precedes the client's `function_call`, as in the original block order): it ends `incomplete` and only the carrier holds it. Unlike the non-stream path, which shows nothing for it, the stream cannot know a search will stay pending when it announces it. |
| GPT stream → Anthropic client | The `server_tool_use` block is shown as soon as the item is added (empty input), the input (`query` and `action`) is filled in when the item is done, then the result block follows. A `url_citation` arrives after the text, so it is sent as a `citations_delta` on the text block that is still open (the block cannot be split any more; `cited_text` is the answer's own words). `message_delta.usage.server_tool_use.web_search_requests` counts finished searches. A search whose done event never arrives is finished from `response.completed`. |
| Blank messages | A whitespace-only assistant text block is dropped when converting history to Anthropic (Claude rejects it), which covers a blank acknowledgement message echoed back by a client. |

## Proxy handling around web search

| Topic | Behavior |
| --- | --- |
| `pause_turn` | Claude pauses a long server-tool turn with `stop_reason: "pause_turn"`. An Anthropic client resumes it itself; Responses and Chat clients do not know the stop reason. For converted requests to an Anthropic upstream the proxy (`proxy/pause-turn`) resumes the turn: it sends the whole assistant turn so far back as a trailing assistant message, repeats up to 5 times, and returns one response. Non-stream merges the contents in order and sums the usage. A stream is spliced into one stream: later rounds' blocks continue the numbering, their `message_start` is dropped, and the final `message_delta` carries the summed usage. A failed continuation errors the stream. After the limit the paused response is returned as it is. Same-format requests are never resumed. |
| Rejected thinking binding | Claude 5.x ties each replayed thinking block to the conversation before it (system prompt, tools, earlier messages); on new accounts a mismatch returns 400 "bound to a different conversation". nanollm rewrites history when it converts or degrades a search, so for converted requests, and for same-format Anthropic requests whose history nanollm rewrote, the proxy (`proxy/thinking-binding`) retries once with every `thinking` / `redacted_thinking` block removed (empty assistant turns are dropped), as Anthropic recommends. It only reacts to the error, so accepted conversations keep their cache hits and reasoning. A same-format request nanollm did not touch keeps its error. See `docs/claude-thinking-rules.md`. |
