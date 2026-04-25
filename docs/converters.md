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
| `tools` | `tools[]`, legacy `functions[]` | `tools[]` | `tools[]` | Only function-style normalized tools survive all protocols. Unsupported hosted/server tools are dropped while normalizing tools. |
| `toolChoice` | `tool_choice`, legacy `function_call` | `tool_choice` | `tool_choice` | Unsupported named choices are filtered out if the named tool was dropped. |
| `metadata` | `metadata` | `metadata` | `metadata.user_id` only | Anthropic denormalization rejects metadata except a single string `user_id`. |
| `serviceTier` | `service_tier` | `service_tier` | `service_tier` | Each provider validates its allowed values on denormalization. |
| `stream` | `stream` | `stream` | `stream` | Chat also emits `stream_options.include_usage` when streaming. |
| `temperature` | `temperature` | `temperature` | `temperature` | Passed through when present. |
| `topP` | `top_p` | `top_p` | `top_p` | Passed through when present. |
| `stopSequences` | `stop` | Not currently emitted | `stop_sequences` | Chat string `stop` normalizes to a one-item array. |
| `parallelToolCalls` | `parallel_tool_calls` | `parallel_tool_calls` | Inverted into `tool_choice.disable_parallel_tool_use` | Anthropic expresses this on `tool_choice`, not as a top-level boolean. |
| `promptCacheKey` | `prompt_cache_key` or `promptCacheKey` | `prompt_cache_key` or `promptCacheKey` | Derived from `metadata.user_id.session_id` JSON or date | Anthropic does not expose the same top-level prompt cache key. |
| `promptCacheRetention` | `prompt_cache_retention` or `promptCacheRetention` | `prompt_cache_retention` or `promptCacheRetention` | Not emitted | OpenAI-only. |
| `safetyIdentifier` | `safety_identifier` | `safety_identifier` | Not emitted | OpenAI-only. |
| `reasoningEffort` | `reasoning_effort`, fallback `reasoning.effort` | `reasoning.effort` | `thinking.type=adaptive` + `output_config.effort`, fallback old `thinking.enabled.budget_tokens` | Anthropic old budgets map to `low`/`medium`/`high`; Anthropic output now uses adaptive thinking. |
| `thinkingBudgetTokens` | Not read | Not read | Old `thinking.enabled.budget_tokens` | Kept only as legacy input state; Anthropic output converts it to `output_config.effort` + adaptive thinking. |
| `textVerbosity` | `verbosity` | `text.verbosity` | Not supported | OpenAI-only. |
| `responseFormat` | `response_format` | `text.format` | `output_config.format` | Anthropic only emits JSON schema format. |
| `cacheControl` | Internal default | Internal default | `cache_control` | Anthropic request output defaults to `{ type: "ephemeral" }`. |

## Message Mapping

| Normalized message/part | OpenAI Chat | OpenAI Responses | Anthropic Messages | Notes |
| --- | --- | --- | --- | --- |
| `system` role | `system` message | Leading `instructions` text when denormalizing | `system` text block | Chat `developer` normalizes separately but denormalizes to Chat `system`. |
| `developer` role | `developer` input; denormalizes to Chat `system` | Leading `instructions` text | `system` text block | Anthropic has no developer role. |
| `user` role text | string or `{ type: "text" }` | `message` with `input_text` | `user` text block/string | Multiple adjacent Anthropic same-role messages are merged. |
| `user` image | `image_url` | `input_image` | `image` URL or base64 source | Missing Responses `image_url` errors. |
| `user` document | Degrades to text description | `input_file` | `document` URL/base64/text source | Chat does not support documents directly. |
| `input_audio` | Chat `input_audio` | Responses `input_audio` | Not supported | Anthropic user part errors when denormalizing audio. |
| assistant text | `content` text | `message.content[].output_text` | assistant `text` block | Refusals are preserved as `refusal` where supported. |
| assistant thinking | `thinking`, `reasoning`, `reasoning_content` vendor fields | `reasoning` item | Anthropic `thinking` block | Chat input/output reads and writes all three vendor thinking fields. |
| redacted thinking | Not emitted to Chat | Ignored when denormalizing request messages | Anthropic `redacted_thinking` block | Preserved only when source/target can represent it. |
| function tool call | `tool_calls[].function` | `function_call` | assistant `tool_use` | Anthropic `server_tool_use` also normalizes to this shape. |
| Responses custom tool call | Wrapped into function-style schema/call | `custom_tool_call` when source was Responses custom | Anthropic `tool_use` | Custom input is wrapped/unwrapped to fit function arguments. |
| tool result | Chat `tool` message | `function_call_output` | user `tool_result` block | Legacy Chat `function` role maps to/from tool result fallback. |
| server tool result | Not distinct | Not distinct | `*_tool_result` blocks normalize to normal tool result | Result content is degraded to text or supported media/document parts. |

