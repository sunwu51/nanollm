import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import type { CustomProviderConfig } from "../core/config.js";
import { oauthPost } from "./oauth-transport.js";
import { CLAUDE_CODE_USER_AGENT, CLAUDE_OAUTH_BETA } from "./subscription-client-compat.js";
import { extractUpstreamModelIds } from "../proxy/upstream-models.js";

export { CLAUDE_CLI_USER_AGENT, CLAUDE_CODE_BETA, CLAUDE_OAUTH_BETA } from "./subscription-client-compat.js";

// OAuth constants mirror Claude Code (cc-haha src/constants/oauth.ts, prod config).
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
// Claude has no device-code flow. The manual redirect page is what Claude Code uses when it cannot
// listen on localhost: the user copies the callback URL (or the displayed `code#state`) back to us.
const MANUAL_REDIRECT_URL = "https://platform.claude.com/oauth/code/callback";
const API_BASE_URL = "https://api.anthropic.com";
const PROFILE_URL = `${API_BASE_URL}/api/oauth/profile`;
const USAGE_URL = `${API_BASE_URL}/api/oauth/usage`;
export const CLAUDE_MESSAGES_URL = `${API_BASE_URL}/v1/messages?beta=true`;
// The token endpoint rate-limits unfamiliar clients; a plain Node user agent is accepted.
const TOKEN_USER_AGENT = "node";
const LOGIN_SCOPES = ["org:create_api_key", "user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"];
const REFRESH_SCOPES = ["user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"];
const SESSION_TTL_MS = 10 * 60_000;
const REFRESH_BUFFER_MS = 5 * 60_000;
const UUID_JSON_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i;

export interface ClaudeSubscriptionCredential {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
  accountUuid?: string;
  deviceId?: string;
  email?: string;
  organizationUuid?: string;
  obtainedAt?: number;
  providerName?: string;
  [key: string]: unknown;
}

interface LoginSession { provider: string; proxy?: string; state: string; codeVerifier: string; expiresAt: number }

const timers = new Map<string, NodeJS.Timeout>();
const cache = new Map<string, ClaudeSubscriptionCredential>();
const credentialPaths = new Map<string, string>();
const refreshing = new Map<string, Promise<ClaudeSubscriptionCredential>>();
const loginSessions = new Map<string, LoginSession>();
let subscriptionProviders = new Map<string, CustomProviderConfig>();
let credentialDirectory: string | undefined;

export function configureClaudeSubscriptionStorage(configPath: string) {
  credentialDirectory = join(dirname(resolve(configPath)), "claude-subscription");
}

function providerDir() {
  if (!credentialDirectory) throw new Error("Claude subscription storage has not been configured");
  mkdirSync(credentialDirectory, { recursive: true });
  return credentialDirectory;
}

function load(name: string): ClaudeSubscriptionCredential | undefined {
  if (cache.has(name)) return cache.get(name);
  const dir = providerDir();
  for (const file of readdirSync(dir).filter((item) => UUID_JSON_PATTERN.test(item))) {
    const path = join(dir, file);
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as ClaudeSubscriptionCredential;
      if (value.providerName === name) { cache.set(name, value); credentialPaths.set(name, path); return value; }
    } catch {}
  }
  return undefined;
}

function save(name: string, value: ClaudeSubscriptionCredential) {
  const dir = providerDir();
  const oldPath = credentialPaths.get(name);
  const path = oldPath && dirname(oldPath) === dir ? oldPath : join(dir, `${randomUUID()}.json`);
  const persisted = { ...value, deviceId: value.deviceId ?? cache.get(name)?.deviceId, providerName: name };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(persisted, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
  credentialPaths.set(name, path);
  cache.set(name, persisted);
}

function schedule(name: string, value: ClaudeSubscriptionCredential) {
  const old = timers.get(name); if (old) clearTimeout(old);
  const delay = Math.max(30_000, value.expiresAt - Date.now() - REFRESH_BUFFER_MS);
  timers.set(name, setTimeout(() => {
    void refresh(name).catch((e) => console.error(`[CLAUDE SUBSCRIPTION] refresh failed for ${name}:`, e));
  }, delay));
}

function base64url(buffer: Buffer) { return buffer.toString("base64url"); }

async function tokenRequest(body: Record<string, string>, proxy?: string) {
  const response = await oauthPost(TOKEN_URL, JSON.stringify(body), "application/json", proxy, TOKEN_USER_AGENT);
  let data: any;
  try { data = JSON.parse(response.body); } catch { throw new Error(`Claude OAuth token request failed (${response.status}): ${response.body.slice(0, 240)}`); }
  if (response.status < 200 || response.status >= 300) {
    const message = data?.error_description || data?.error?.message || (typeof data?.error === "string" ? data.error : undefined) || "unknown error";
    throw new Error(`Claude OAuth token request failed (${response.status}): ${message}`);
  }
  if (!data?.access_token) throw new Error("Claude OAuth token response is missing access_token");
  return data;
}

function oauthApiHeaders(accessToken: string): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "anthropic-beta": CLAUDE_OAUTH_BETA,
    "User-Agent": CLAUDE_CODE_USER_AGENT,
  };
}

