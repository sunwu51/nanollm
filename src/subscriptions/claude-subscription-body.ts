import { parseClaudeMetadataIdentity, resolveSessionId } from "../core/session-id.js";

export const CLAUDE_SUBSCRIPTION_DEFAULT_MAX_TOKENS = 128000;

export function hasClaudeMetadataUserId(body: unknown): boolean {
  return isRecord(body) && isRecord(body.metadata) && typeof body.metadata.user_id === "string" && body.metadata.user_id.trim().length > 0;
}

export interface ClaudeSubscriptionIdentityOptions {
  provider: string;
  deviceId: string;
  clientHeaders?: Headers;
  clientIp?: string;
  promptCacheKey?: string;
  sessionId?: string;
}

export function resolveClaudeSubscriptionSessionId(body: unknown, options: ClaudeSubscriptionIdentityOptions): string {
  return resolveSessionId(body, { ...options, namespace: options.provider });
}

export function addClaudeSubscriptionUserId(body: unknown, options: ClaudeSubscriptionIdentityOptions): unknown {
  if (!isRecord(body)) return body;
  const sessionId = resolveClaudeSubscriptionSessionId(body, options);
  if (hasClaudeMetadataUserId(body)) {
    const identity = parseClaudeMetadataIdentity(body);
    if (identity) {
      if (identity.session_id === sessionId) return body;
      return { ...body, metadata: { ...(body.metadata as Record<string, unknown>), user_id: JSON.stringify({ ...identity, session_id: sessionId }) } };
    }
    const metadata = body.metadata as Record<string, unknown>;
    const raw = metadata.user_id as string;
    const legacy = /^user_[a-f0-9]{64}_account_[a-f0-9-]*_session_[a-f0-9-]{36}$/i.test(raw);
    if (legacy) return { ...body, metadata: { ...metadata, user_id: raw.replace(/_session_.*$/, () => `_session_${sessionId}`) } };
    return body;
  }
  return { ...body, metadata: {
    ...(isRecord(body.metadata) ? body.metadata : {}),
    user_id: JSON.stringify({ device_id: options.deviceId, account_uuid: "", session_id: sessionId }),
  } };
}

/** Resolve the final header first, then copy exactly that value into metadata. */
export function applyClaudeSubscriptionSessionIdentity(body: unknown, headers: Record<string, string>, options: ClaudeSubscriptionIdentityOptions): unknown {
  const sessionId = resolveClaudeSubscriptionSessionId(body, { ...options, sessionId: new Headers(headers).get("x-claude-code-session-id") ?? undefined });
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === "x-claude-code-session-id") delete headers[name];
  }
  headers["x-claude-code-session-id"] = sessionId;
  return addClaudeSubscriptionUserId(body, { ...options, sessionId });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOpus55(model: unknown): boolean {
  if (typeof model !== "string") return false;
  let id = model.trim().toLowerCase().replace(/^models\//, "");
  if (id.includes("/")) id = id.slice(id.indexOf("/") + 1).trim().replace(/^models\//, "");
  id = id.replace(/^(?:us-gov|global|apac|us|eu|jp|au)\./, "").replace(/^anthropic\./, "");
  id = id.replace(/-thinking$/, "").replace(/-\d{8}$/, "");
  return id === "claude-opus-5-5" || id === "claude-opus-5.5";
}

/** Apply subscription defaults and sub2api's explicit cache breakpoint cleanup. */
export function sanitizeClaudeSubscriptionBody(body: unknown): unknown {
  if (!isRecord(body)) return body;
  const result = structuredClone(body);
  if (result.tools === undefined) result.tools = [];
  if (result.max_tokens === undefined) result.max_tokens = CLAUDE_SUBSCRIPTION_DEFAULT_MAX_TOKENS;
  if (result.temperature === undefined && !isOpus55(result.model)) result.temperature = 1;
  if (!Array.isArray(result.tools) || result.tools.length === 0) delete result.tool_choice;

  const systemBreakpoints: Record<string, unknown>[] = [];
  const messageBreakpoints: Record<string, unknown>[] = [];
  const toolBreakpoints: Record<string, unknown>[] = [];
  const collect = (blocks: unknown, breakpoints: Record<string, unknown>[]) => {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (!isRecord(block) || !("cache_control" in block)) continue;
      if (block.type === "thinking") delete block.cache_control;
      else breakpoints.push(block);
    }
  };
  collect(result.system, systemBreakpoints);
  if (Array.isArray(result.messages)) {
    for (const message of result.messages) {
      if (isRecord(message)) collect(message.content, messageBreakpoints);
    }
  }
  if (Array.isArray(result.tools)) {
    for (const tool of result.tools) {
      if (isRecord(tool) && "cache_control" in tool) toolBreakpoints.push(tool);
    }
  }
  let excess = systemBreakpoints.length + messageBreakpoints.length + toolBreakpoints.length - 4;
  for (const block of [...toolBreakpoints.reverse(), ...messageBreakpoints, ...systemBreakpoints.reverse()]) {
    if (excess <= 0) break;
    delete block.cache_control;
    excess--;
  }
  return result;
}