## Tool Mapping

| Tool source | Normalized behavior | Denormalized behavior |
| --- | --- | --- |
| OpenAI Chat `type=function` | Preserved as `kind=function` with JSON schema. | Emits Chat function tool, Responses function tool, or Anthropic tool. |
| OpenAI Chat non-function tools | Dropped during tool normalization. | Not emitted. |
| OpenAI legacy `functions[]` | Added as function-style tools. | Denormalizes to modern `tools[]`; legacy `functions[]` are not regenerated. |
| OpenAI Responses `type=function` | Preserved as function-style tool. | Emits provider-native function tool. |
| OpenAI Responses `type=custom` | Converted to function-style tool with generated schema; tool name is marked as Responses custom. | Back to Responses `custom` only when target is Responses and name was marked; otherwise function-style. |
| OpenAI Responses namespace/hosted tools | Dropped. | Not emitted. |
| Anthropic tool with `input_schema` and no non-function `type` | Preserved as normal function tool. | Emits ordinary Anthropic client tool. |
| Anthropic function tool with `defer_loading=true` | Preserved as a normal function; `defer_loading` is lost. | Emits ordinary Anthropic tool without `defer_loading`. |
| Anthropic server tools such as web search, web fetch, code execution, tool search | Dropped because they do not have `input_schema`. | Not emitted from normalized tools. |

## Special Handling Rules

| Area | Rule | Behavior |
| --- | --- | --- |
| Anthropic final role | Anthropic requests converted from other formats must end with user/tool/function. | If the final normalized message is assistant, a synthetic user message `go on` is appended before denormalizing to Anthropic. Native Anthropic source skips this fix. |
| Anthropic adjacent roles | Anthropic disallows awkward repeated role turns in many cases. | Adjacent messages with the same Anthropic role are merged by concatenating content blocks. |
| Anthropic tool result adjacency | Anthropic expects tool results to follow the assistant tool use that requested them. | When converting non-Anthropic sources to Anthropic, pending tool results are reordered immediately after the assistant tool call when matching IDs are found later. |
| Anthropic legacy function result | Chat legacy `function` role may use a function name instead of tool call ID. | Pending IDs include both `toolCall.id` and `toolCall.name` when the ID ends with `:legacy`. |
| Anthropic `server_tool_use` | It is a server-side tool call in Anthropic, but normalized as a normal function call. | It denormalizes to regular `tool_use`, not `server_tool_use`, so server-tool semantics are lost. |
| Anthropic `*_tool_result` | Server tool results have provider-specific block types. | Any block with type ending in `_tool_result` is accepted and normalized to a normal tool result. Known web/tool-search contents are degraded to text/document parts. |
| Anthropic tool search result | `tool_search_tool_result` contains `tool_references`. | It normalizes to a normal tool result whose text is a newline-separated list of `tool_name` values. |
| Anthropic adaptive thinking | New Anthropic thinking uses `thinking.type=adaptive` plus `output_config.effort`. | Normalization reads this first. Denormalization always uses this new form when reasoning effort exists. |
| Anthropic old budget thinking | Old Anthropic thinking used `thinking.type=enabled` and `budget_tokens`. | Normalization still supports it and maps budgets `<=3000` to `low`, `<=7500` to `medium`, otherwise `high`. |
| Chat thinking content | Providers use different non-standard fields for reasoning text. | Chat message/response conversion reads and writes `thinking`, `reasoning`, and `reasoning_content`. Streams also read/write all three delta fields. |
| Chat reasoning effort | Providers use both top-level `reasoning_effort` and `reasoning.effort`. | Chat request normalization reads both; denormalization emits both. |
| OpenAI Responses tool search history | Tool search call/output can appear in historical `input[]`. | `tool_search_call` and `tool_search_output` are logged with `console.warn` and dropped. The following `function_call` remains normal. |
| OpenAI storage defaults | Non-passthrough OpenAI requests should not use server-side stored item references. | Proxy request forwarding sets `store=false` for OpenAI Chat and Responses. |
| Responses custom tool input | Responses custom tools are not the same as function tools. | Custom input is wrapped into function arguments when normalizing to common function-style tools, and unwrapped when denormalizing back to Responses custom. |
| Documents to Chat | Chat does not have the same document part model. | Documents degrade to text descriptions in Chat user/tool contexts. |