async function fetchProfile(accessToken: string, proxy?: string): Promise<any | undefined> {
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  try {
    const response = await undiciFetch(PROFILE_URL, { dispatcher, headers: oauthApiHeaders(accessToken), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) { await response.body?.cancel(); return undefined; }
    return await response.json();
  } catch {
    return undefined;
  } finally {
    await dispatcher?.close();
  }
}

function subscriptionTypeFromProfile(profile: any): string | null {
  switch (profile?.organization?.organization_type) {
    case "claude_max": return "max";
    case "claude_pro": return "pro";
    case "claude_enterprise": return "enterprise";
    case "claude_team": return "team";
    default: return null;
  }
}

function credentialFromToken(token: any, previous: Partial<ClaudeSubscriptionCredential> = {}): ClaudeSubscriptionCredential {
  const scopes = typeof token.scope === "string" ? token.scope.split(" ").filter(Boolean) : previous.scopes;
  return {
    ...previous,
    accessToken: token.access_token,
    refreshToken: token.refresh_token || previous.refreshToken || "",
    expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000,
    obtainedAt: Date.now(),
    ...(scopes ? { scopes } : {}),
    accountUuid: token.account?.uuid || previous.accountUuid,
    email: token.account?.email_address || previous.email,
    organizationUuid: token.organization?.uuid || previous.organizationUuid,
  };
}

function applyProfile(credential: ClaudeSubscriptionCredential, profile: any): ClaudeSubscriptionCredential {
  if (!profile) return credential;
  return {
    ...credential,
    subscriptionType: subscriptionTypeFromProfile(profile) ?? credential.subscriptionType ?? null,
    rateLimitTier: profile.organization?.rate_limit_tier ?? credential.rateLimitTier ?? null,
    accountUuid: profile.account?.uuid || credential.accountUuid,
    email: profile.account?.email || profile.account?.email_address || credential.email,
    organizationUuid: profile.organization?.uuid || credential.organizationUuid,
  };
}

export interface ClaudeLoginStart { authorizeUrl: string; sessionId: string; expiresIn: number; redirectUri: string }

export function startClaudeLogin(provider: CustomProviderConfig): ClaudeLoginStart {
  if (provider.provider !== "claude-subscription") throw new Error("Provider is not a Claude subscription");
  providerDir();
  const now = Date.now();
  for (const [id, session] of loginSessions) if (session.expiresAt <= now) loginSessions.delete(id);
  const codeVerifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(32));
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.append("code", "true");
  url.searchParams.append("client_id", CLIENT_ID);
  url.searchParams.append("response_type", "code");
  url.searchParams.append("redirect_uri", MANUAL_REDIRECT_URL);
  url.searchParams.append("scope", LOGIN_SCOPES.join(" "));
  url.searchParams.append("code_challenge", base64url(createHash("sha256").update(codeVerifier).digest()));
  url.searchParams.append("code_challenge_method", "S256");
  url.searchParams.append("state", state);
  const sessionId = randomUUID();
  loginSessions.set(sessionId, { provider: provider.name, proxy: provider.proxy, state, codeVerifier, expiresAt: now + SESSION_TTL_MS });
  return { authorizeUrl: url.toString(), sessionId, expiresIn: SESSION_TTL_MS / 1000, redirectUri: MANUAL_REDIRECT_URL };
}

