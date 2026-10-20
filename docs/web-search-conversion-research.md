# Native web search: Anthropic Messages ↔ OpenAI Responses

Research notes, 2026-10-20. Covers the request (tool definition, tool_choice, history) and the response (non-stream, stream) in both directions. Shapes come from the installed SDK types (`openai` 7.18.0, `@anthropic-ai/sdk` 0.133.0) and the official docs:

- https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools
- https://developers.openai.com/api/docs/guides/tools-web-search
- https://developers.openai.com/api/reference/resources/responses/streaming-events

## 1. Summary

| Aspect | Anthropic Messages | OpenAI Responses | Conversion difficulty |
| --- | --- | --- | --- |
| Tool definition | `{type:"web_search_20250305"\|"_20260209"\|"_20260318", name:"web_search", max_uses, allowed_domains\|blocked_domains, user_location}` | `{type:"web_search"\|"web_search_2025_08_26"\|"web_search_preview*", filters.allowed_domains/blocked_domains, user_location, search_context_size, external_web_access, ...}` | Easy, some fields lost |
| Call | `server_tool_use` content block (`srvtoolu_` id, `input.query`) | `web_search_call` output item (`ws_` id, `action` = search / open_page / find_in_page) | Easy |
| Results | `web_search_tool_result` block: `[{url,title,page_age,encrypted_content}]` or an error object | None. At most `action.sources[{type:"url",url}]` (opt-in through `include`) | One-way: OpenAI has no result content |
| Citations | Text block `citations[]`: `web_search_result_location {url,title,cited_text,encrypted_index}`. A cited span is its own text block | `output_text.annotations[]`: `url_citation {url,title,start_index,end_index}` (character range) | Block split ↔ range: doable |
| History replay | You must send `encrypted_content` (and `encrypted_index`) back unchanged, otherwise 400 | The `web_search_call` item must be replayed together with its paired `reasoning` item, otherwise 400 (reasoning models) | **Hard part.** Only same-origin replay is lossless |
| Streaming | `server_tool_use` streams `input_json_delta`; the result block arrives complete in one `content_block_start`; `citations_delta` comes **before** the cited text | `output_item.added` → `web_search_call.in_progress/searching/completed` → `output_item.done` (full `action`); `output_text.annotation.added` comes **after** the text | Mostly mechanical; OpenAI→Anthropic citations can only be approximate when streaming |
| Usage | `usage.server_tool_use.web_search_requests` | No counter (count the `web_search_call` items with `action.type=search`) | Easy |
| Pause | `stop_reason: "pause_turn"` (resume by sending the content back unchanged) | No equivalent | Best handled inside nanollm (auto-continue) |

Bottom line: **request and response conversion is mechanical. History is the hard part.** Each side's history replay needs opaque state that only the originating vendor can produce, so lossless replay only works when history goes back to the upstream type that produced it. nanollm can do that by carrying the original data in a field the client echoes back verbatim, the same idea as the existing `nanollm.reasoning.v1:` carrier in `src/converters/shared.ts`. If the upstream changes mid-conversation (e.g. GPT then Claude), the history has to degrade to plain text.

## 2. Request: tool definition

### 2.1 Anthropic tool

```jsonc
{
  "type": "web_search_20250305",          // or web_search_20260209 / web_search_20260318
  "name": "web_search",                   // fixed
  "max_uses": 5,
  "allowed_domains": ["example.com"],     // mutually exclusive with blocked_domains (400 if both)
  "blocked_domains": ["bad.com"],
  "user_location": { "type": "approximate", "city": "...", "region": "...", "country": "US", "timezone": "America/Los_Angeles" },
  // Also: allowed_callers, cache_control, defer_loading, strict; 20260318 adds response_inclusion
}
```

- On `_20260209` and later, `allowed_callers` defaults to `["code_execution_20260120"]` (**dynamic filtering**). Searches then run inside code execution, and the response contains code-execution blocks plus nested `server_tool_use`/`web_search_tool_result` pairs with a `caller` field. This is much harder to convert. Dynamic filtering is also not ZDR-eligible by default.
- Models without programmatic tool calling **require** `allowed_callers:["direct"]` on `_20260209+`, otherwise 400.

### 2.2 OpenAI tool

```jsonc
{
  "type": "web_search",                   // or web_search_2025_08_26; legacy web_search_preview / web_search_preview_2025_03_11
  "filters": { "allowed_domains": ["..."], "blocked_domains": ["..."] },  // blocked_domains is in the docs, not yet in SDK 7.18 types; max 100 each
  "user_location": { "type": "approximate", "city": "...", "region": "...", "country": "US", "timezone": "..." },  // type optional
  "search_context_size": "low|medium|high",
  "external_web_access": false,           // cache-only / offline mode
  "return_token_budget": "default|unlimited",
  "search_content_types": ["text","image"], "image_settings": { "max_results": 3, "caption": true }
}
```

Related top-level fields: `include: ["web_search_call.action.sources", "web_search_call.results"]`, `max_tool_calls` (caps all built-in tool calls).

### 2.3 Mapping

OpenAI → Anthropic (OpenAI client, Claude upstream; e.g. Codex on Claude):

| OpenAI | Anthropic | Note |
| --- | --- | --- |
| `type: web_search*` / `web_search_preview*` | `type: web_search_20250305, name: web_search` | Recommend `20250305` (or `20260209` + `allowed_callers:["direct"]`) to avoid dynamic-filtering blocks. Could be configurable per upstream model. |
| `filters.allowed_domains` | `allowed_domains` | Strip any scheme. Path rules differ slightly (Anthropic supports path + `*` in the path). |
| `filters.blocked_domains` | `blocked_domains` | If both are set: Anthropic returns 400. Keep `allowed_domains` only. |
| `user_location` | `user_location` (add `type:"approximate"`) | Anthropic rejects unsupported country codes with 400. |
| `max_tool_calls` (top level) | `max_uses` | Only valid when web_search is the sole built-in tool; otherwise drop. |
| `search_context_size`, `return_token_budget`, `search_content_types`, `image_settings` | — | Drop. |
| `external_web_access: false` | — | Anthropic has no cache-only mode. **Decision needed:** remove the tool (keeps the "no live access" intent) or ignore the flag. Recommend removing. |
| `include: [web_search_call.*]` | — | Only affects how nanollm builds the output (sources are always available from the Anthropic result). |

