import { createHash } from "node:crypto";

export interface SessionIdOptions {
  /** Mixed into generated ids so different consumers (e.g. two subscription providers) never share one. */
  namespace: string;
  clientHeaders?: Headers;
  clientIp?: string;
  promptCacheKey?: string;
  sessionId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse the JSON form of Anthropic `metadata.user_id` (`{"device_id":…,"session_id":…}`) used by Claude Code. */
export function parseClaudeMetadataIdentity(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body) || !isRecord(body.metadata) || typeof body.metadata.user_id !== "string" || !body.metadata.user_id.trim()) return undefined;
  try {
    const identity: unknown = JSON.parse(body.metadata.user_id);
    return isRecord(identity) ? identity : undefined;
  } catch { return undefined; }
}

/**
 * Resolve a stable session id for an Anthropic Messages request body.
 * Order: explicit id / `x-claude-code-session-id` header, `metadata.user_id` session, legacy user_id format,
 * session/thread/conversation headers, prompt_cache_key, then a hash of client IP + user agent + first user text.
 * Derived ids are formatted as UUIDv4 so they are accepted wherever a session UUID is expected.
 */
export function resolveSessionId(body: unknown, options: SessionIdOptions): string {
  const explicit = options.sessionId?.trim() || options.clientHeaders?.get("x-claude-code-session-id")?.trim();
  if (explicit) return explicit;
  const identity = parseClaudeMetadataIdentity(body);
  if (typeof identity?.session_id === "string" && identity.session_id.trim()) return identity.session_id.trim();
  if (isRecord(body) && isRecord(body.metadata) && typeof body.metadata.user_id === "string") {
    const legacy = /^user_[a-f0-9]{64}_account_[a-f0-9-]*_session_([a-f0-9-]{36})$/i.exec(body.metadata.user_id);
    if (legacy) return legacy[1]!;
  }
  let source = "fallback";
  let value = "";
  for (const name of ["session_id", "thread_id", "conversation_id"]) {
    const hint = options.clientHeaders?.get(name)?.trim();
    if (hint) { source = name; value = hint; break; }
  }
  if (!value && options.promptCacheKey?.trim()) {
    source = "prompt_cache_key";
    value = options.promptCacheKey.trim();
  }
  if (!value) {
    const firstUser = isRecord(body) && Array.isArray(body.messages)
      ? body.messages.find((message) => isRecord(message) && message.role === "user") : undefined;
    const content = isRecord(firstUser) ? firstUser.content : undefined;
    const text = typeof content === "string" ? content : Array.isArray(content)
      ? content.filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n") : "";
    value = JSON.stringify([options.clientIp ?? "", options.clientHeaders?.get("user-agent") ?? "", text]);
  }
  const hash = createHash("sha256").update(JSON.stringify([options.namespace, source, value])).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x40;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