/** Accepts the full callback URL, or the `code#state` text shown on Claude's callback page. */
export function parseClaudeCallback(input: string): { code: string; state?: string } {
  const text = input.trim();
  if (!text) throw new Error("请粘贴授权完成后浏览器地址栏中的完整 callback URL");
  let code: string | null = null;
  let state: string | null = null;
  if (/^https?:\/\//i.test(text)) {
    const url = new URL(text);
    const error = url.searchParams.get("error");
    if (error) throw new Error(`Claude authorization was rejected: ${url.searchParams.get("error_description") || error}`);
    code = url.searchParams.get("code");
    state = url.searchParams.get("state");
    if (!state && url.hash) state = decodeURIComponent(url.hash.slice(1)) || null;
  } else {
    code = text;
  }
  if (code && code.includes("#")) {
    const [codePart, statePart] = code.split("#", 2);
    code = codePart;
    state ||= statePart || null;
  }
  if (!code) throw new Error("Callback URL 中没有找到授权 code");
  return { code, ...(state ? { state } : {}) };
}

export async function completeClaudeLogin(sessionId: string, callback: string): Promise<{ status: "authenticated"; email?: string; subscriptionType?: string | null }> {
  const session = loginSessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now()) { loginSessions.delete(sessionId); throw new Error("Claude 登录会话已过期，请重新点击登录"); }
  const { code, state } = parseClaudeCallback(callback);
  if (!state) throw new Error("Callback URL 中缺少 state，请复制完整的 callback URL");
  if (state !== session.state) throw new Error("OAuth state 不匹配，请使用本次登录打开的授权页面生成的 callback URL");
  const token = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: MANUAL_REDIRECT_URL,
    client_id: CLIENT_ID,
    code_verifier: session.codeVerifier,
    state,
  }, session.proxy);
  if (!token.refresh_token) throw new Error("Claude OAuth token response is missing refresh_token");
  loginSessions.delete(sessionId);
  const value = applyProfile(credentialFromToken(token), await fetchProfile(token.access_token, session.proxy));
  save(session.provider, value);
  schedule(session.provider, value);
  return { status: "authenticated", email: value.email, subscriptionType: value.subscriptionType };
}

async function refresh(name: string): Promise<ClaudeSubscriptionCredential> {
  const pending = refreshing.get(name);
  if (pending) return pending;
  const task = (async () => {
    const provider = subscriptionProviders.get(name);
    if (!provider) throw new Error(`Claude subscription provider '${name}' is not configured`);
    const current = load(name);
    if (!current?.refreshToken) throw new Error(`No refresh token for Claude subscription provider '${name}'`);
    const token = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: CLIENT_ID,
      scope: (current.scopes?.length ? current.scopes : REFRESH_SCOPES).join(" "),
    }, provider.proxy);
    let value = credentialFromToken(token, current);
    if (!value.subscriptionType) value = applyProfile(value, await fetchProfile(value.accessToken, provider.proxy));
    save(name, value);
    schedule(name, value);
    return value;
  })();
  refreshing.set(name, task);
  try { return await task; } finally { refreshing.delete(name); }
}

export async function ensureClaudeSubscriptionCredential(name: string) {
  const value = load(name);
  if (value && value.expiresAt > Date.now() + REFRESH_BUFFER_MS) { schedule(name, value); return value; }
  if (value?.refreshToken) return refresh(name);
  throw new Error(`Claude subscription provider '${name}' is not authenticated. Sign in from the admin page.`);
}

export function getCachedClaudeSubscriptionCredential(name: string) { return load(name); }

/** Persist one device identity per subscription provider, including legacy credentials. */
export function getOrCreateClaudeSubscriptionDeviceId(name: string): string {
  const credential = load(name);
  if (!credential) throw new Error(`Claude subscription provider '${name}' is not authenticated`);
  if (typeof credential.deviceId === "string" && /^[a-f0-9]{64}$/i.test(credential.deviceId)) return credential.deviceId;
  const deviceId = randomBytes(32).toString("hex");
  save(name, { ...credential, deviceId });
  return deviceId;
}

