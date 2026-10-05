import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { oauthPost, resolveOAuthTransportPath } from "../src/subscriptions/oauth-transport.js";
import { bootstrapClaudeSubscriptionProviders, completeClaudeLogin, configureClaudeSubscriptionStorage, ensureClaudeSubscriptionCredential, getCachedClaudeSubscriptionCredential, getOrCreateClaudeSubscriptionDeviceId, parseClaudeCallback, startClaudeLogin } from "../src/subscriptions/claude-subscription.js";
import { parseConfigText } from "../src/core/config.js";
import { applyClaudeSubscriptionHeaders, getUpstreamURL, mergeHeaders } from "../src/proxy/proxy.js";
import { applyClaudeSubscriptionSessionIdentity } from "../src/subscriptions/claude-subscription-body.js";
import { runWithRequestId, setClientIp, setClientRequestHeaders } from "../src/core/request-context.js";
import { bootstrapSubscriptionProviders, configureSubscriptionStorage, startDeviceLogin, pollDeviceLogin, ensureSubscriptionCredential, getCachedSubscriptionCredential } from "../src/subscriptions/openai-subscription.js";

test("Claude device ID migrates legacy credentials and survives a fresh process", () => {
  const dir = mkdtempSync(join(tmpdir(), "nanollm-claude-device-"));
  const provider = "device-persistence-test";
  const configPath = join(dir, "config.yaml");
  const storage = join(dir, "claude-subscription");
  mkdirSync(storage);
  const path = join(storage, "11111111-1111-4111-8111-111111111111.json");
  const credential = { providerName: provider, accessToken: "test-access", refreshToken: "test-refresh", expiresAt: Date.now() + 3600000, accountUuid: "test-account" };
  writeFileSync(path, JSON.stringify(credential));
  try {
    configureClaudeSubscriptionStorage(configPath);
    const deviceId = getOrCreateClaudeSubscriptionDeviceId(provider);
    assert.match(deviceId, /^[a-f0-9]{64}$/);
    assert.equal(getOrCreateClaudeSubscriptionDeviceId(provider), deviceId);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { ...credential, deviceId });
    const moduleUrl = new URL("../src/subscriptions/claude-subscription.js", import.meta.url).href;
    const script = `import { configureClaudeSubscriptionStorage, getOrCreateClaudeSubscriptionDeviceId } from ${JSON.stringify(moduleUrl)};
      configureClaudeSubscriptionStorage(${JSON.stringify(configPath)});
      process.stdout.write(getOrCreateClaudeSubscriptionDeviceId(${JSON.stringify(provider)}));`;
    assert.equal(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }).trim(), deviceId);
    assert.equal(readdirSync(storage).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude startup backfills missing device IDs independently and preserves existing IDs", () => {
  const dir = mkdtempSync(join(tmpdir(), "nanollm-claude-startup-device-"));
  const storage = join(dir, "claude-subscription");
  mkdirSync(storage);
  const existingDeviceId = "031f29c6266b4724365990d8ce2455828eccb6b00b6de0431cdb7cb76ff8c45b";
  const providers = ["startup-device-a", "startup-device-b", "startup-device-existing"].map((name) => ({
    name, provider: "claude-subscription" as const, base_url: "", api_key: "",
  }));
  const paths = providers.map((provider, index) => {
    const path = join(storage, `${index + 2}0000000-1111-4111-8111-111111111111.json`);
    writeFileSync(path, JSON.stringify({
      providerName: provider.name, accessToken: "test-access", refreshToken: "test-refresh", expiresAt: Date.now() + 3600000,
      ...(index === 2 ? { deviceId: existingDeviceId } : {}),
    }));
    return path;
  });
  const existingFile = readFileSync(paths[2]!, "utf8");
  try {
    configureClaudeSubscriptionStorage(join(dir, "config.yaml"));
    bootstrapClaudeSubscriptionProviders(providers);
    const ids = paths.map((path) => JSON.parse(readFileSync(path, "utf8")).deviceId);
    assert.ok(ids.every((id) => /^[a-f0-9]{64}$/.test(id)));
    assert.notEqual(ids[0], ids[1]);
    assert.equal(ids[2], existingDeviceId);
    assert.equal(readFileSync(paths[2]!, "utf8"), existingFile);
    bootstrapClaudeSubscriptionProviders(providers);
    assert.deepEqual(paths.map((path) => JSON.parse(readFileSync(path, "utf8")).deviceId), ids);
    assert.equal(readdirSync(storage).length, 3);
  } finally {
    bootstrapClaudeSubscriptionProviders([]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OAuth transport fails on proxy rejection without bypassing it", async () => {
  const targets: string[] = [];
  const proxy = http.createServer();
  proxy.on("connect", (request, socket) => {
    targets.push(request.url!);
    socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    const address = proxy.address() as { port: number };
    await assert.rejects(oauthPost("https://auth.openai.com/oauth/token", "dummy", undefined, `http://127.0.0.1:${address.port}`));
    assert.deepEqual(targets, ["auth.openai.com:443"]);
  } finally {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});

test("device login pins provider proxy; refresh uses updated provider proxy", async (t) => {
  if (process.platform === "win32" || resolveOAuthTransportPath()) return t.skip("Requires an isolated mock helper");
  const previousCwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "nanollm-oauth-test-"));
  const helperDir = join(dir, "native/oauth-transport/target/release");
  mkdirSync(helperDir, { recursive: true });
  writeFileSync(join(helperDir, "nanollm-oauth-transport"), `#!/usr/bin/env node
const fs = require('node:fs');
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync('requests.jsonl', JSON.stringify(request) + '\\n');
const payload = request.url.endsWith('/usercode') ? {device_auth_id:'device',user_code:'CODE'}
  : request.url.endsWith('/deviceauth/token') ? {authorization_code:'code',code_verifier:'verifier'}
  : {access_token:'dummy',refresh_token:'refresh',account_id:'account',expires_in:3600};
console.log(JSON.stringify({status:200,body:JSON.stringify(payload)}));
`, { mode: 0o755 });
  process.chdir(dir);
  try {
    configureSubscriptionStorage(join(dir, "config.yaml"));
    const provider = { name: "proxy-test", provider: "openai-subscription" as const, base_url: "", api_key: "", proxy: "http://first.example:8080" };
    bootstrapSubscriptionProviders([provider]);
    const login = await startDeviceLogin(provider);
    provider.proxy = "http://second.example:8080";
    bootstrapSubscriptionProviders([provider]);
    assert.equal((await pollDeviceLogin(login.sessionId)).status, "authenticated");
    getCachedSubscriptionCredential(provider.name)!.expiresAt = 0;
    await ensureSubscriptionCredential(provider.name);
    const requests = readFileSync(join(dir, "requests.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(requests.map((request) => request.proxy), ["http://first.example:8080", "http://first.example:8080", "http://first.example:8080", "http://second.example:8080"]);
    assert.deepEqual(requests.map((request) => new URL(request.url).pathname), ["/api/accounts/deviceauth/usercode", "/api/accounts/deviceauth/token", "/oauth/token", "/oauth/token"]);
    assert.equal(new URLSearchParams(requests[3].body).get("grant_type"), "refresh_token");
  } finally {
    bootstrapSubscriptionProviders([]);
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claude login URL uses Claude Code OAuth parameters and manual callback", () => {
  const dir = mkdtempSync(join(tmpdir(), "nanollm-claude-url-"));
  try {
    configureClaudeSubscriptionStorage(join(dir, "config.yaml"));
    const login = startClaudeLogin({ name: "claude", provider: "claude-subscription", base_url: "", api_key: "" });
    const url = new URL(login.authorizeUrl);
    assert.equal(url.origin + url.pathname, "https://claude.com/cai/oauth/authorize");
    assert.equal(url.searchParams.get("client_id"), "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    assert.equal(url.searchParams.get("redirect_uri"), "https://platform.claude.com/oauth/code/callback");
    assert.equal(url.searchParams.get("code"), "true");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.ok(url.searchParams.get("scope")!.split(" ").includes("user:inference"));
    assert.ok(url.searchParams.get("state"));
    assert.equal(login.redirectUri, "https://platform.claude.com/oauth/code/callback");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claude callback parser accepts full URL and code#state text", () => {
  assert.deepEqual(parseClaudeCallback("https://platform.claude.com/oauth/code/callback?code=abc&state=xyz"), { code: "abc", state: "xyz" });
  assert.deepEqual(parseClaudeCallback("  abc#xyz \n"), { code: "abc", state: "xyz" });
  assert.deepEqual(parseClaudeCallback("https://platform.claude.com/oauth/code/callback?code=abc%23xyz"), { code: "abc", state: "xyz" });
  assert.throws(() => parseClaudeCallback("https://platform.claude.com/oauth/code/callback?error=access_denied"), /rejected/);
  assert.throws(() => parseClaudeCallback("https://platform.claude.com/oauth/code/callback?state=xyz"), /code/);
  assert.throws(() => parseClaudeCallback(""), /callback URL/);
});

test("claude login rejects a callback whose state does not match the session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nanollm-claude-state-"));
  try {
    configureClaudeSubscriptionStorage(join(dir, "config.yaml"));
    const login = startClaudeLogin({ name: "claude", provider: "claude-subscription", base_url: "", api_key: "" });
    await assert.rejects(completeClaudeLogin(login.sessionId, "https://platform.claude.com/oauth/code/callback?code=abc&state=other"), /state/);
    await assert.rejects(completeClaudeLogin("missing", "abc#xyz"), /过期/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claude subscription headers merge betas and default Claude Code identity", () => {
  const headers: Record<string, string> = { "anthropic-beta": "interleaved-thinking-2025-05-14", "User-Agent": "curl/8" };
  applyClaudeSubscriptionHeaders(headers);
  assert.equal(headers["anthropic-beta"], "interleaved-thinking-2025-05-14,claude-code-20250219,oauth-2025-04-20");
  assert.equal(headers["x-app"], "cli");
  assert.equal(headers["user-agent"], "claude-cli/2.1.289 (external, cli)", "a non-Claude User-Agent is replaced");
  assert.equal(headers["User-Agent"], undefined, "only the lowercase name is sent");

  const fromClaudeCode: Record<string, string> = { "anthropic-beta": "oauth-2025-04-20,claude-code-20250219", "x-app": "cli", "User-Agent": "claude-cli/9.9.9 (external, cli)" };
  applyClaudeSubscriptionHeaders(fromClaudeCode);
  assert.equal(fromClaudeCode["anthropic-beta"], "oauth-2025-04-20,claude-code-20250219");
  assert.deepEqual(Object.keys(fromClaudeCode).filter(name => name.toLowerCase() === "user-agent"), ["user-agent"]);
  assert.equal(fromClaudeCode["user-agent"], "claude-cli/9.9.9 (external, cli)");
});

test("claude subscription sends one lowercase user-agent when the client's arrives under both names", () => {
  // Mirrors getForwardHeaders: the forwarded client header is lowercase, the route adds the same value as User-Agent.
  const claudeCode = "claude-cli/2.1.289 (external, cli)";
  const headers = mergeHeaders({ "user-agent": claudeCode }, { "User-Agent": claudeCode });
  applyClaudeSubscriptionHeaders(headers);
  assert.deepEqual(Object.keys(headers).filter(name => name.toLowerCase() === "user-agent"), ["user-agent"]);
  assert.equal(new Headers(headers).get("user-agent"), claudeCode, "fetch sees one value, not a comma-joined pair");
});

test("claude subscription keeps only a Claude client's User-Agent and defaults a missing x-app to cli", () => {
  for (const userAgent of ["claude-cli/2.1.300 (external, sdk-ts)", "claude-code/2.1.300", "Claude-CLI/2.1.300"]) {
    const headers: Record<string, string> = { "user-agent": userAgent, "x-app": "sdk" };
    applyClaudeSubscriptionHeaders(headers);
    assert.equal(headers["user-agent"], userAgent);
    assert.equal(headers["x-app"], "sdk", "a client-supplied x-app is kept");
  }
  for (const userAgent of ["opencode/1.0", "Mozilla/5.0 claude-cli/2.1.300", "", "   "]) {
    const headers: Record<string, string> = { "user-agent": userAgent };
    applyClaudeSubscriptionHeaders(headers);
    assert.deepEqual(Object.keys(headers).filter(name => name.toLowerCase() === "user-agent"), ["user-agent"]);
    assert.equal(headers["user-agent"], "claude-cli/2.1.289 (external, cli)", JSON.stringify(userAgent));
    assert.equal(headers["x-app"], "cli");
  }
});

test("claude subscription headers pin the platform whichever OS the client reports", () => {
  const fromMac: Record<string, string> = { "X-Stainless-Lang": "python", "x-stainless-os": "MacOS", "x-stainless-arch": "arm64", "x-stainless-runtime-version": "v24.1.0" };
  applyClaudeSubscriptionHeaders(fromMac);
  assert.equal(fromMac["x-stainless-lang"], "js");
  assert.equal(fromMac["x-stainless-os"], "Windows");
  assert.equal(fromMac["x-stainless-arch"], "x64");
  assert.equal(fromMac["x-stainless-runtime-version"], "v24.1.0", "only the platform is pinned");
  assert.equal(Object.keys(fromMac).filter(name => name.toLowerCase() === "x-stainless-lang").length, 1);

  const defaults: Record<string, string> = {};
  applyClaudeSubscriptionHeaders(defaults);
  assert.equal(defaults["x-stainless-lang"], "js");
  assert.equal(defaults["x-stainless-os"], "Windows");
  assert.equal(defaults["x-stainless-arch"], "x64");
});

test("claude subscription uses one stable session ID in headers and metadata", () => {
  const clientHeaders = new Headers({ "x-forwarded-for": "203.0.113.4" });
  runWithRequestId("claude-session-default", () => {
    setClientRequestHeaders(clientHeaders);
    setClientIp("203.0.113.4");
    const first: Record<string, string> = {};
    applyClaudeSubscriptionHeaders(first);
    const body = { messages: [{ role: "user", content: "hello" }] };
    const options = { provider: "claude", deviceId: "a".repeat(64), clientHeaders, clientIp: "203.0.113.4" };
    const firstBody = applyClaudeSubscriptionSessionIdentity(body, first, options) as any;
    const second: Record<string, string> = {};
    applyClaudeSubscriptionHeaders(second);
    applyClaudeSubscriptionSessionIdentity({ messages: [...body.messages, { role: "assistant", content: "answer" }] }, second, options);
    assert.equal(first["x-claude-code-session-id"], second["x-claude-code-session-id"]);
    assert.match(first["x-claude-code-session-id"]!, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.equal(JSON.parse(firstBody.metadata.user_id).session_id, first["x-claude-code-session-id"]);

    const explicit: Record<string, string> = { "x-claude-code-session-id": "caller-session" };
    applyClaudeSubscriptionHeaders(explicit);
    const explicitBody = applyClaudeSubscriptionSessionIdentity(body, explicit, options) as any;
    assert.equal(explicit["x-claude-code-session-id"], "caller-session");
    assert.equal(JSON.parse(explicitBody.metadata.user_id).session_id, "caller-session");
    const other: Record<string, string> = {};
    applyClaudeSubscriptionSessionIdentity({ messages: [{ role: "user", content: "different chat" }] }, other, options);
    assert.notEqual(first["x-claude-code-session-id"], other["x-claude-code-session-id"]);
  });
});

test("claude-subscription provider expands to an anthropic model and rejects base_url", () => {
  const config = parseConfigText(`
providers:
  - name: claude
    provider: claude-subscription
    proxy: http://sub-proxy.example:7890
models:
  - name: sonnet
    custom_provider: claude
    model: claude-sonnet-4-5
`);
  const model = config.models[0];
  assert.equal(model.provider, "anthropic");
  assert.equal(model.claude_subscription_provider, "claude");
  assert.equal(model.subscription_provider, undefined);
  assert.equal(model.provider_proxy, "http://sub-proxy.example:7890");
  assert.equal(getUpstreamURL(model), "https://api.anthropic.com/v1/messages?beta=true");
  assert.throws(() => parseConfigText(`
providers:
  - name: claude
    provider: claude-subscription
    base_url: https://example.com
models: []
`), /cannot configure 'base_url' or 'api_key'/);
});

test("claude login exchanges code, stores credential and refreshes with rotated token", async (t) => {
  if (process.platform === "win32" || resolveOAuthTransportPath()) return t.skip("Requires an isolated mock helper");
  const previousCwd = process.cwd();
  const previousDispatcher = getGlobalDispatcher();
  const dir = mkdtempSync(join(tmpdir(), "nanollm-claude-oauth-test-"));
  const helperDir = join(dir, "native/oauth-transport/target/release");
  mkdirSync(helperDir, { recursive: true });
  writeFileSync(join(helperDir, "nanollm-oauth-transport"), `#!/usr/bin/env node
const fs = require('node:fs');
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync('requests.jsonl', JSON.stringify(request) + '\\n');
const body = JSON.parse(request.body);
const payload = body.grant_type === 'authorization_code'
  ? {access_token:'access-1',refresh_token:'refresh-1',expires_in:28800,scope:'user:profile user:inference',account:{uuid:'acct',email_address:'me@example.com'}}
  : {access_token:'access-2',refresh_token:'refresh-2',expires_in:28800,scope:'user:profile user:inference'};
console.log(JSON.stringify({status:200,body:JSON.stringify(payload)}));
`, { mode: 0o755 });
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  mockAgent.get("https://api.anthropic.com").intercept({ path: "/api/oauth/profile", method: "GET" })
    .reply(200, { account: { uuid: "acct", email: "me@example.com" }, organization: { uuid: "org", organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" } }).persist();
  setGlobalDispatcher(mockAgent);
  process.chdir(dir);
  try {
    configureClaudeSubscriptionStorage(join(dir, "config.yaml"));
    const provider = { name: "claude", provider: "claude-subscription" as const, base_url: "", api_key: "" };
    bootstrapClaudeSubscriptionProviders([provider]);
    const login = startClaudeLogin(provider);
    const state = new URL(login.authorizeUrl).searchParams.get("state")!;
    const result = await completeClaudeLogin(login.sessionId, `https://platform.claude.com/oauth/code/callback?code=the-code&state=${encodeURIComponent(state)}`);
    assert.equal(result.status, "authenticated");
    assert.equal(result.subscriptionType, "max");
    const stored = getCachedClaudeSubscriptionCredential("claude")!;
    assert.equal(stored.accessToken, "access-1");
    assert.equal(stored.email, "me@example.com");
    const files = readdirSync(join(dir, "claude-subscription")).filter((file) => file.endsWith(".json"));
    assert.equal(files.length, 1);
    assert.equal(JSON.parse(readFileSync(join(dir, "claude-subscription", files[0]), "utf8")).providerName, "claude");

    stored.expiresAt = 0;
    const [first, second] = await Promise.all([ensureClaudeSubscriptionCredential("claude"), ensureClaudeSubscriptionCredential("claude")]);
    assert.equal(first.accessToken, "access-2");
    assert.equal(second.refreshToken, "refresh-2");
    assert.equal(first.subscriptionType, "max");

    const requests = readFileSync(join(dir, "requests.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(requests.length, 2, "concurrent refreshes must share one token request");
    assert.equal(requests[0].url, "https://platform.claude.com/v1/oauth/token");
    assert.equal(requests[0].headers["content-type"], "application/json");
    const exchange = JSON.parse(requests[0].body);
    assert.equal(exchange.grant_type, "authorization_code");
    assert.equal(exchange.code, "the-code");
    assert.equal(exchange.state, state);
    assert.equal(exchange.redirect_uri, "https://platform.claude.com/oauth/code/callback");
    assert.ok(exchange.code_verifier);
    const refreshBody = JSON.parse(requests[1].body);
    assert.equal(refreshBody.grant_type, "refresh_token");
    assert.equal(refreshBody.refresh_token, "refresh-1");
  } finally {
    bootstrapClaudeSubscriptionProviders([]);
    setGlobalDispatcher(previousDispatcher);
    await mockAgent.close();
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OAuth helper lookup still resolves the package-root native-bin from the subscriptions module", () => {
  const helper = join(process.cwd(), "native-bin", `${process.platform}-${process.arch}`, process.platform === "win32" ? "nanollm-oauth-transport.exe" : "nanollm-oauth-transport");
  if (!existsSync(helper)) return;
  assert.equal(resolveOAuthTransportPath(), helper);
});
