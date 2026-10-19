import type { ModelConfig, ReasoningProfile } from "../core/config.js";

// Providers disagree about reasoning in replayed history, and history can come
// from another model (fallback groups, model switches):
// - Claude verifies thinking signatures and rejects ones it did not issue
//   ("Invalid `signature` in `thinking` block"), but accepts thinking removed.
// - DeepSeek does not verify signatures, but rejects a tool call it did not issue
//   unless the turn carries a thinking field ("... must be passed back to the
//   API"). Its own tool calls (ids like call_00_...) need nothing: DeepSeek
//   restores their stored reasoning, and an explicit placeholder would replace it.
// These rules run on the final upstream body, so converted requests and
// same-format passthrough are handled alike.

type ResolvedProfile = Exclude<ReasoningProfile, "auto">;

export function resolveReasoningProfile(config: ModelConfig): ResolvedProfile {
  if (config.reasoning_profile && config.reasoning_profile !== "auto") return config.reasoning_profile;
  if (config.claude_subscription_provider) return "claude";
  const model = config.model.toLowerCase();
  const host = upstreamHost(config.base_url);
  // Model names may carry a gateway or region prefix: "anthropic/claude-…", "us.anthropic.claude-…".
  if (host === "deepseek.com" || host.endsWith(".deepseek.com") || /(^|[/.])deepseek/.test(model)) return "deepseek";
  if (host === "api.anthropic.com" || /(^|[/.])claude/.test(model)) return "claude";
  return "none";
}

/** Whether unsigned thinking should be dropped before an Anthropic upstream. */
export function shouldDropUnsignedThinking(config: ModelConfig): boolean {
  // DeepSeek ignores signatures, and dropping the thinking is what makes it reject the turn.
  return resolveReasoningProfile(config) === "deepseek" ? false : config.ignore_invalid_history ?? true;
}

export function applyReasoningHistoryRules(config: ModelConfig, body: unknown): unknown {
  if (!isPlainObject(body)) return body;
  const profile = resolveReasoningProfile(config);
  if (profile === "claude" && config.provider === "anthropic") return dropForeignClaudeSignatures(body, config.ignore_invalid_history === false);
  if (profile !== "deepseek") return body;
  if (config.provider === "openai-chat") return addDeepSeekChatPlaceholders(body);
  if (config.provider === "anthropic") return addDeepSeekAnthropicPlaceholders(body);
  if (config.provider === "openai-responses") return addDeepSeekResponsesPlaceholders(body);
  return body;
}

// Claude signatures are long base64 strings; DeepSeek's are UUIDs.
export function looksLikeClaudeSignature(signature: unknown): boolean {
  return typeof signature === "string" && signature.length >= 100 && /^[A-Za-z0-9+/_-]+=*$/.test(signature);
}

// DeepSeek issues tool call ids like call_00_<random>; other providers use other shapes.
export function isDeepSeekToolCallId(id: unknown): boolean {
  return typeof id === "string" && /^call_\d{2}_/.test(id);
}

function dropForeignClaudeSignatures(body: Record<string, unknown>, keepEmptySignatures: boolean): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body;
  let changed = false;
  const messages = body.messages.map((message) => {
    if (!isPlainObject(message) || message.role !== "assistant" || !Array.isArray(message.content)) return message;
    const content = message.content.filter((block) => {
      if (!isPlainObject(block) || block.type !== "thinking") return true;
      if (keepEmptySignatures && (block.signature === undefined || block.signature === "")) return true;
      return looksLikeClaudeSignature(block.signature);
    });
    // Leave a turn untouched rather than send an assistant message with no content.
    if (content.length === message.content.length || content.length === 0) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? { ...body, messages } : body;
}

function addDeepSeekChatPlaceholders(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body;
  let changed = false;
  const messages = body.messages.map((message) => {
    if (!isPlainObject(message) || message.role !== "assistant" || !needsDeepSeekPlaceholder(message.tool_calls, (call) => call.id)) return message;
    if (typeof message.reasoning_content === "string") return message;
    changed = true;
    return { ...message, reasoning_content: "" };
  });
  return changed ? { ...body, messages } : body;
}

function addDeepSeekAnthropicPlaceholders(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body;
  let changed = false;
  const messages = body.messages.map((message) => {
    if (!isPlainObject(message) || message.role !== "assistant" || !Array.isArray(message.content)) return message;
    const toolUses = message.content.filter((block) => isPlainObject(block) && block.type === "tool_use");
    if (!needsDeepSeekPlaceholder(toolUses, (block) => block.id)) return message;
    if (message.content.some((block) => isPlainObject(block) && (block.type === "thinking" || block.type === "redacted_thinking"))) return message;
    changed = true;
    return { ...message, content: [{ type: "thinking", thinking: "", signature: "" }, ...message.content] };
  });
  return changed ? { ...body, messages } : body;
}

// Responses history is a flat item list; a turn runs until the next user or tool output item.
// DeepSeek's Responses endpoint needs non-empty reasoning_text: summaries and "" are rejected.
function addDeepSeekResponsesPlaceholders(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.input)) return body;
  let changed = false;
  const input: unknown[] = [];
  let turnHasReasoning = false;
  for (const item of body.input) {
    if (!isPlainObject(item)) {
      input.push(item);
      continue;
    }
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output" || ((item.type ?? "message") === "message" && item.role !== "assistant")) {
      turnHasReasoning = false;
      input.push(item);
      continue;
    }
    if (item.type === "reasoning") {
      const readable = reasoningText(item);
      if (readable && !reasoningText(item, "content")) {
        // Summary-only reasoning (e.g. from GPT) does not satisfy DeepSeek; copy it into content.
        changed = true;
        input.push({ ...item, content: [{ type: "reasoning_text", text: readable }] });
      } else {
        input.push(item);
      }
      turnHasReasoning ||= !!readable;
      continue;
    }
    if ((item.type === "function_call" || item.type === "custom_tool_call") && !turnHasReasoning && !isDeepSeekToolCallId(item.call_id)) {
      changed = true;
      input.push({ type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: " " }] });
      turnHasReasoning = true;
    }
    input.push(item);
  }
  return changed ? { ...body, input } : body;
}

function needsDeepSeekPlaceholder(calls: unknown, getId: (call: Record<string, unknown>) => unknown): boolean {
  if (!Array.isArray(calls) || calls.length === 0) return false;
  return calls.every((call) => isPlainObject(call) && !isDeepSeekToolCallId(getId(call)));
}

function reasoningText(item: Record<string, unknown>, field?: "content" | "summary"): string {
  const fields = field ? [field] : (["content", "summary"] as const);
  return fields
    .flatMap((name) => (Array.isArray(item[name]) ? (item[name] as unknown[]) : []))
    .map((part) => (isPlainObject(part) && typeof part.text === "string" ? part.text : ""))
    .join("");
}

function upstreamHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