## Unsupported or Erroring Cases

These cases currently fail intentionally instead of silently degrading.

### OpenAI Chat request normalization

| Location | Error condition |
| --- | --- |
| `messages[].role` | Role is not `system`, `developer`, `user`, `assistant`, `tool`, or `function`. |
| `user.content[]` | Part is not `text`, `image_url`, or `input_audio`. |

### OpenAI Chat request denormalization

| Target | Error condition |
| --- | --- |
| Chat user parts | Normalized user part is not text/refusal, image URL, audio, or document fallback. |
| Chat service tier | `serviceTier` is not one of the supported OpenAI Chat values. |

### OpenAI Responses request normalization

| Area | Error condition |
| --- | --- |
| `input[]` top-level item | Item type is not `message`, `reasoning`, `function_call`, `custom_tool_call`, `function_call_output`, `custom_tool_call_output`, `item_reference`, `tool_search_call`, or `tool_search_output`. `item_reference` is dropped; tool search items are warned and dropped. |
| `message.content[]` | Content part is not `input_text`, `output_text`, `input_image`, `input_file`, `refusal`, or `input_audio`. |
| `input_image` | Missing `image_url`. |
| `input_file` | Missing both `file_url` and `file_data`. |
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
| Responses service tier | `serviceTier` is not one of the supported OpenAI Responses values. |

### Anthropic request normalization

| Area | Error condition |
| --- | --- |
| user/assistant content block | Block is not a supported message block and does not end with `_tool_result`. |
| `document.source.type=content` | Child block is not `text`. |
| ordinary `tool_result.content[]` | Block is not `text`, `image`, or `document`. |

Anthropic content blocks that may still error outside `_tool_result` handling include:

- top-level `search_result`
- top-level `container_upload`
- unknown future content block types

### Anthropic request denormalization

| Target | Error condition |
| --- | --- |
| message role | Normalized role is not `system`, `developer`, `user`, `assistant`, `tool`, or `function`. |
| user parts | Part is not text, image URL, document URL, or document base64. |
| assistant tool calls | Tool call is not function-style. |
| tool result parts | Part is not text, image URL, document URL, or document base64. |
| tools | Normalized tool is not function-style. |
| tool choice | Named tool choice is not function-style. |
| metadata | Metadata contains anything other than a single string `user_id`. |
| service tier | `serviceTier` is not one of the supported Anthropic values. |

## Response Mapping Notes

| Source response | Behavior |
| --- | --- |
| OpenAI Chat | Text/refusal, tool calls, and `thinking`/`reasoning`/`reasoning_content` are normalized. Other provider-specific fields are ignored. |
| OpenAI Responses | `message`, `function_call`, `custom_tool_call`, and `reasoning` output items are normalized. Other output item types are currently ignored, not errored. |
| Anthropic Messages | `text`, `thinking`, `redacted_thinking`, `tool_use`, and `server_tool_use` are normalized. Other response content blocks are currently ignored, not errored. |