/**
 * Headers for the Claude model list. `identityHeaders` should carry the Claude Code fingerprint and betas
 * (applyClaudeSubscriptionHeaders): Claude Code OAuth credentials are scoped to Claude Code, and sub2api sends
 * the full CLI identity on this request too. Without them we fall back to the OAuth beta only.
 */
export function buildClaudeModelsHeaders(accessToken: string, identityHeaders: Record<string, string> = {}): Record<string, string> {
  return {
    Accept: "application/json",
    // Lowercase like the identity headers' user-agent, so that one replaces this fallback instead of duplicating it.
    "user-agent": CLAUDE_CODE_USER_AGENT,
    "anthropic-beta": CLAUDE_OAUTH_BETA,
    ...identityHeaders,
    Authorization: `Bearer ${accessToken}`,
    "anthropic-version": "2023-06-01",
  };
}

/** List the models available to the Claude account (`/v1/models` with the OAuth bearer token), following pagination. */
export async function fetchClaudeSubscriptionModels(name: string, proxyUrl?: string, identityHeaders: Record<string, string> = {}): Promise<string[]> {
  let credential = await ensureClaudeSubscriptionCredential(name);
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  const ids: string[] = [];
  try {
    let afterId: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const url = `${API_BASE_URL}/v1/models?limit=1000${afterId ? `&after_id=${encodeURIComponent(afterId)}` : ""}`;
      const request = () => undiciFetch(url, {
        dispatcher,
        headers: buildClaudeModelsHeaders(credential.accessToken, identityHeaders),
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      let response = await request();
      if (response.status === 401 && credential.refreshToken) {
        await response.body?.cancel();
        credential = await refresh(name);
        response = await request();
      }
      const text = await response.text();
      if (!response.ok) throw new Error(response.status === 401 ? "Claude authorization expired; please sign in again" : `Claude models request failed (${response.status}): ${text.slice(0, 240)}`);
      let payload: any;
      try { payload = JSON.parse(text); } catch { throw new Error("Claude models response is not valid JSON"); }
      ids.push(...extractUpstreamModelIds(payload));
      if (payload?.has_more !== true || typeof payload.last_id !== "string") break;
      afterId = payload.last_id;
    }
  } finally {
    await dispatcher?.close();
  }
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

export async function fetchClaudeSubscriptionUsage(name: string, proxyUrl?: string) {
  let credential = await ensureClaudeSubscriptionCredential(name);
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  try {
    const request = () => undiciFetch(USAGE_URL, { dispatcher, headers: oauthApiHeaders(credential.accessToken), cache: "no-store", signal: AbortSignal.timeout(15_000) });
    let response = await request();
    if (response.status === 401 && credential.refreshToken) {
      await response.body?.cancel();
      credential = await refresh(name);
      response = await request();
    }
    const text = await response.text();
    if (!response.ok) throw new Error(response.status === 401 ? "Claude authorization expired; please sign in again" : `Claude usage request failed (${response.status}): ${text.slice(0, 240)}`);
    let payload: any;
    try { payload = JSON.parse(text); } catch { throw new Error("Claude usage response is not valid JSON"); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Claude usage response has an unknown format");
    return { ...payload, subscription_type: credential.subscriptionType ?? null, rate_limit_tier: credential.rateLimitTier ?? null, email: credential.email ?? null };
  } finally {
    await dispatcher?.close();
  }
}

export function bootstrapClaudeSubscriptionProviders(providers: CustomProviderConfig[]) {
  subscriptionProviders = new Map(providers.filter((provider) => provider.provider === "claude-subscription").map((provider) => [provider.name, { ...provider }]));
  for (const [name, timer] of timers) {
    if (!subscriptionProviders.has(name)) { clearTimeout(timer); timers.delete(name); }
  }
  for (const name of subscriptionProviders.keys()) {
    const value = load(name);
    if (!value) { console.warn(`[CLAUDE SUBSCRIPTION] ${name}: no credential file; sign in from the admin page`); continue; }
    // Backfill legacy credential files once; keep the identity across restarts.
    getOrCreateClaudeSubscriptionDeviceId(name);
    if (value.expiresAt > Date.now() + REFRESH_BUFFER_MS) { schedule(name, value); continue; }
    if (value.refreshToken) void refresh(name).catch((e) => console.error(`[CLAUDE SUBSCRIPTION] refresh failed for ${name}:`, e));
  }
}
