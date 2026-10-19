# Reasoning across tool calls: protocol matrix (2026-10-19)

Live test of whether thinking survives a two-round tool call through nanollm, for every client protocol × provider protocol.

## Setup

- **nanollm build:** commit `2ff51c0` (clean copy of `HEAD`; uncommitted working-tree changes were not included). `server.ttfb_timeout` raised to 180 s (see issue 2).
- **Providers:**

  | nanollm model | Provider protocol | Upstream | Upstream model |
  |---|---|---|---|
  | `ds-chat` | `openai-chat` | `https://api.deepseek.com` | `deepseek-flash` |
  | `ds-responses` | `openai-responses` | `https://api.deepseek.com` | `deepseek-flash` |
  | `ds-anthropic` | `anthropic` | `https://api.deepseek.com/anthropic/v1` | `deepseek-flash` |
  | `claude-haiku` | `anthropic` | Vercel AI Gateway | `anthropic/claude-haiku-5.5` |
  | `gpt-luna` | `openai-responses` | Vercel AI Gateway | `openai/gpt-6-luna` |

- **Tool:** `get_weather(city)`. The system prompt requires calling it for weather questions.
- **Prompt:** "My flight leaves Tokyo (UTC+9) at 23:40 local time and the flight takes 7h35m. Work out the local arrival time in Singapore (UTC+8), then check the weather there …". A bare weather question made DeepSeek skip thinking entirely (`reasoning_tokens: 0`), so the prompt needs some arithmetic first.
- **High effort per client:**
  - Chat: `reasoning_effort: "high"`.
  - Responses: `reasoning: {effort: "high", summary: "auto"}`, `include: ["reasoning.encrypted_content"]`, `store: false`.
  - Anthropic: `thinking: {type: "adaptive"}`, `output_config: {effort: "high"}`.
- **Flow:**
  1. **Round 1:** expect a `get_weather` call.
  2. **Round 2:** send the round-1 assistant turn back *unchanged*, as a careful client would, plus a simulated tool result `{"city":"Singapore","temp_c":31,"condition":"thunderstorms"}`. "Unchanged" means: Chat sends the message including `reasoning_content`; Responses sends every output item; Anthropic sends every content block.
  3. **Check:** read nanollm's request record to see the body it actually sent upstream.
- **Runs:** 5 models × 3 client protocols × non-stream/stream = 30 combinations, one run each.

## Key findings