Anthropic → OpenAI (Anthropic client, GPT upstream; e.g. Claude Code's WebSearch on GPT):

| Anthropic | OpenAI | Note |
| --- | --- | --- |
| `web_search_2025xxxx`/`2026xxxx` | `{type:"web_search"}` | |
| `allowed_domains` / `blocked_domains` | `filters.allowed_domains` / `filters.blocked_domains` | |
| `user_location` | `user_location` | |
| `max_uses` | `max_tool_calls` (if no other built-in tool) else drop | Not exact: `max_tool_calls` also counts open_page/find_in_page? (verify). |
| `allowed_callers`, `response_inclusion`, `cache_control`, `defer_loading`, `strict` | — | Drop. |
| — | `include: ["web_search_call.action.sources"]` | **Always add.** Without it the converted `web_search_tool_result` has no URLs. |

### 2.4 tool_choice

- Anthropic: `{type:"tool", name:"web_search"}` (forced). `any` / `auto` / `none` as usual.
- OpenAI: `{type:"web_search"}` is accepted (echoed back as `web_search_preview`), but **forcing a search is broken on `gpt-6.1-sol`**. Both `{type:"web_search"}` and `"required"` with web_search as the only tool made the model loop: 101 empty reasoning items, no search, `status: incomplete`, `incomplete_details.reason: "max_messages"` (§10.3). **Map an Anthropic forced `web_search` choice to `"auto"`**, never to a forced OpenAI choice.
- Anthropic: `claude-sonnet-5-5` rejects forced choices outright (`tool_choice: type "tool" and "any" are not supported for this model`, 400); Haiku 5.5 accepts them. So an OpenAI forced `web_search` choice → Anthropic `{type:"tool", name:"web_search"}` must fall back to `auto` on models that reject it (or always use `auto`).
- Today `filterUnsupportedToolChoice` would drop the choice because the tool is dropped. It needs a `kind: "web_search"` normalized tool.

## 3. Response, non-streaming

### 3.1 Anthropic shape

```jsonc
"content": [
  { "type": "text", "text": "I'll search..." },
  { "type": "server_tool_use", "id": "srvtoolu_01...", "name": "web_search", "input": { "query": "claude shannon birth date" } },
  { "type": "web_search_tool_result", "tool_use_id": "srvtoolu_01...",
    "content": [ { "type": "web_search_result", "url": "...", "title": "...", "page_age": "April 30, 2025", "encrypted_content": "EqgfCio..." } ] },
    // or on error: "content": { "type": "web_search_tool_result_error", "error_code": "max_uses_exceeded" }
    // error_code: too_many_requests | invalid_tool_input | max_uses_exceeded | query_too_long | request_too_large | unavailable
  { "type": "text", "text": "Based on the search results, " },
  { "type": "text", "text": "Claude Shannon was born on April 30, 1916",
    "citations": [ { "type": "web_search_result_location", "url": "...", "title": "...", "cited_text": "<=150 chars", "encrypted_index": "Eo8BCio..." } ] }
],
"stop_reason": "end_turn",          // can be "pause_turn"; "tool_use" if mixed with client tools
"usage": { "server_tool_use": { "web_search_requests": 1 } }
```

- An error is still HTTP 200. An empty result is `content: []`, not an error.
- With a client tool in the same parallel group: `server_tool_use` comes **without** its result and `stop_reason:"tool_use"`. The result shows up at the start of the *next* response (paired by `tool_use_id`).

### 3.2 OpenAI shape

```jsonc
"output": [
  { "type": "reasoning", "id": "rs_...", "encrypted_content": "..." },        // reasoning models; paired with the next item
  { "type": "web_search_call", "id": "ws_...", "status": "completed",          // in_progress|searching|completed|failed|incomplete
    "action": { "type": "search", "query": "...", "queries": ["..."],           // query is deprecated, queries is current
                "sources": [ { "type": "url", "url": "..." } ] } },            // sources only with include
  { "type": "web_search_call", "id": "ws_...", "status": "completed", "action": { "type": "open_page", "url": "..." } },
  { "type": "web_search_call", "id": "ws_...", "status": "completed", "action": { "type": "find_in_page", "url": "...", "pattern": "..." } },
  { "type": "message", "role": "assistant", "content": [
    { "type": "output_text", "text": "... ([example.com](https://...?utm_source=openai)) ...",
      "annotations": [ { "type": "url_citation", "start_index": 2606, "end_index": 2758, "url": "...", "title": "..." } ] } ] }
]
```

- OpenAI usually writes the citation as a markdown link inside `text`; the annotation range covers that link.
- Sources may include `oai-sports` / `oai-weather` / `oai-finance` style feeds that are not real URLs.

### 3.3 Anthropic → Responses output (Claude upstream, OpenAI client)

| Anthropic | Responses | Note |
| --- | --- | --- |
| `server_tool_use(name=web_search)` + `web_search_tool_result` | One `web_search_call`: `id` = derived from the `srvtoolu_` id (e.g. `ws_` + suffix), `status: completed`, `action: {type:"search", query, queries:[query], sources: results.map(url)}` | Pair by `tool_use_id`. |
| Result is `web_search_tool_result_error` | `status: "failed"` | The error code is lost (or kept only in the carrier). |
| `server_tool_use` without a result (mixed turn) | Omit the visible item; keep the block in the carrier (§5) | It must go back to Claude unchanged next turn. |
| Text block with `citations` | `output_text` part (nanollm already emits one part per text block) + `annotations: [{type:"url_citation", start_index:0, end_index:<code-point length>, url, title: title ?? ""}]` | Indices are relative to the part, so no cross-block offsets are needed. Length in code points (§6.5). |
| `server_tool_use(name=web_fetch)` | No OpenAI equivalent (closest is `open_page`) | Out of scope; keep current behavior. |
| `usage.server_tool_use.web_search_requests` | — | Keep only in nanollm's usage records if needed. |
| `stop_reason: pause_turn` | — | See §6.1. |
| Order | Currently: all reasoning, then one `msg_1`, then tool calls | Fine for display; for history the carrier keeps the real order. |

### 3.4 Responses → Anthropic output (GPT upstream, Anthropic client)

| Responses | Anthropic | Note |
| --- | --- | --- |
| `web_search_call` (any action) | `server_tool_use {id: "srvtoolu_" + <ws id>, name:"web_search", input:{query}}` + `web_search_tool_result {tool_use_id, content:[...]}` | `query` = `queries.join(" / ")` ‖ `query` ‖ `open_page: <url>` ‖ `find_in_page: <pattern>`. Map open_page/find_in_page too, because each `ws_` item must round-trip for reasoning pairing. |
| `action.sources[]` | `web_search_result {url, title, page_age:null, encrypted_content: <carrier>}` | Sources have no title. Use a title from a matching annotation if one exists, else the URL. |
| `status: failed/incomplete` | `content: {type:"web_search_tool_result_error", error_code:"unavailable"}` | |
| `output_text` + `url_citation` ranges | Split the text into blocks at range boundaries. A cited span becomes `{type:"text", text: span, citations:[{type:"web_search_result_location", url, title, cited_text: span.slice(0,150), encrypted_index: <carrier or placeholder>}]}` | Nested or overlapping ranges: attach every citation that covers a block. **Index units must be verified** (code points vs UTF-16; matters for CJK and emoji). |
| Count of `web_search_call` with `action.type=search` | `usage.server_tool_use.web_search_requests` | |
| `reasoning` | `thinking` / `redacted_thinking` (existing) | Keep position relative to search blocks. |

## 4. Streaming

### 4.1 Anthropic stream (web search part)

```
content_block_start  {index:1, content_block:{type:"server_tool_use", id:"srvtoolu_..", name:"web_search", input:{}}}
content_block_delta  {index:1, delta:{type:"input_json_delta", partial_json:"{\"query\":\"...\"}"}}
content_block_stop   {index:1}
   ... pause while the search runs ...
content_block_start  {index:2, content_block:{type:"web_search_tool_result", tool_use_id:"srvtoolu_..", content:[...full results...]}}
content_block_stop   {index:2}
content_block_start  {index:3, content_block:{type:"text", text:"", citations:[]}}   // empty citations array on blocks that will carry citations (verify)
content_block_delta  {index:3, delta:{type:"citations_delta", citation:{type:"web_search_result_location", ...}}}
content_block_delta  {index:3, delta:{type:"text_delta", text:"Claude Shannon was born..."}}
content_block_stop   {index:3}
message_delta        {delta:{stop_reason:"end_turn"}, usage:{..., server_tool_use:{web_search_requests:1}}}
```

### 4.2 OpenAI stream (web search part)

```
response.output_item.added            {output_index:1, item:{type:"web_search_call", id:"ws_..", status:"in_progress", action:{type:"search"}?}}  // query usually not known yet
response.web_search_call.in_progress  {item_id, output_index}
response.web_search_call.searching    {item_id, output_index}
response.web_search_call.completed    {item_id, output_index}
response.output_item.done             {output_index:1, item:{..., status:"completed", action:{type:"search", queries:[..], sources:[..]}}}
... message item ...
response.output_text.delta            ... (text includes markdown link citations)
response.output_text.annotation.added {item_id, output_index, content_index, annotation_index, annotation:{type:"url_citation", start_index, end_index, url, title}}
response.output_text.done / content_part.done (part.annotations filled) / output_item.done
```

No search-specific events carry data; the `action` (query, sources) is only reliable in `output_item.done`.

### 4.3 Anthropic stream → Responses stream

1. `content_block_start server_tool_use(web_search)`: buffer `input_json_delta`. At `content_block_stop`, emit `output_item.added` (web_search_call, `in_progress`, `action:{type:"search", query}`), `web_search_call.in_progress`, `web_search_call.searching`.
2. `content_block_start web_search_tool_result`: emit `web_search_call.completed` and `output_item.done` (with `sources`, or `status:"failed"` on error), then the carrier item (`reasoning` added/done, see §5).
3. Text blocks: collect `citations_delta` per block. At `content_block_stop`, emit `response.output_text.annotation.added` for each one (`start_index:0`, `end_index:` length of the part), then `output_text.done` / `content_part.done` with `annotations` filled in. Exact and cheap, because Anthropic gives citations per block and nanollm emits one part per block.
4. If a message item is open when a search starts (text before the search), close it (`output_item.done`) and open a new `message` item for the text after. Today `streams.ts` keeps a single `messageOutputIndex` open for the whole response.
5. `message_delta.usage.server_tool_use`: no Responses counterpart.

### 4.4 Responses stream → Anthropic stream

1. `output_item.added web_search_call`: emit `content_block_start server_tool_use {id:"srvtoolu_"+ws id, name:"web_search", input:{}}` right away, so Claude Code-style clients can show "searching". Ignore the `in_progress/searching/completed` events.
2. `output_item.done web_search_call`: emit `input_json_delta` with the final `{query}`, `content_block_stop`, then a complete `web_search_tool_result` block (`content_block_start` + `content_block_stop`). Fallback: if a `web_search_call` isn't sequential with other items, emit nothing until done.
3. `output_text.annotation.added`: the text has already been streamed, so the exact block split from §3.4 isn't possible without buffering the whole message. Options:
   - (a) Emit `citations_delta` on the **currently open** text block, with `cited_text` = the annotated slice. Valid shape, but block-level granularity is coarser than the range. **Recommended.**
   - (b) Drop citations in streaming. OpenAI text already contains inline markdown links.
   - (c) Buffer text until the message item is done, then emit split blocks. Exact, but kills incremental text.
4. `response.completed`: `message_delta.usage.server_tool_use.web_search_requests` = count of search actions.

## 5. History (multi-turn request)

### 5.1 What each upstream requires

- **Anthropic**: the assistant turn must contain `server_tool_use` + `web_search_tool_result` with every `encrypted_content` **unchanged**, or the request fails with 400. Citations' `encrypted_index` must be passed back too. Dropping `citations` from text blocks is accepted (live-tested, §9.3). A `server_tool_use` still waiting on its result (mixed turn / pause_turn) must be present, with the same tools defined.
- **OpenAI** (stateless, `store:false` / no `previous_response_id`): a `web_search_call` input item (`{type, id, status, action}`) must come right after its paired `reasoning` item, or you get 400: `Item 'ws_…' of type 'web_search_call' was provided without its required 'reasoning' item` (and the reverse error for a reasoning item without its following item). This error comes from community reports with real reasoning items present; it couldn't be reproduced here (the tested upstream returned no reasoning items alongside searches). **Live test without reasoning items (§10.3): OpenAI accepted every `web_search_call` variant**: original, made-up `ws_` id, modified `action`, no `id` at all. `output_text.annotations` are accepted in input assistant messages.
- **Anthropic blobs are bound to the account, not the model** (§10.3). Sonnet 5.5's `encrypted_content` replays fine on Opus 5.5 / Sonnet 5 through the same upstream, but is rejected (`Invalid encrypted_content`) by another Anthropic account (Vercel-routed Haiku). A subset of the original results is accepted, and so are changed `url`/`title` values with the original blob, so only the blob is validated.

### 5.2 The four cases

| History produced by | Sent to | Possible? | How |
| --- | --- | --- | --- |
| Claude (via nanollm, client is OpenAI) | Claude | Lossless, **only with a carrier** | OpenAI clients won't echo `encrypted_content` on search results (they have no field for it). Carry the original blocks in a field the client echoes back. |
| GPT (via nanollm, client is Anthropic) | GPT | Lossless, **only with a carrier** | Anthropic clients echo `server_tool_use.id` / `input` and `web_search_result.encrypted_content` verbatim, so the `ws_` id and action ride along there. |
| Claude | GPT (model switched) | Degraded | **Rewrite the search as a plain `function_call` + `function_call_output`** (§11): the output lists title, url, page_age and the `cited_text` snippets collected from the Claude citations. In testing this beat the text note: GPT named the source it actually cited first. A synthetic `web_search_call` is also accepted (§10.3) but carries less. |
| GPT | Claude (model switched) | Degraded | Can't fabricate `encrypted_content` / `encrypted_index` (live-tested: both 400). Drop the pair and strip citations. **Add a text note in the assistant's own voice listing query + sources, plus a retention line** ("full page contents were retrieved and read; only source metadata is kept in this history"). With that note Claude answered follow-ups without disowning its answer (§11). Bare text, an empty-result block, or a `tool_use`/`tool_result` rewrite all make Claude retract its earlier claims, because GPT never provides result text. |

### 5.3 Carrier design (extends the existing reasoning carrier)

**Claude upstream, OpenAI client** (e.g. Codex on Claude):
- Visible output: the `web_search_call` item from §3.3.
- Carrier: an extra `reasoning` item next to it with `summary: []` and `encrypted_content: "nanollm.websearch.v1:" + base64(JSON{ blocks: [server_tool_use, web_search_tool_result, ...cited text blocks?] })`. Responses clients already echo reasoning `encrypted_content` verbatim. That's why `nanollm.reasoning.v1:` works, and Codex requests `reasoning.encrypted_content`.
- Back on the request: decode the carrier and splice the original blocks into the assistant turn at the carrier's position. Drop the visible `web_search_call` item (it duplicates the carrier). The size cost is real: `encrypted_content` is a few KB per result, ×N results, ×1.33 for base64. Consider gzip.
- Text citations: Codex keeps only the `text` of `output_text` (annotations are dropped from its history). Claude accepts citation-less text (§9.3), so the carrier only needs the `server_tool_use` + `web_search_tool_result` blocks.
- If this history is later sent to a GPT upstream: strip the `nanollm.websearch.v1:` reasoning items (they aren't real OpenAI ciphertext). The synthetic `web_search_call` items were accepted in testing, but to be safe convert them to the degraded text form (§5.2).
- If it is sent to a **different Anthropic account** (another provider entry in a fallback group): the blobs will 400 (§10.3). Degrade to the text note. The carrier should record which upstream account produced it, the same idea as reasoning `origin`. Same-account model switches (Sonnet → Opus) can replay as-is.

**GPT upstream, Anthropic client** (e.g. Claude Code on GPT):
- `server_tool_use.id = "srvtoolu_" + ws_id` (recoverable), `input = {query, ...}`. Anthropic clients echo `input` verbatim, so the full original `action` can be stored in it (e.g. `input: {query, action}`); clients display `input.query`.
- `web_search_result.encrypted_content` = a marker (`nanollm.websearch.v1:` + url), not needed for reconstruction if the id + input carry everything. Search calls with no sources produce `content: []`, which is why the id and input are the main channel, not the results.
- `encrypted_index` on citations = a marker. Only nanollm ever reads it back.
- Back on the request: rebuild `web_search_call {id: ws_id, status, action}` **in order** right after its `reasoning` item. Reasoning already round-trips as `redacted_thinking` with `origin: "openai-responses"`; the ordering must be kept, see §7. Rebuild `url_citation` annotations from the cited text-block offsets, or drop them.
- If this history is sent to a Claude upstream: the markers aren't real Claude data, so drop the pair and degrade (§5.2).
- Note: Claude Code's WebSearch tool runs as a one-shot sub-request. It parses `web_search_tool_result` (title, url) and text, and doesn't replay the search blocks in later turns. The response conversion (§3.4/§4.4) is what matters most there; history matters for general Anthropic clients.

## 6. Edge cases

### 6.1 `pause_turn` (Claude upstream only)
A Responses client has no concept of it. A completed response with no tool calls looks like the final answer, so the turn ends early. Recommendation: nanollm auto-continues server-side. Re-send the request with the paused assistant content appended (same tools), and repeat up to N times. Merge the outputs into one Responses response, and in streaming keep emitting into the same response. This matches Anthropic's own guidance ("send the paused assistant message back unchanged").

### 6.2 Mixed server + client tools (Claude upstream)
`stop_reason: tool_use` with an unresolved `server_tool_use`. The OpenAI client sees only the function call(s). The unresolved block must be in the carrier so it goes back into the assistant turn. The next Claude response starts with the `web_search_tool_result` for the old id; map it to a `web_search_call` (`completed`) using that id.

### 6.3 Dynamic filtering (`_20260209+` with default `allowed_callers`)
The response contains `code_execution` / `bash_code_execution_tool_result` blocks, and the nested search pairs carry `caller`. Recommendation: when nanollm builds the Anthropic tool from an OpenAI request, force `web_search_20250305` (or `allowed_callers:["direct"]`). When an Anthropic client sends `_20260209+` to a GPT upstream, just map it to `web_search`; the flag doesn't matter there.

### 6.4 Chat Completions
Out of scope. Chat search is a model (`gpt-5-search-api` + `web_search_options`), not a tool; annotations are `{type:"url_citation", url_citation:{...}}` on the message. Keep dropping the tool for Chat targets.

### 6.5 Upstream quirks seen on a native Responses channel (§10)
- A blank message item (`id: msg_ack_…`, text `" "`, no `phase`) arrives first, even before `response.in_progress`. Converters must tolerate events before `in_progress` and must not turn a whitespace-only message into a visible block.
- Messages carry `phase: "final_answer"`, a field missing from SDK 7.18 types. Preserve unknown fields in passthrough.
- No `reasoning` items were returned with searches even with `include: ["reasoning.encrypted_content"]` (the echoed `include` was `null`). Forced-choice runs did return reasoning items. The carrier and pairing logic must work whether or not reasoning items exist.
- `max_tool_calls: 1` allowed 1 `search` + 1 `open_page`; earlier (via Vercel) 2 searches. Not a reliable `max_uses` equivalent.

### 6.6 Citation index units
OpenAI `start_index`/`end_index` are **Unicode code points** (live-tested with an answer starting `🔭🌌🧪`: the code-point slice matches, the UTF-16 slice is off by 3). JS `string.slice` uses UTF-16, so split with `Array.from(text)` (or convert offsets) when building Anthropic text blocks, and count code points when building annotations from Anthropic block lengths.

## 7. What changes in nanollm

Current behavior:
- Tools: hosted/server tools are dropped during normalization (`normalizeOpenAIResponsesTool`, `denormalizeAnthropicTool` only accepts function tools), so web search silently disappears across protocols.
- History: Anthropic `server_tool_use` → normalized **function** tool call, and `web_search_tool_result` → a tool message with `title\nurl\npage_age` text (`requests.ts:640`, `:697`). Sent to OpenAI, that becomes a `function_call` for a function that isn't declared, plus a `function_call_output`. It works in a degraded way.
- Responses `web_search_call` input items: not handled. Text `citations` / `annotations` are always emitted as `null` / `[]`.

Needed:
1. `NormalizedTool` gets `kind: "web_search"` with `{allowedDomains, blockedDomains, userLocation, maxUses, contextSize, externalWebAccess}`. Denormalize per target (§2.3), and drop it for Chat.
2. Add a `NormalizedMessage.parts` entry like `{type:"web_search", id, origin, action|query, results[], status, carrier}`, **inside `parts`** (not `toolCalls`) so its order relative to reasoning and text is kept. OpenAI's reasoning↔web_search_call pairing depends on that order. The Responses request denormalizer must then emit items in part order instead of grouping by kind.
3. Add `citations` on normalized text parts: `{url, title, citedText, start?, end?, opaque?}`.
4. Response normalizers/denormalizers and both stream converters (§3, §4), including closing and reopening the message item around searches.
5. Carrier `nanollm.websearch.v1:` plus origin checks (§5.3); degraded paths for switched upstreams.
6. `pause_turn` auto-continue in `src/proxy` (§6.1).
7. Usage: map `web_search_requests` ↔ count of search actions.

## 8. Open questions

Status after the live tests (§9 via Vercel, §10 native via nanollm). ✅ answered, ⚠️ partly, ❓ open:

1. ⚠️ Made-up `ws_` id without a reasoning item: **accepted** natively (§10.3). Still unverified: the case where real reasoning items are present and the paired `web_search_call` is missing or swapped (the community-reported 400). The tested channel never returned reasoning items next to searches.
2. ✅ Anthropic accepts text with citations removed, thinking blocks removed, a subset of results, or changed `url`/`title` (blob kept). It rejects any changed or made-up `encrypted_content` / `encrypted_index`.
3. ✅ `tool_choice`: OpenAI accepts `{type:"web_search"}` but forcing (or `"required"`) loops to `max_messages` on gpt-6.1-sol, so don't map to it. Sonnet 5.5 rejects Anthropic forced choices; Haiku 5.5 accepts them.
4. ✅ OpenAI index unit = code points (confirmed on both channels).
5. ✅ `max_tool_calls` is not a usable `max_uses` mapping.
6. ❓ Codex history behavior: needs a Codex session through nanollm.
7. ✅ Native Anthropic stream: a cited text block starts with `content_block_start {type:"text", text:"", citations: []}`, then **one `citations_delta` before any `text_delta`**. Uncited blocks have no `citations` key.
8. ✅ Anthropic blobs are account-bound, not model-bound.

## 9. Live test results (2026-10-20, Vercel AI Gateway)

Models: `openai/gpt-6-luna` via `/v1/responses`, `anthropic/claude-haiku-5.5` via `/v1/messages`. Prompt: a Chinese question about the 2026 Nobel Prize in Physics (needs a search).

### 9.1 The gateway is a translation layer on both endpoints

Results below are "upstream behavior seen through Vercel's conversion". Where the gateway's per-provider error details expose the upstream's own error message, the result reflects native behavior.

Vercel quirks (also relevant if nanollm ever uses Vercel as an upstream):
- Responses: response id `gen_…`; message ids `msg_<timestamp>_…` instead of OpenAI's; `web_search_call.id` is `fc_…` and the real `ws_…` moves to a non-standard `call_id`. The real OpenAI response id is in `provider_metadata.openai.responseId`.
- Replaying the gateway's own Responses output fails: the gateway turns its `fc_` web_search_call into a function call, and OpenAI returns `No tool output found for function call ws_…` (400).
- `tool_choice: {type:"web_search"}` is rejected by the gateway's validator.
- Messages non-stream: every **uncited** text block gets fake `char_location` citations (document_index 0..N, empty `cited_text`, one per search result). Native Anthropic doesn't emit these.
- Messages stream: **all `citations_delta` events are dropped**. Text is still split into blocks at citation boundaries.
- The top-level error message on a 400 can come from the *last* fallback provider (e.g. Bedrock's "tool type not supported"). The real reason is in `providerMetadata.gateway.routing.modelAttempts[].providerAttempts[].error`.

### 9.2 Response format observations

OpenAI (gpt-6-luna):
- Non-stream: `[web_search_call, (reasoning), message]`. `action` has `query` (deprecated) and `queries[]` (2 queries per call), plus `sources` (31 URLs with `include`). One `url_citation` per answer; the annotation range covers the inline markdown link `([kva.se](https://…?utm_source=openai))` at the end of the text.
- The non-stream response had **no reasoning item** despite `include: ["reasoning.encrypted_content"]` and 55 reasoning tokens; the stream response did have one (`rs_…`, encrypted_content ~1.9 KB, empty summary). In the gateway output the reasoning item comes *after* the web_search_call (native order is normally reasoning first; likely gateway reordering).
- Stream order confirmed: `output_item.added` (web_search_call, `status:"in_progress"`, **no `action`**) → `web_search_call.in_progress` → `.searching` → `.completed` → `output_item.done` (full `action` with queries + sources) → reasoning item → message: `content_part.added` → `output_text.delta`×N → **`output_text.annotation.added`** (after all deltas) → `output_text.done` → `content_part.done` (annotations filled) → `output_item.done` → `response.completed`.
- `max_tool_calls: 1` → 2 searches still ran (see §8.5).

Anthropic (claude-haiku-5.5):
- Non-stream content: `thinking` (empty text, signature only) → `server_tool_use {query}` → `web_search_tool_result` (10 results, `page_age` like "14 days ago", `encrypted_content` ~3.3 KB each, ~33 KB per search) → `thinking` → many `text` blocks. Cited blocks carry `web_search_result_location` (`encrypted_index` 200 chars, `cited_text` ≤150 chars + "..."). Uncited blocks are interleaved, e.g. `"该天文台"` + cited `"是一立方公里的冰体…"`.
- `usage.server_tool_use: {web_search_requests: 1, web_fetch_requests: 0}`.
- Stream: `server_tool_use` starts with `input:{}`, the query streams as several `input_json_delta` fragments, and `web_search_tool_result` arrives complete in one `content_block_start`, as documented.

### 9.3 History replay

Anthropic (the upstream's own error messages are visible in the gateway's per-provider error details):

| Case | Result |
| --- | --- |
| Replay unchanged (fake `char_location` citations removed) | 200, answers the follow-up from the citations |
| Citations stripped from text blocks | 200 |
| Thinking blocks dropped, search blocks kept | 200 |
| One result's `encrypted_content` tampered | **400** `Invalid encrypted_content in search_result block` |
| Fabricated pair with fake `encrypted_content` | **400** (same) |
| Fake `encrypted_index` on a text citation | **400** `Invalid encrypted_index in text block` |
| Fabricated pair `srvtoolu_ws_…` with `content: []` | **200**, but Claude then says the search returned nothing and disowns its earlier answer |
| Pair dropped, text only | 200; Claude doesn't know the URL and says the earlier answer was unverified |
| Pair dropped, text note listing query + sources + original text | 200; Claude answers correctly (**best fallback**) |
| Empty pair + note + text | 200; Claude answers but says the details were unconfirmed |
| `tool_choice: {type:"tool", name:"web_search"}` | 200, forces a search even for "你好" |

OpenAI through the gateway: native-format `web_search_call` replay (real `ws_` id with and without its reasoning item, or a fake `ws_` id) all returned 200, and so did a plain assistant message with `url_citation` annotations. The gateway probably doesn't forward these items as-is (see §9.1), so **the OpenAI pairing rules in §5.1 are still based on documented error reports, not on this test.**

Takeaways for the design:
1. Anthropic strictly validates search history: only the original encrypted blobs pass. This confirms the carrier approach for same-origin replay.
2. For the degraded path into Claude, use a **text note with query + sources** and no fake search blocks.
3. Citations can be dropped freely when replaying to Claude, which simplifies the carrier (it only needs the `server_tool_use` + `web_search_tool_result` blocks).
4. Offsets are code points.

## 10. Live test results (2026-10-20, nanollm gateway, native upstreams)

Endpoint: `https://nanollm.xiaogenban1993.com/v1`, models `gpt-6.1-sol` (`/v1/responses`) and `claude-sonnet-5-5` (`/v1/messages`). Both are same-format passthrough in nanollm, and the IDs are native (`resp_…`, `ws_…`, `msg_…`, `rs_…`; `msg_011…`, `srvtoolu_01…`, `req_011…`), so these results reflect upstream behavior. One caveat: nanollm's Responses passthrough removes `id` from `message`/`reasoning`/`function_call`/`custom_tool_call` input items when `store:false` (`stripOpenAIResponsesUnstoredItemIds`). `web_search_call` ids are forwarded as-is.

### 10.1 OpenAI (gpt-6.1-sol)

- Non-stream output: `[web_search_call(search), web_search_call(open_page), message(phase:"final_answer")]`. `search` action has `query` + `queries[]` + `sources` (33 URLs). `open_page` action is `{type:"open_page", url}` with no `sources`. One `url_citation` covering the trailing inline markdown link.
- Stream order: `response.created` → **`output_item.added` msg_ack (text `" "`) … `output_item.done`** → `response.in_progress` → per search item: `output_item.added` (`status:"in_progress"`, **no `action`**) → `web_search_call.in_progress` → `.searching` → `.completed` → `output_item.done` (full `action`) → message: `content_part.added` → `output_text.delta`×N → `output_text.annotation.added` (after all deltas) → `output_text.done` → `content_part.done` → `output_item.done` → `response.completed`.
- `response.completed.output` = `[message(ack), web_search_call, web_search_call, message]`.
- Emoji test: code-point offsets (UTF-16 slice off by 3).

### 10.2 Anthropic (claude-sonnet-5-5)

- Non-stream: `server_tool_use` (query in Chinese) → `web_search_tool_result` (9 results, `encrypted_content` ~2.2 KB each, `caller:{type:"direct"}` on the stream frame) → alternating uncited / cited `text` blocks (`web_search_result_location`, `encrypted_index` 200 chars). No thinking blocks. `usage.server_tool_use: {web_search_requests:1, web_fetch_requests:0}`.
- Stream: `server_tool_use` starts with `input:{}`, then a `ping`, then `input_json_delta` fragments (the first one is empty). `web_search_tool_result` arrives complete in one `content_block_start`. Cited text blocks: `content_block_start {citations: []}` → `citations_delta` → `text_delta`×N. Uncited blocks have no `citations` key. The final block wrote sources as markdown links itself.

### 10.3 History replay

Follow-up question each time: "Using only the context above, what was the first source URL you cited?"

Anthropic (claude-sonnet-5-5 unless noted):

| Case | Result |
| --- | --- |
| Replay unchanged | 200, correct URL |
| Citations stripped | 200, correct URL |
| One `encrypted_content` tampered | 400 `Invalid encrypted_content in search_result block` |
| Made-up pair with fake `encrypted_content` | 400 (same) |
| Fake `encrypted_index` | 400 `Invalid encrypted_index in text block` |
| Made-up pair with `content: []` | 200, but Claude disowns its whole answer ("search returned nothing … don't trust it") |
| Text only (pair dropped) | 200, Claude disowns its answer ("I never actually searched") |
| Text note (query + sources) + text | 200, correct URL; adds a mild caveat that the search returned only titles/links |
| Only the first 3 of 9 results kept | 200, but Claude notices a cited source is missing and corrects itself, so **don't prune results** to save carrier size |
| Result `url`/`title` changed, blob kept, citations stripped | 200, correct URL (only the blob is validated) |
| Same history → `claude-opus-5-5`, `claude-sonnet-5` (same nanollm upstream) | 200, cross-model replay works |
| Same history → `claude-haiku-5-5` (routed via Vercel, another Anthropic account) | 400 `Invalid encrypted_content` → **account-bound** |
| Forced `tool_choice` `{type:"tool", name:"web_search"}` | 400 on Sonnet 5.5 (`type "tool" and "any" are not supported for this model`) |

OpenAI (gpt-6.1-sol, store:false; the original output had no reasoning items):

| Case | Result |
| --- | --- |
| Replay full output (ack msg, 2× web_search_call, final message) | 200, correct URL |
| Final message only (with annotations) | 200 |
| Made-up `ws_nanollm…` search item + message | 200 |
| `ws_` id with last char changed + message | 200 |
| Real items with `action.query` changed | 200 |
| Real items without `id` | 200 |
| `tool_choice: {type:"web_search"}`, input "你好" | `incomplete` (`max_messages`), 101 empty reasoning items, no search |
| `tool_choice: "required"` (web_search only), input "你好" | same loop |
| `max_tool_calls: 1`, four-topic question | 1 search + 1 open_page, then the answer |

The OpenAI answers don't prove the model used the replayed items: the answer text already contains the cited URL as an inline markdown link.

### 10.4 Design consequences

1. Same-account Claude replay is lossless with the carrier; cross-account (fallback to another Anthropic provider) must degrade. Record the producing upstream in the carrier.
2. Degraded Claude history: use the **text note**, not an empty result block and not bare text, otherwise Claude disowns its earlier answer.
3. Keep all original results in the carrier; pruning changes the model's behavior.
4. OpenAI tolerates synthetic `web_search_call` items (at least without reasoning items), so Anthropic-origin searches could be shown to GPT as synthetic search items. The text note remains the safer default.
5. Never translate a forced web-search choice into OpenAI's forced choice; use `auto`.
6. Stream converters must tolerate OpenAI's `msg_ack` blank message before `response.in_progress`, and `phase` on messages.

## 11. Fallback test: rewrite cross-protocol search as a plain function call (2026-10-20, nanollm gateway)

Idea: when history can't be replayed natively, turn the search into an ordinary function call plus a plaintext result instead of a text note. nanollm already does this implicitly today (`server_tool_use` → function call, `web_search_tool_result` → `title\nurl\npage_age` text).

Setup: fresh real searches on both sides. Then the history was rebuilt for the *other* protocol in three forms: (1) function named `web_search` (same name as the native tool), (2) function named `web_search_history` (not declared), (3) text note. Follow-ups: F1 "Using only the context, what was the first source URL you cited?"; F2 "Look up the 2026 Chemistry Nobel" (needs a new search).

GPT-origin history → Claude (`tool_use` in the assistant turn, `tool_result` in the next user turn, then the final text as another assistant turn):

| Form | Valid | F1 | F2 |
| --- | --- | --- | --- |
| `tool_use` name `web_search` (collides with the declared server tool) | 200 | Correct URL, but retracts details ("only saw titles and URLs") | Native `server_tool_use web_search` |
| `tool_use` name `web_search_history` (undeclared) | 200 | Same retraction | Native search, opens by retracting the old answer |
| Text note | 200 | Correct URL, mild retraction | Native search, also retracts |
| `tool_use` + retention line in `tool_result` (2 runs) | 200 | Retracts 2/2 | — |
| **Text note + retention line in assistant voice** (2 runs) | 200 | **Correct, no retraction 2/2** | — |

Claude-origin history → GPT (`function_call` + `function_call_output` with title/url/page_age + `cited_text` snippets, then the assistant message):

| Form | Valid | F1 | F2 |
| --- | --- | --- | --- |
| `function_call` name `web_search` (collides with hosted tool) | 200 | Correct (the source Claude actually cited first) | Native `web_search_call` |
| `function_call` name `web_search_history` | 200 | Correct | Native `web_search_call` |
| Text note | 200 | Picked the first link in the list instead of the first one cited | Native `web_search_call` |

Findings:
1. Both APIs accept a historical function call whose name collides with the declared native search tool, and accept an undeclared function name. Neither model imitated the fake function later; both used native search for new lookups. A distinct name like `web_search_history` is still the safer choice (no ambiguity in logs or for clients).
2. The deciding factor is **how much plaintext the converted result has**, not its shape. Claude-origin results carry titles, page ages and `cited_text` snippets, enough for GPT. GPT-origin results carry only URLs (plus annotation titles), so Claude sees its earlier specific claims as unsupported.
3. Claude treats a `tool_result` as exactly what it saw. A claim inside it that more was read doesn't help. The same statement in its own assistant voice does. So for Claude, prefer the assistant-voice text note. That also avoids splitting the assistant turn to fit `tool_use`/`tool_result`.
4. The retention line must stay truthful: OpenAI did fetch and read the pages (`open_page` actions show it); only nanollm can't carry the content.
5. Small samples (1–2 runs per cell, one model per side). Treat these as directional.

Recommended degraded paths:
- Claude history → GPT: `function_call` (`web_search_history`) + `function_call_output` with title/url/page_age/cited snippets.
- GPT history → Claude: assistant-voice text note with queries, sources (annotation titles + URLs) and the retention line, placed before the answer text.

## 12. Response loss per direction, and Claude's thinking rule for converted tool calls (2026-10-21)

### 12.1 Neither side is a superset

OpenAI has richer **actions**; Claude has richer **results, citations and errors**. Each direction loses something different.

| Information | OpenAI Responses | Anthropic Messages | Lost when converting |
| --- | --- | --- | --- |
| Action kinds | `search`, `open_page {url}`, `find_in_page {url, pattern}` | Only `web_search {query}` (web_fetch is a separate tool and needs page content) | OpenAI → Claude: open_page / find_in_page become pseudo-queries |
| Queries per call | `queries[]` (often 2) | One `query` | OpenAI → Claude: joined into one string (the full array can ride in `input`) |
| Call status | in_progress / searching / completed / failed / incomplete | Block open = running; result or error = done | Minor |
| Result title | — (sources are `{type:"url", url}` only; titles only for cited URLs via annotations) | `title` per result | Claude → OpenAI: titles of uncited results. OpenAI → Claude: titles must be filled from annotations or the URL |
| Result `page_age` | — | per result | Claude → OpenAI |
| Result content | — (never exposed) | `encrypted_content` (opaque) | Both: nothing readable; only the carrier preserves it for same-origin replay |
| Non-URL sources | `oai-sports` / `oai-weather` / `oai-finance` | — | OpenAI → Claude: skip or show as a pseudo-URL |
| Error detail | `status: failed` only | `error_code` (max_uses_exceeded, too_many_requests, query_too_long, …) | Claude → OpenAI: the error reason |
| Citation position | Character range in the message (code points) | Block boundary | Neither: exact both ways in non-stream (split ↔ range); stream OpenAI → Claude is block-level |
| Citation quote | — | `cited_text` (≤150 chars of the **source**) | Claude → OpenAI: snippets lost. OpenAI → Claude: `cited_text` can only be the answer span, not the source text, so its meaning changes |
| Citation id | — | `encrypted_index` | OpenAI → Claude: marker only |
| Message phase | `phase: "final_answer"` / blank `msg_ack` | — | OpenAI → Claude: dropped (fine) |
| Search count | count of search actions | `usage.server_tool_use.web_search_requests` | Derivable both ways |
| Pause / pending | — | `stop_reason: pause_turn`, unresolved `server_tool_use` (mixed turn) | Claude → OpenAI: must be handled inside nanollm (auto-continue, carrier) |
| Dynamic-filtering blocks | — | code_execution blocks + `caller` | Claude → OpenAI: avoided by forcing `web_search_20250305` / `allowed_callers:["direct"]` |

For display, the losses are mostly cosmetic. Claude Code renders title + URL and Codex renders the query. What the client can't see doesn't matter as long as same-origin history goes through the carrier, which preserves everything. In the switched-model fallback, Claude → GPT keeps more (titles, page_age, snippets) than GPT → Claude (URLs + annotation titles). That asymmetry is why the GPT → Claude fallback needs the retention line (§11).

### 12.2 Does a converted function call need a thinking block on Claude?

The old documented rule: with thinking enabled, the assistant turn whose `tool_use` is answered by the final `tool_result` must start with a `thinking` block ("Expected `thinking` or `redacted_thinking`, but found `tool_use`…").

> Correction (see §13): the `claude-sonnet-4-6` / `claude-opus-4-6-thinking` channel on this gateway ignores the `thinking` field (it accepted `thinking.type: "bogus"`), so the 4.6 column below doesn't test the rule. The Sonnet 5.5 results are valid: `thinking` reaches Anthropic unchanged there.

Live tests via the nanollm gateway, client tool `get_weather`:

| Case | claude-sonnet-5-5 (Anthropic) | claude-sonnet-4-6 / claude-opus-4-6-thinking (Vertex) |
| --- | --- | --- |
| `thinking: adaptive`, final tool turn without thinking | 200 | 200 |
| `thinking: enabled, budget 1024`, final tool turn without thinking | 200 | 200 |
| Final tool turn starting with text instead of thinking | 200 (adaptive and enabled) | — |
| Earlier finished tool turn without thinking, new user question | 200 | — |
| Empty `thinking` placeholder / fake signature | 200, but nanollm's passthrough removed the block first (`dropForeignClaudeSignatures`), so Claude never saw it | — |

Conclusions:
1. The rule isn't enforced on the models tested, so **no empty-thinking fallback is needed for Claude**. A placeholder wouldn't help anyway: Claude rejects signatures it didn't issue, and nanollm already removes such blocks for Claude upstreams. The empty placeholder (`addDeepSeek*Placeholders`) exists for DeepSeek only.
2. The recommended GPT → Claude fallback is a text note, which has no `tool_use`, so the question doesn't arise there. The Claude → GPT fallback produces `function_call` items for OpenAI, which accepted them without reasoning items (§11).
3. Rewriting searches as ordinary function calls means they automatically go through the existing reasoning-history rules. For example, a DeepSeek upstream would get its placeholder thinking on those turns just like any other foreign tool call.
4. Caveat: older Claude models, or other channels, may still enforce the rule. If one does, the safe fix is to drop thinking from that turn entirely or disable thinking for the request, not to add a fake block.

## 13. Where the "a tool call must be preceded by thinking" assumption comes from (2026-10-21)

### 13.1 The rule is real, but it belongs to manual extended thinking

The error message (2025, Claude 3.7 Sonnet / Claude Sonnet 4, `thinking: {type:"enabled"}`):

```
messages.1.content.0.type: Expected `thinking` or `redacted_thinking`, but found `tool_use`.
When `thinking` is enabled, a final `assistant` message must start with a thinking block
(preceeding the lastmost set of `tool_use` and `tool_result` blocks). We recommend you include
thinking blocks from previous turns. To avoid this requirement, disable `thinking`.
```

Seen widely by gateways and clients that rebuild history: Vercel AI SDK issue vercel/ai#7729 (claude-sonnet-4, Aug 2025), opencode #3077, LibreChat discussion #11598 (Bedrock), Discourse AI (Claude 3.7). Anthropic's own cookbook "Extended thinking with tool use" demonstrates it with a "TEST 1: WITHOUT thinking block → 400" cell.

Current docs scope it to manual mode only:
- Extended thinking page: "Manual mode adds one requirement: the final assistant turn of a thinking-enabled request must begin with a thinking block ([adaptive thinking] drops that requirement)."
- Models that only have manual mode: Claude Opus 4.5, Haiku 4.5, Sonnet 4.5 and earlier Claude 4 / 3.7. Manual mode is deprecated on 4.6 and documented as a 400 on 4.7+ (including Sonnet 5.5).

So the assumption was correct for the whole 3.7 → 4.5 era, when manual thinking was the only thinking mode and every gateway converting OpenAI history hit this error.

### 13.2 Related rules that reinforce the same intuition (all still current)

1. If a thinking block exists for a tool-use turn, it must come back with the `tool_use`, complete and unmodified. Dropping `redacted_thinking` or rebuilding the message → 400 "`thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified".
2. Signatures are verified: a foreign or empty signature → "Invalid `signature` in `thinking` block". This is why a fake or empty placeholder never works on Claude.
3. **New on Fable 5.1 / Opus 5.5 / Sonnet 5.5 / Haiku 5.5: signatures are bound to the prefix.** A replayed thinking block is accepted only while the `system` prompt, `tools` and every earlier message are unchanged: "Invalid `signature` in `thinking` block. The block is bound to a different conversation." Enforced for accounts created on or after 2026-08-31, or when `thinking.block_binding.prefix_mismatch_behavior` is set. The fix is to strip thinking from the edited point on, or to send beta `thinking-binding-controls-2026-08-01` with `prefix_mismatch_behavior: "drop_block"`. Blocks from a model the target can't read are dropped silently.
4. Forced `tool_choice` (`any` / named tool) skips thinking. It errors in manual mode, and Opus 5.5 / Sonnet 5.5 / Fable 5.1 reject it even in adaptive mode (matches the §10.3 400).

### 13.3 The nanollm-side source: DeepSeek, not Claude

The empty-thinking fallback in this repo is a DeepSeek rule:
- `1af9185` (2026-04-29) "add empty reasoning content placeholder for chat" and `30a24a0` (2026-05-02) "add 'reasoning' and 'thinking' alongside 'reasoning_content' in empty assistant placeholder".
- `f21a7cc` (2026-10-20): "DeepSeek returns 400 for a tool call it did not issue unless the turn carries thinking. Add an empty placeholder… Claude verifies thinking signatures and returns 400 for ones it did not issue. Drop thinking whose signature is not Claude-shaped." (`src/proxy/reasoning-history.ts`, `addDeepSeek*Placeholders` vs `dropForeignClaudeSignatures`).

So "tool call ⇒ thinking placeholder" is real for DeepSeek, and "tool call ⇒ real thinking block" was real for Claude manual mode. Neither applies to current Claude adaptive thinking.

### 13.4 Live checks (nanollm gateway, real Anthropic ids `msg_011…`)

| Request (claude-sonnet-5-5) | Result |
| --- | --- |
| `thinking: {type:"disabled"}` | 400, exact doc message ("send `between_tools` instead"), so `thinking` reaches Anthropic unchanged |
| `thinking: {type:"enabled", budget_tokens:500}` | 400 `budget_tokens … greater than or equal to 1024` |
| `thinking: {type:"enabled", budget_tokens:1024}`, plain question | **200**, although the docs say 4.7+ rejects `enabled` (doc/behavior mismatch; may change) |
| `enabled` 1024, final tool turn without thinking | 200, rule not enforced |
| `adaptive`, final tool turn without thinking | 200 |
| `between_tools`, final tool turn without thinking | 200 |
| claude-sonnet-4-6 channel with `thinking.type: "bogus"` | 200, so this channel ignores `thinking`; 4.6 manual-mode behavior is unverified |

### 13.5 Consequences for nanollm

1. Current Claude upstreams (adaptive, 4.7+): converted function calls and text notes need no thinking block, and a placeholder would be removed or rejected anyway.
2. **Manual-mode-only upstreams (Opus/Haiku/Sonnet 4.5 and earlier)**: the rule applies. If the final pending tool turn came from another protocol (no valid Claude thinking), the request must go out **without `thinking`** (or with thinking disabled). Fabricating a block is never valid. Separately, nanollm's converter maps effort to `thinking: {type:"adaptive"}`, which these models reject ("adaptive thinking is not supported on this model"). That's worth checking per model.
3. **Prefix binding (5.x)**: any history rewrite nanollm does on a Claude-bound request makes the native Claude thinking blocks that come after the rewrite invalid on new accounts. This includes converting cross-protocol search blocks, dropping blocks, or injecting notes. Same-origin carrier replay is safe because it restores the exact original. For cross-protocol rewrites, strip native thinking from the first rewritten block onward, or send the binding beta with `drop_block`. `dropForeignClaudeSignatures` only removes foreign-looking signatures and doesn't cover this case yet.

## 14. Implementation status

### Phase 1: requests and history (done 2026-10-21, uncommitted)

Code: `src/converters/web-search.ts` (new), `shared.ts` (normalized types), `requests.ts`, `proxy/proxy.ts` (same-format passthrough degrade). Tests: `tests/web-search.ts`. Reference: `docs/converters.md` "Web Search".

Done: tool mapping both ways, forced choice → `auto`, `include` sources for Responses, search history (native replay when same origin, `web_search_history` function call for Responses, assistant-voice note for Anthropic/Chat), citations on text parts, searches whose result arrives after a client tool call, carrier decode, synthesized-id degrade for same-format passthrough.

Verified live through a local nanollm in front of the real upstreams: tools convert and both models search; Claude history → GPT, GPT history → Claude, and both synthesized-passthrough cases return 200 with correct follow-up answers.

Findings during the live run:
1. **Interim guard.** Forwarding the search tool to Claude made it return `server_tool_use`, which the unchanged response converter showed to Responses clients as a fake `function_call web_search` (a client would try to run it). Phase 1 skipped native web search blocks in Claude responses and streams. Phase 2 replaced the non-stream guard with real conversion and phase 3 the stream guard.
2. **`ttfb_timeout`.** The default first-byte timeout (5 s) fails non-streaming search requests (the upstream needs 6–12 s before the first byte). Models that search need a larger `ttfb_timeout`; worth a README note once search conversion ships.
3. Phase 1 alone never produces the carrier or the `*_nanollm_` ids (those come from response conversion), so the carrier restore paths are covered by unit tests with hand-built input only.

### Remaining
- Phase 4: proxy `pause_turn` auto-continue; strip native Claude thinking after a rewritten history (prefix binding, `docs/claude-thinking-rules.md` §2.4).

### Phase 2: non-stream responses (done 2026-10-21, uncommitted)

Code: `responses.ts` (normalize both ways, ordered Responses output), `web-search.ts` (response-side helpers, shared search index), `tests/web-search.ts`. Reference: `docs/converters.md` "Web search in responses".

Done: Claude → Responses (web_search_call + carrier, ordered output, text split into messages around searches, annotations, pending-result handling); GPT → Anthropic (server_tool_use + result with markers, citation ranges cut into cited blocks by code points, `web_search_requests` usage); a blank acknowledgement message is dropped; Chat clients see only text.

Verified live through a local nanollm in front of the real upstreams, including the round trips:
- Claude search → Responses client → back to Claude: the carrier restores the original encrypted blocks and Claude accepts them (any change would be a 400).
- Same with the carrier dropped by the client: degrades to a note, correct answer.
- Claude search → Responses client → GPT: function call.
- GPT search → Anthropic client → back to GPT: the native web_search_call is rebuilt.
- GPT search → Anthropic client → Claude: note.

Notes:
1. A Claude search shown to a Responses client adds a carrier of roughly the size of the results (about 27 KB for one search of nine results) to every later request in the conversation. If this proves heavy on Turso-backed deployments, store carriers in the request records only by reference or compress them.
2. `pause_turn` still reaches a Responses client as a normal completed response (status `completed`, no continuation). Phase 4 resumes it inside the proxy.
3. `NormalizedUsage` has no `webSearchRequests`; the Anthropic count is derived from the parts.

### Phase 3: streams (done 2026-10-21, uncommitted)

Code: `streams.ts` (new normalized events `web_search_start` / `web_search_done` / `citation`; both parsers and the Responses and Anthropic emitters), `requests.ts` (blank text dropped), `tests/web-search.ts`. Reference: `docs/converters.md` "Web search in streams".

Done: Claude stream → Responses (call shown when its query is known, result completes it, carrier item, message split around searches, annotations before `output_text.done`, pending search closed in order); GPT stream → Anthropic (call shown at once, input filled in at done, result block, citation on the open block, usage); streamed output matches the non-stream conversion item for item (tested); `response.completed` finishes searches whose done event is missing.

Verified live through a local nanollm in front of the real upstreams (streaming both ways): both stream shapes are right (Anthropic client against GPT: two `server_tool_use` + result pairs, citation on the text block, `web_search_requests` 1; Responses client against Claude: web_search_call + carrier + message). The streamed Claude output replayed back to Claude: the carrier (about 34 KB, reassembled from the stream) was accepted. Streamed output also replayed to GPT, and the streamed GPT output to GPT and Claude: all 200 with correct answers.

Findings:
1. Test caught an ordering bug in the first design: a search pending behind a client tool call was only closed at the end of the stream, so its carrier landed after the client's `function_call`. Replayed to Claude that would reorder `server_tool_use` and `tool_use`. It is now closed as soon as any non-search block starts.
2. A stream cannot know a search will stay pending when it announces it, so it ends `incomplete` where the non-stream path shows nothing. The carrier holds the real state either way and replay ignores the visible copy.
3. Citations from a GPT stream can't split the Anthropic text block (they arrive after the text), so streamed Anthropic output has coarser citations than the non-stream path.

### Remaining
- Phase 4: proxy `pause_turn` auto-continue; strip native Claude thinking after a rewritten history (prefix binding, `docs/claude-thinking-rules.md` §2.4).

### Phase 4: proxy (done 2026-10-21, uncommitted)

Code: `src/proxy/pause-turn.ts` and `src/proxy/thinking-binding.ts` (new), `proxy.ts` (wiring), tests `tests/pause-turn.ts` and `tests/thinking-binding.ts` (registered in the `node --test` list). Reference: `docs/converters.md` "Proxy handling around web search".

Done: `pause_turn` resumed in the proxy for converted requests (non-stream merge, stream splice, limit of 5, same-format untouched); rejected thinking binding retried once without thinking for converted requests and for same-format requests whose history nanollm rewrote.

Verification and limits:
1. Mock-upstream tests cover both (continuation body, merged usage, spliced block numbering, the limit, failed continuation, retry in stream and non-stream, no retry for other errors, same-format error kept).
2. Live regression: normal search streams and non-streams through the new wrappers still work. A real `pause_turn` could not be provoked (a 12-topic, 12-search prompt finished in one round, also when asked directly), so the pause handling is only verified against the mock, which streams realistic SSE.
3. Prefix binding is not enforced on the test account (Sonnet 5.5 replayed a thinking block unchanged after the system prompt, first message, tool list and same-turn text were each changed), so the retry is verified against the mock only. The design is reactive for that reason: proactive stripping would cost cache hits on every converted search conversation.
4. A retry shows up as a second attempt in the request record under the same attempt index (the first error is overwritten by the retry's response).

### Remaining
- Carrier size: about 27–34 KB per search added to every later request of the conversation. Compression (gzip before base64) is the obvious cheap change; not done.
- Native OpenAI history rules with real reasoning items next to searches (open question 1) still need a channel that returns them.
- Codex history behavior (open question 6).
