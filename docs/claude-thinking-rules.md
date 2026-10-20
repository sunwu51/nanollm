# Claude thinking rules for replayed history

What Anthropic requires of `thinking` / `redacted_thinking` blocks when history is sent back, which rules are current, and what that means for nanollm. Researched and live-tested 2026-10-21. Full test log: `docs/web-search-conversion-research.md` §12–§13.

Sources:
- https://platform.claude.com/docs/en/build-with-claude/extended-thinking
- https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows
- https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting
- Cookbook "Extended thinking with tool use"; vercel/ai#7729, opencode #3077, LibreChat discussion #11598

## 1. Thinking modes per model

| Model | Modes | Default | Rejected (400) |
| --- | --- | --- | --- |
| Fable 5.1, Mythos 5.1, Fable 5, Mythos 5, Opus 5.5 | adaptive only | always on | `enabled`, `disabled` |
| Opus 5 | adaptive only | on | `enabled`; `disabled` only at effort ≤ high |
| Sonnet 5.5 | adaptive, `between_tools` | on | `enabled`, `disabled` (use `between_tools` to turn up-front thinking off) |
| Sonnet 5 | adaptive only | on | `enabled` |
| Haiku 5.5 | adaptive only | on | `enabled`; `disabled` only at effort ≤ high |
| Opus 4.8, Opus 4.7 | adaptive only | off | `enabled` |
| Opus 4.6, Sonnet 4.6 | adaptive, `enabled` (deprecated) | off | — |
| Opus 4.5, Haiku 4.5, Sonnet 4.5 and earlier Claude 4 / 3.7 | `enabled` (manual) only | off | `adaptive` |

Observed: real Anthropic accepted `thinking: {type:"enabled", budget_tokens:1024}` on Sonnet 5.5 (200), contrary to the table. Don't rely on it.

## 2. The rules

### 2.1 Manual mode: the final tool turn must start with thinking (legacy)

With `thinking: {type:"enabled"}`, the assistant turn whose `tool_use` is answered by the final `tool_result` must begin with a `thinking` / `redacted_thinking` block:

```
messages.1.content.0.type: Expected `thinking` or `redacted_thinking`, but found `tool_use`.
When `thinking` is enabled, a final `assistant` message must start with a thinking block
(preceeding the lastmost set of `tool_use` and `tool_result` blocks). We recommend you include
thinking blocks from previous turns. To avoid this requirement, disable `thinking`.
```

- This was the common gateway error of the Claude 3.7 → 4.5 era, when manual mode was the only thinking mode. It's why "every tool call needs thinking before it" feels like a universal Claude rule.
- **Adaptive thinking drops this requirement** (docs: "adaptive thinking drops that requirement"). Verified on Sonnet 5.5: a final tool turn without thinking returned 200 under `adaptive`, `between_tools` and (accepted) `enabled`.
- Only a real block satisfies it. If the turn has no valid Claude thinking (e.g. it came from another protocol), the only valid fix is to send the request **without thinking**.

### 2.2 Thinking that exists must come back intact

- When returning a tool result, the thinking blocks of that assistant message must come back with it, unmodified.
- Rebuilding the message or filtering out `redacted_thinking` → 400 "`thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified".
- Empty `thinking` text with only a `signature` is normal (`display` defaults to `"omitted"` on newer models). The block is still complete and must be sent back.

### 2.3 Signatures are verified

- A foreign, truncated, altered or empty signature → 400 "Invalid `signature` in `thinking` block".
- **A fake or empty placeholder thinking block never works on Claude.** Removing the block is accepted.

### 2.4 Prefix binding (Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5)

- A replayed thinking block is accepted only while the `system` prompt, `tools` and **every message before it** are unchanged.
- Otherwise: 400 "Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block"."
- Enforced for accounts created on or after **2026-08-31**, and for any request that sets `thinking.block_binding.prefix_mismatch_behavior`.
- Triggers: edited, reordered or removed turns; an injected-then-removed reminder; a rebuilt `system` or `tools`; client-side compaction. Server-side compaction and context editing don't trigger it.
- Fixes:
  - send beta header `thinking-binding-controls-2026-08-01` with `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` (only with `adaptive` on Sonnet 5.5 / Haiku 5.5), or
  - strip every `thinking` / `redacted_thinking` block from the first changed point onward (that turn and all later turns), keeping other blocks.
- A block from a model the target can't read is dropped silently, not an error.

### 2.5 Forced tool choice

- `tool_choice` `any` or a named tool skips thinking (the response starts with the tool call).
- Manual mode: forced choices error.
- Adaptive: accepted, except Opus 5.5, Sonnet 5.5, Fable 5.1, Mythos 5.1, which return 400 (verified on Sonnet 5.5: `tool_choice: type "tool" and "any" are not supported for this model`).

### 2.6 One thinking configuration per assistant turn

A tool-use loop is one assistant turn. Change thinking settings only between turns. Changing mode, effort or `budget_tokens` also invalidates prompt-cache breakpoints.

## 3. Not a Claude rule: DeepSeek placeholders

nanollm's empty-thinking placeholder (`addDeepSeek*Placeholders` in `src/proxy/reasoning-history.ts`, commits `1af9185`, `30a24a0`, `f21a7cc`) exists because **DeepSeek** returns 400 for a tool call it didn't issue unless the turn carries a thinking field. For Claude, the same code does the opposite: `dropForeignClaudeSignatures` removes thinking whose signature isn't Claude-shaped.

## 4. What nanollm must do

1. **Never fabricate Claude thinking.** Foreign or unsigned thinking is dropped for Claude upstreams (already the case).
2. **Adaptive models (4.7+)**: converted tool calls, search fallbacks and text notes need no thinking block.
3. **Manual-only models (4.5 and earlier)**: if the final pending tool turn has no valid Claude thinking, send the request without `thinking`. Also note these models reject `adaptive`, which the converter emits for effort today.
4. **Prefix binding**: any history rewrite on a Claude-bound request (cross-protocol conversion, dropped blocks, injected notes) makes later native Claude thinking invalid on new accounts. Strip native thinking from the first rewritten point onward, or use the `drop_block` beta. Exact same-origin replay (e.g. the web-search carrier) is safe. `dropForeignClaudeSignatures` doesn't cover this yet.
5. **Forced tool choice**: map to `auto` when the target model rejects it.