1. **The provider-side "thinking before a tool call" check could not be reproduced with same-model history.** (Update: the later rerun did reproduce it, for tool calls DeepSeek didn't issue itself; see control C and issue 7.) DeepSeek's docs say a missing `reasoning_content` in tool-call conversations returns 400. Called directly, without nanollm, DeepSeek accepted every variant on all three protocols, on `deepseek-flash` and `deepseek-v4-pro`, including a follow-up user turn (control A). Claude accepts thinking that was removed or has an empty signature. It **rejects a forged signature** with 400 (control B).
2. **29 of 30 combinations passed round 2.** The one failure is a real bug: Chat client (streaming) → Claude returned 400 `messages: text content blocks must be non-empty` (issue 1).
3. **The `nanollm.reasoning.v1` carrier works end to end.** Responses client → `ds-anthropic` / `claude-haiku`: the client only saw `summary`, yet nanollm rebuilt the signed thinking block for round 2. Claude verified the real signature (≈1.4 KB) and accepted it.
4. **Thinking is silently lost on several paths**, even though every request still succeeds:
   - any client → Responses upstream (issue 3);
   - Chat client → Anthropic upstream (issue 4);
   - GPT via Chat or Anthropic clients (issue 5).

   No error is raised, but the model loses its earlier reasoning in the tool loop.

## Control A: DeepSeek called directly (round-2 variants)

| Protocol | Round-2 assistant turn | Status |
|---|---|---|
| chat | thinking kept (`reasoning_content`) | 200 |
| chat | thinking removed | 200 |
| chat | `reasoning_content: ""` | 200 |
| chat, `deepseek-flash` and `deepseek-v4-pro` | thinking removed, plus a new user turn after the tool loop with all thinking removed | 200 |
| responses | thinking kept (reasoning item as returned) | 200 |
| responses | reasoning item removed | 200 |
| responses | reasoning as `summary` only (no `content` / `encrypted_content`) | 200 |
| anthropic | thinking kept (with signature) | 200 |
| anthropic | thinking removed | 200 |
| anthropic | thinking with `signature: ""` | 200 |
| anthropic | thinking with a wrong signature | 200 |

DeepSeek's Anthropic endpoint returns a UUID as `signature` and doesn't verify it.

## Control B: Claude Haiku 5.5 called directly (Vercel, Anthropic protocol)

Round 1 returns `[thinking, tool_use]`. The thinking text is **empty** and the signature is about 1.5 KB: by default Haiku 5.5 omits the thinking text and keeps the reasoning inside the signature.

| Round-2 assistant turn | Status |
|---|---|
| thinking kept (valid signature) | 200 |
| thinking removed | 200 |
| thinking with `signature: ""` | 200 |
| thinking with a forged signature (a DeepSeek UUID) | **400** `Invalid signature in thinking block` |
| thinking text altered, signature kept | 200 |
| empty text block before `tool_use` | **400** `text content blocks must be non-empty` |

## Matrix through nanollm

Column meanings:
- **R1:** HTTP status and finish/stop reason of round 1. Every combination produced exactly one `get_weather({"city":"Singapore"})` call.
- **Thinking returned to client:** where the client found the thinking in its own protocol, its length, and the opaque fields next to it. "nanollm carrier" means `encrypted_content` holds the `nanollm.reasoning.v1:` carrier (thinking text + signature).
- **R2:** HTTP status of round 2. Every 200 produced a final answer ("06:15 the next day … thunderstorms, take an umbrella").
- **Thinking nanollm sent upstream in R2:** read from nanollm's request record. This is what the provider actually saw.

#### `ds-chat` (openai-chat)

| Client | Mode | R1 | Thinking returned to client | R2 | Thinking nanollm sent upstream in R2 |
|---|---|---|---|---|---|
| Anthropic | non-stream | 200 `tool_use` | `content[thinking]` 297 chars, signature (empty) | 200 | `assistant.reasoning_content` = 297 chars |
| Anthropic | stream | 200 `tool_use` | `content[thinking]` 173 chars, signature (empty) | 200 | `assistant.reasoning_content` = 173 chars |
| Chat | non-stream | 200 `tool_calls` | `message.reasoning_content` 299 chars | 200 | `assistant.reasoning_content` = 299 chars |
| Chat | stream | 200 `tool_calls` | `message.reasoning_content` 166 chars | 200 | `assistant.reasoning_content` = 166 chars |
| Responses | non-stream | 200 `completed` | `reasoning.summary[summary_text]` 246 chars, `encrypted_content`: nanollm carrier | 200 | `assistant.reasoning_content` = 246 chars |
| Responses | stream | 200 `completed` | `reasoning.summary[summary_text]` 490 chars, `encrypted_content`: nanollm carrier | 200 | `assistant.reasoning_content` = 490 chars |

Every client path keeps the thinking.

#### `ds-responses` (openai-responses)

| Client | Mode | R1 | Thinking returned to client | R2 | Thinking nanollm sent upstream in R2 |
|---|---|---|---|---|---|
| Anthropic | non-stream | 200 `tool_use` | `content[thinking]` 253 chars, signature (empty) | 200 | **no `reasoning` item** before `function_call` |
| Anthropic | stream | 200 `tool_use` | `content[thinking]` 338 chars, signature (empty) | 200 | **no `reasoning` item** |
| Chat | non-stream | 200 `tool_calls` | none (model skipped reasoning this run; a rerun returned 285 chars) | 200 | **no `reasoning` item** |
| Chat | stream | 200 `tool_calls` | `message.reasoning_content` 287 chars | 200 | **no `reasoning` item** |
| Responses | non-stream | 200 `completed` | `reasoning.content[reasoning_text]` 574 chars, `encrypted_content`: 38-char UUID | 200 | `reasoning{content: 574, encrypted_content: UUID}` (passthrough) |
| Responses | stream | 200 `completed` | `reasoning.content[reasoning_text]` 273 chars, `encrypted_content`: 38-char UUID | 200 | `reasoning{content: 273, encrypted_content: UUID}` (passthrough) |

The streaming `reasoning_text` fix works: Chat and Anthropic clients receive DeepSeek's raw reasoning. In round 2, nanollm never sends it back to a Responses upstream (issue 3).

#### `ds-anthropic` (anthropic)

| Client | Mode | R1 | Thinking returned to client | R2 | Thinking nanollm sent upstream in R2 |
|---|---|---|---|---|---|
| Anthropic | non-stream | 200 `tool_use` | `content[thinking]` 286 chars, signature 36-char UUID | 200 | `[thinking(286, signature UUID), tool_use]` (passthrough) |
| Anthropic | stream | 200 `tool_use` | `content[thinking]` 231 chars, signature 36-char UUID | 200 | `[thinking(231, signature UUID), tool_use]` (passthrough) |
| Chat | non-stream | 200 `tool_calls` | `message.reasoning_content` 352 chars | 200 | `[text, tool_use]`: **thinking dropped** (no signature) |
| Chat | stream | 200 `tool_calls` | `message.reasoning_content` 327 chars | 200 | `[text, tool_use]`: **thinking dropped** |
| Responses | non-stream | 200 `completed` | `reasoning.summary[summary_text]` 223 chars, `encrypted_content`: nanollm carrier | 200 | `[thinking(223, signature UUID), text, tool_use]`: rebuilt from the carrier |
| Responses | stream | 200 `completed` | `reasoning.summary[summary_text]` 250 chars, `encrypted_content`: nanollm carrier | 200 | `[thinking(250, signature UUID), tool_use]`: rebuilt from the carrier |

#### `claude-haiku` (anthropic)

| Client | Mode | R1 | Thinking returned to client | R2 | Thinking nanollm sent upstream in R2 |
|---|---|---|---|---|---|
| Anthropic | non-stream | 200 `tool_use` | `content[thinking]` 0 chars, signature 1412 chars | 200 | `[thinking(0, signature), tool_use]` (passthrough) |
| Anthropic | stream | 200 `tool_use` | `content[thinking]` 0 chars, signature 1320 chars | 200 | `[thinking(0, signature), tool_use]` (passthrough) |
| Chat | non-stream | 200 `tool_calls` | `message.reasoning_content` 246 chars | 200 | `[tool_use]`: **thinking dropped** (no signature) |
| Chat | stream | 200 `tool_calls` | `message.reasoning_content` 242 chars | **400** | `[text "", tool_use]`: empty text block rejected (issue 1) |
| Responses | non-stream | 200 `completed` | `reasoning.summary[summary_text]` 335 chars, `encrypted_content`: nanollm carrier | 200 | `[thinking(335, real signature), tool_use]`: rebuilt from the carrier, accepted by Claude |
| Responses | stream | 200 `completed` | `reasoning.summary[summary_text]` 244 chars, `encrypted_content`: nanollm carrier | 200 | `[thinking(244, real signature), tool_use]`: rebuilt from the carrier, accepted by Claude |

Thinking text is empty for the native Anthropic client, because passthrough keeps Haiku's default of omitting it. It's present for Chat and Responses clients because nanollm's converted request sets `thinking: {type: "adaptive", display: "summarized"}`.

#### `gpt-luna` (openai-responses)

| Client | Mode | R1 | Thinking returned to client | R2 | Thinking nanollm sent upstream in R2 |
|---|---|---|---|---|---|
| Anthropic | non-stream | 200 `tool_use` | **none** | 200 | no `reasoning` item |
| Anthropic | stream | 200 `tool_use` | **none** | 200 | no `reasoning` item |
| Chat | non-stream | 200 `tool_calls` | **none** | 200 | no `reasoning` item |
| Chat | stream | 200 `tool_calls` | **none** | 200 | no `reasoning` item |
| Responses | non-stream | 200 `completed` | `reasoning.content[reasoning_text]` 436 chars + `summary` 436 chars, `encrypted_content` 2380 chars | 200 | `reasoning{content: 436, summary: 436, encrypted_content: 2380}` (passthrough) |
| Responses | stream | 200 `completed` | `reasoning.summary[summary_text]` 377 chars, `encrypted_content` 2060 chars | 200 | `reasoning{summary: 377, encrypted_content: 2060}` (passthrough) |

For Chat and Anthropic clients, the recorded upstream response had a reasoning item with only `encrypted_content` (≈1.8–2.1 KB) and no text, because nanollm's converted request sends `reasoning: {effort: "high"}` without `summary` (issue 5).

## Issues found

1. **Bug: empty assistant text becomes an empty Anthropic text block (400).**
   - **Cause:** a streaming Chat client builds up `content: ""` for a tool-call turn; nanollm's own Chat stream starts with a `content: ""` chunk. Converting that history to Anthropic produces `{type: "text", text: ""}` before `tool_use`, and Claude rejects it.
   - **Fix:** skip empty text parts when converting assistant messages to Anthropic.
   - **Status:** fixed in `denormalizeAnthropicAssistantParts` / `dropEmptyAnthropicText` (also covers user and `tool_result` arrays). Retested live: all 12 Anthropic-upstream combinations (`claude-haiku`, `ds-anthropic`) pass round 2, and Chat stream → Claude now sends `[tool_use]` and gets 200.
2. **The default `ttfb_timeout` of 5 s is too short for non-streaming thinking requests.**
   - **Cause:** with the default, non-streaming Claude round 2 failed with 500 `Upstream TTFB timeout after 5000ms`. Without streaming, the time to first byte is the whole generation.
   - **Fix:** use a longer default for non-streaming requests, or set per-model values for thinking models.
3. **Converted requests to a Responses upstream drop all reasoning.**
   - **Cause:** for Chat or Anthropic client → `ds-responses` / `gpt-luna`, nanollm writes no `reasoning` item in round 2.
   - **Impact:** DeepSeek and GPT don't reject it, but DeepSeek's docs say the reasoning should be passed back, and the model continues without its earlier reasoning.
   - **Fix:** for plaintext reasoning (DeepSeek), write a `reasoning` item with `content` / `summary`.
4. **Chat client → Anthropic upstream drops the thinking.**
   - **Cause:** Chat has no signature field, so the thinking reaches `ds-anthropic` / `claude-haiku` unsigned, and `ignore_invalid_history` (default `true`) removes it.
   - **Fix for DeepSeek:** its Anthropic endpoint doesn't verify signatures, so `ignore_invalid_history: false` on DeepSeek Anthropic models would keep the reasoning.
   - **For Claude:** dropping is the only safe option.
5. **GPT reasoning is invisible and lost behind Chat/Anthropic clients.**
   - **Cause:** nanollm sends `reasoning: {effort}` without `summary`, so GPT returns only `encrypted_content` and no text.
   - **Impact:** the client sees no thinking. The encrypted reasoning maps to `redacted_thinking` and is dropped, so round 2 carries none.
   - **Fix:** request `summary: "auto"`, and send `encrypted_content` back. That needs the "step 2" design: record which protocol produced each signature or encrypted blob.
6. **Risk: foreign signatures.**
   - **Cause:** nanollm doesn't record which provider a signature came from.
   - **Impact:** a thinking block signed by DeepSeek (UUID signature) that reaches Claude, for example through a fallback group mixing the two, will be rejected with 400 (control B).

## Rerun on the working tree (later the same day)

**Code tested:** `HEAD` 2ff51c0 plus the uncommitted working-tree diff (6 files, +466/−67, plus `tests/reasoning-streams.ts`; fingerprint `e515bd424b55`). The diff contains two things:
- origin tracking for `redacted_thinking`, reasoning items for Responses upstreams, and Responses stream parser hardening (see the working-tree review);
- the empty-text-block fix for issue 1.

Config and harness are unchanged.

### Matrix: 30 of 30 pass round 2

Differences from the `HEAD` run (all other combinations behave the same, apart from run-to-run differences in thinking length):

| Combination | `HEAD` 2ff51c0 | Working tree |
|---|---|---|
| Chat / Anthropic client → `ds-responses` (4 combos) | no `reasoning` item upstream | `reasoning{content: <thinking text>}` sent upstream: **issue 3 fixed** |
| Chat client, stream → `claude-haiku` | **400** empty text block | 200, upstream `[tool_use]`: **issue 1 fixed** |
| Chat client, stream → `ds-anthropic` | `[text "", tool_use]` (DeepSeek tolerated it) | `[tool_use]` |
| GPT via Chat / Anthropic clients (4 combos) | no thinking for client, none upstream | unchanged: **issue 5 still open** |

### Cross-provider: round 1 on one model, round 2 on another

This simulates a fallback group or a model switch mid-conversation. Same client protocol and history, non-stream.

| Client | Round 1 → Round 2 | R2 | Thinking nanollm sent upstream in R2 | Error |
|---|---|---|---|---|
| Responses | `claude-haiku` → `gpt-luna` | 200 | `reasoning{content: 242, encrypted_content: none}`: carrier restored as plaintext, accepted by GPT | |
| Responses | `ds-anthropic` → `gpt-luna` | 200 | `reasoning{content: 252, encrypted_content: none}`: same | |
| Responses | `ds-responses` → `gpt-luna` | 200 | `reasoning{content: 484, encrypted_content: DeepSeek 38-char UUID}` (passthrough), accepted | |
| Responses | `gpt-luna` → `claude-haiku` | 200 | `[tool_use]`: GPT ciphertext correctly not sent to Claude | |
| Responses | `ds-anthropic` → `claude-haiku` | **400** | `[thinking(314, DeepSeek UUID signature), tool_use]` | `Invalid signature in thinking block` |
| Anthropic | `ds-anthropic` → `claude-haiku` | **400** | `[thinking(225, DeepSeek UUID signature), tool_use]` (passthrough) | `Invalid signature in thinking block` |
| Chat | `ds-anthropic` → `claude-haiku` | 200 | `[text, tool_use]` (unsigned thinking dropped) | |
| Chat | `gpt-luna` → `ds-chat` | **400** | `reasoning_content` missing (passthrough) | `The reasoning_content in the thinking mode must be passed back to the API` |

Conclusions:
- **Issue 6 is confirmed** through both the converted and passthrough paths. The earlier passthrough risk (carrier plaintext sent to real OpenAI) did not materialize: GPT accepted plaintext `reasoning_text` input items.
- **The `gpt-luna` → `ds-chat` failure explains when DeepSeek validates** (control C).

### Control C: when DeepSeek requires thinking (called directly)

DeepSeek checks tool-call turns whose **tool-call ID it did not issue** (its own look like `call_00_…`). Its own IDs are accepted without thinking, which is why control A never got a 400. The check is whether the field is present, not its content: an empty `reasoning_content: ""` or an unsigned thinking block passes.

| Endpoint | Assistant tool-call turn sent back | Status |
|---|---|---|
| chat | DeepSeek ID, no `reasoning_content` (content text / `null` / `""`) | 200 |
| chat | foreign ID, no `reasoning_content` (content text or `null`) | **400** `The reasoning_content in the thinking mode must be passed back` |
| chat | foreign ID, `reasoning_content: ""` | 200 |
| chat | foreign ID, `reasoning_content` text | 200 |
| anthropic | DeepSeek ID, no thinking block | 200 |
| anthropic | foreign ID, no thinking block | **400** `The content[].thinking in the thinking mode must be passed back` |
| anthropic | foreign ID, thinking with `signature: ""` | 200 |
| responses | foreign ID, no `reasoning` item | **400** `The reasoning_text in the thinking mode must be passed back` |
| responses | foreign ID, plaintext `reasoning{content}` | 200 |

**Issue 7 (new): DeepSeek rejects history from other models unless every tool-call turn carries a thinking field.** A foreign tool-call ID comes from another model's turn (fallback group, model switch). nanollm keeps DeepSeek IDs unchanged (`sanitizeAnthropicToolId` only replaces disallowed characters). nanollm makes it worse in two places:
- **Anthropic upstream:** `ignore_invalid_history: true` (default) *removes* unsigned thinking. That's exactly what turns a passable request into a 400 on `ds-anthropic`.
- **Chat upstream:** a `reasoning_content` placeholder is only added when `image: false`, and same-format passthrough adds nothing.

Possible fixes, for DeepSeek models only:
- **Chat:** always send `reasoning_content` on assistant tool-call messages, `""` when unknown. A `body_expression` on the model works today without code changes.
- **Anthropic:** set `ignore_invalid_history: false`, so unsigned thinking is sent with `signature: ""`. DeepSeek doesn't verify signatures. A turn that had no thinking at all would also need an empty thinking block.
- **Responses:** add an empty `reasoning` item before such tool calls.

### Issue status after the rerun

| # | Issue | Status |
|---|---|---|
| 1 | Empty text block → Claude 400 | Fixed (working tree) |
| 2 | 5 s default `ttfb_timeout` too short for non-stream thinking | Open (config) |
| 3 | No reasoning sent to Responses upstreams | Fixed (working tree) |
| 4 | Chat client → Anthropic upstream drops unsigned thinking | Open; becomes a 400 on DeepSeek with foreign tool IDs (issue 7) |
| 5 | GPT reasoning invisible/lost behind Chat/Anthropic clients | Open |
| 6 | Foreign (DeepSeek) signature sent to Claude → 400 | Open, confirmed live |
| 7 | DeepSeek requires a thinking field for tool calls it didn't issue | New, open |

## Reproduce

The harness lives outside the repo, in `%TEMP%\nanollm-it\harness`:
- `run.mjs`: the matrix through the gateway on port 3917 (`CROSS=1` runs the cross-provider set). Results: `final.json` (`HEAD`), `results-wt.json` and `results-cross.json` (working tree).
- `control.mjs`, `control2.mjs`, `control3.mjs`, `control4.mjs`: DeepSeek called directly.
- `control-claude.mjs`: Claude called directly.
- `final.json`: the raw results.

Gateway config: `%TEMP%\nanollm-it\app\config.it.yaml`. Keys come from the `DS_KEY` / `VERCEL_KEY` environment variables and are not stored in any file.
