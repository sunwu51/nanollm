export const CLAUDE_CODE_SYSTEM_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

const BILLING_PREFIX = "x-anthropic-billing-header:";
// Prompts a Claude client itself sends; anything else is a third-party harness prompt.
const CLAUDE_IDENTITY_PREFIXES = ["You are Claude Code", "You are a Claude agent"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBillingBlock(block: unknown): boolean {
  return isRecord(block) && typeof block.text === "string" && block.text.startsWith(BILLING_PREFIX);
}

/**
 * Subscription credentials are billed as plan usage only when the system prompt looks like Claude Code's.
 * A third-party harness prompt (pi, ...) in `system` is billed to extra usage instead, so move it verbatim into a
 * leading `<system-reminder>` block of the first user message and leave only the Claude Code identity in `system`.
 * Run after the billing block is added: it stays first and is never relocated. Claude prompts pass through.
 */
export function relocateNonClaudeSystemPrompt(body: unknown): unknown {
  if (!isRecord(body) || !Array.isArray(body.messages)) return body;
  const system = body.system;
  if (system !== undefined && system !== null && typeof system !== "string" && !Array.isArray(system)) return body;

  const blocks = (typeof system === "string" ? [{ type: "text", text: system }] : Array.isArray(system) ? system : [])
    .filter((block) => !isBillingBlock(block));
  const texts = blocks.flatMap((block) => (isRecord(block) && typeof block.text === "string" && block.text.trim() ? [block.text] : []));
  if (texts.length === 0) return body;
  if (CLAUDE_IDENTITY_PREFIXES.some((prefix) => texts[0].trimStart().startsWith(prefix))) return body;

  const billing = Array.isArray(system) ? system.filter(isBillingBlock) : [];
  const cacheControl = blocks.map((block) => (isRecord(block) ? block.cache_control : undefined)).filter((value) => value !== undefined).pop();
  const reminder: Record<string, unknown> = { type: "text", text: `<system-reminder>\n${texts.join("\n\n")}\n</system-reminder>` };
  if (cacheControl !== undefined) reminder.cache_control = cacheControl;

  const [first, ...rest] = body.messages;
  let messages: unknown[];
  if (isRecord(first) && first.role === "user") {
    const content = typeof first.content === "string" ? [{ type: "text", text: first.content }] : Array.isArray(first.content) ? first.content : [];
    messages = [{ ...first, content: [reminder, ...content] }, ...rest];
  } else {
    messages = [{ role: "user", content: [reminder] }, ...body.messages];
  }
  return { ...body, system: [...billing, { type: "text", text: CLAUDE_CODE_SYSTEM_IDENTITY }], messages };
}
