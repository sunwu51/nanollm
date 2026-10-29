// Claude 5.x ties each replayed thinking block to the conversation before it: the system prompt, the
// tools and every earlier message must be unchanged, or the request fails with 400 "Invalid `signature`
// in `thinking` block. The block is bound to a different conversation." (new accounts, see
// docs/claude-thinking-rules.md). nanollm rewrites history when it converts between protocols or degrades
// a search it cannot replay, so such a request may fail through no fault of the client. Anthropic's
// advice is to strip the thinking blocks and retry once; doing it only after the error keeps prompt-cache
// hits (and the model's earlier reasoning) for every conversation that is accepted as it is.

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isThinkingBindingError(error: unknown): boolean {
  if (!isPlainObject(error) && !(error instanceof Error)) return false;
  const { status, upstream } = error as { status?: unknown; upstream?: unknown };
  return status === 400 && typeof upstream === "string" && upstream.includes("bound to a different conversation");
}

/** The body without any thinking or redacted_thinking block, or undefined when it had none. */
export function stripThinkingBlocks(body: unknown): unknown | undefined {
  if (!isPlainObject(body) || !Array.isArray(body.messages)) return undefined;
  let changed = false;
  const messages = body.messages.flatMap((message) => {
    if (!isPlainObject(message) || message.role !== "assistant" || !Array.isArray(message.content)) return [message];
    const content = message.content.filter((block) => !(isPlainObject(block) && (block.type === "thinking" || block.type === "redacted_thinking")));
    if (content.length === message.content.length) return [message];
    changed = true;
    // A turn that was only thinking has nothing left to send.
    return content.length === 0 ? [] : [{ ...message, content }];
  });
  return changed ? { ...body, messages } : undefined;
}
