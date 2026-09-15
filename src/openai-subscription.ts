import { mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { oauthPost } from "./oauth-transport.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_USER_CODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const DEVICE_VERIFICATION_URI = "https://auth.openai.com/codex/device";
const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
export const SUBSCRIPTION_URL = "https://chatgpt.com/backend-api/codex";
const timers = new Map<string, NodeJS.Timeout>();
const cache = new Map<string, SubscriptionCredential>();
const deviceSessions = new Map<string, { provider: string; deviceAuthId: string; userCode: string; expiresAt: number; interval: number }>();
let credentialDirectory: string | undefined;
const UUID_JSON_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i;

export interface SubscriptionCredential {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
  idToken?: string;
  email?: string;
  scope?: string;
  tokenType?: string;
  obtainedAt?: number;
  planType?: string;
  availableModels?: unknown;
  providerName?: string;
  [key: string]: unknown;
}

function extractAccountId(token: unknown): string | undefined {
  if (typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = payload["https://api.openai.com/auth"];
    if (!auth || typeof auth !== "object") return undefined;
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
  } catch {
    return undefined;
  }
}

function normalizeCredential(value: SubscriptionCredential): SubscriptionCredential {
  return {
    ...value,
    accountId: value.accountId || extractAccountId(value.accessToken) || extractAccountId(value.idToken),
  };
}

export function configureSubscriptionStorage(configPath: string) {
  credentialDirectory = join(dirname(resolve(configPath)), "openai-subscription");
}

function providerDir() {
  if (!credentialDirectory) throw new Error("OpenAI subscription storage has not been configured");
  const dir = credentialDirectory;
  mkdirSync(dir, { recursive: true });
  return dir;
}
function decode(raw: string): SubscriptionCredential {
  const text = raw.trim();
  try {
    return JSON.parse(text) as SubscriptionCredential;
  } catch {
    // Keep reading credentials written by the earlier base64url format.
    return JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as SubscriptionCredential;
  }
}
function load(name: string): SubscriptionCredential | undefined {
  if (cache.has(name)) return cache.get(name);
  const currentDir = providerDir();
  const candidates = readdirSync(currentDir)
    .filter((file) => UUID_JSON_PATTERN.test(file))
    .map((file) => join(currentDir, file));
  for (const path of candidates) {
    try {
      const value = normalizeCredential(decode(readFileSync(path, "utf8")));
      if (value.providerName === name) { cache.set(name, value); credentialPaths.set(name, path); return value; }
    } catch {}
  }
  return undefined;
}
const credentialPaths = new Map<string, string>();
function save(name: string, value: SubscriptionCredential) {
  const oldPath = credentialPaths.get(name);
  const currentDir = providerDir();
  const path = oldPath && oldPath.endsWith(".json") && dirname(oldPath) === currentDir
    ? oldPath
    : join(currentDir, `${randomUUID()}.json`);
  const persisted = { ...value, providerName: name };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(persisted, null, 2)}\n`, "utf8"); renameSync(tmp, path);
  credentialPaths.set(name, path); cache.set(name, persisted);
}
function schedule(name: string, value: SubscriptionCredential) {
  const old = timers.get(name); if (old) clearTimeout(old);
  const delay = Math.max(30_000, value.expiresAt - Date.now() - 5 * 60_000);
  timers.set(name, setTimeout(() => { void refresh(name).catch((e) => console.error(`[OPENAI SUBSCRIPTION] refresh failed for ${name}:`, e)); }, delay));
}
async function tokenRequest(body: URLSearchParams) {
  const response = await oauthPost(TOKEN_URL, body);
  const text = response.body;
  let data: any;
  try { data = JSON.parse(text); } catch { throw new Error(`OpenAI OAuth token request failed (${response.status}): ${text.slice(0, 240)}`); }
  if (response.status < 200 || response.status >= 300) throw new Error(`OpenAI OAuth token request failed (${response.status}): ${data.error_description || data.error || "unknown error"}`);
  return data;
}
export interface DeviceLoginStart { verificationUri: string; verificationUriComplete?: string; userCode: string; sessionId: string; expiresIn: number; interval: number; }
export async function startDeviceLogin(name: string): Promise<DeviceLoginStart> {
  providerDir();
  const response = await oauthPost(DEVICE_USER_CODE_URL, JSON.stringify({ client_id: CLIENT_ID }), "application/json");
  const text = response.body;
  let data: any;
  try { data = JSON.parse(text); } catch { throw new Error(`OpenAI device code request failed (${response.status}): ${text.slice(0, 240)}`); }
  if (response.status < 200 || response.status >= 300) throw new Error(`OpenAI device code request failed (${response.status}): ${data.error_description || data.error || "unknown error"}`);
  const sessionId = crypto.randomUUID();
  const expiresIn = 15 * 60;
  const interval = Number(data.interval || 5);
  if (!data.device_auth_id || !data.user_code) throw new Error("OpenAI device code response is missing required fields");
  deviceSessions.set(sessionId, { provider: name, deviceAuthId: data.device_auth_id, userCode: data.user_code, expiresAt: Date.now() + expiresIn * 1000, interval });
  return { verificationUri: DEVICE_VERIFICATION_URI, userCode: data.user_code, sessionId, expiresIn, interval };
}
export async function pollDeviceLogin(sessionId: string): Promise<{ status: "pending" | "authenticated"; retryAfter?: number }> {
  const session = deviceSessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now()) { deviceSessions.delete(sessionId); throw new Error("Device login session expired"); }
  const response = await oauthPost(DEVICE_TOKEN_URL, JSON.stringify({ device_auth_id: session.deviceAuthId, user_code: session.userCode }), "application/json");
  const text = response.body;
  let data: any;
  try { data = JSON.parse(text); } catch { throw new Error(`OpenAI device login failed (${response.status}): ${text.slice(0, 240)}`); }
  if (response.status < 200 || response.status >= 300) {
    const errorCode = typeof data.error === "object" ? data.error?.code : data.error;
    if (response.status === 403 || response.status === 404 || errorCode === "deviceauth_authorization_pending" || errorCode === "authorization_pending" || errorCode === "slow_down") return { status: "pending", retryAfter: errorCode === "slow_down" ? session.interval + 5 : session.interval };
    throw new Error(`OpenAI device login failed (${response.status}): ${data.error_description || data.error || "unknown error"}`);
  }
  if (!data.authorization_code || !data.code_verifier) throw new Error("OpenAI device login response is missing authorization code fields");
  const token = await tokenRequest(new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT_ID, code: data.authorization_code, code_verifier: data.code_verifier, redirect_uri: DEVICE_REDIRECT_URI }));
  const value = normalizeCredential({ ...token, accessToken: token.access_token, refreshToken: token.refresh_token, idToken: token.id_token, expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000, obtainedAt: Date.now(), accountId: token.account_id });
  save(session.provider, value); schedule(session.provider, value); deviceSessions.delete(sessionId);
  return { status: "authenticated" };
}
async function refresh(name: string): Promise<SubscriptionCredential> {
  const current = load(name); if (!current?.refreshToken) throw new Error(`No refresh token for subscription provider '${name}'`);
  const token = await tokenRequest(new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: CLIENT_ID }));
  const value = normalizeCredential({ ...current, ...token, accessToken: token.access_token, refreshToken: token.refresh_token || current.refreshToken, idToken: token.id_token || current.idToken, expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000, obtainedAt: Date.now() });
  save(name, value); schedule(name, value); return value;
}
export async function ensureSubscriptionCredential(name: string) {
  const value = load(name);
  if (value && value.expiresAt > Date.now() + 60_000) { schedule(name, value); return value; }
  if (value?.refreshToken) return refresh(name);
  throw new Error(`OpenAI subscription provider '${name}' is not authenticated. Start device login from the admin page.`);
}
export function getCachedSubscriptionCredential(name: string) { return load(name); }
export async function fetchSubscriptionUsage(name: string) {
  let credential = await ensureSubscriptionCredential(name);
  if (!credential.accountId) throw new Error(`OpenAI subscription provider '${name}' is missing an account ID`);
  const request = () => fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${credential.accessToken}`,
      "ChatGPT-Account-Id": credential.accountId!,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  let response = await request();
  if (response.status === 401 && credential.refreshToken) {
    credential = await refresh(name);
    response = await request();
  }
  const text = await response.text();
  if (!response.ok) throw new Error(response.status === 401 ? "OpenAI authorization expired; please sign in again" : `OpenAI usage request failed (${response.status}): ${text.slice(0, 240)}`);
  let payload: any;
  try { payload = JSON.parse(text); } catch { throw new Error("OpenAI usage response is not valid JSON"); }
  if (!payload || typeof payload !== "object" || !("rate_limit" in payload)) throw new Error("OpenAI usage response has an unknown format");
  return payload;
}
export function bootstrapSubscriptionProviders(names: string[]) {
  for (const name of names) {
    const value = load(name);
    if (!value) { console.warn(`[OPENAI SUBSCRIPTION] ${name}: no credential file; authenticate when the model is first used`); continue; }
    if (value.expiresAt > Date.now() + 60_000) { schedule(name, value); continue; }
    if (value.refreshToken) void refresh(name).catch((e) => console.error(`[OPENAI SUBSCRIPTION] refresh failed for ${name}:`, e));
  }
}
