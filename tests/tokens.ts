import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { getAccessibleModelNames, isScopedToken, listAccessibleModels, resolveInternalModelName, resolveModelAccess } from "../src/core/auth.js";
import { parseConfigText } from "../src/core/config.js";
import { ConfigManager } from "../src/core/config-manager.js";
import { migrateLegacyAuthTokens } from "../src/core/token-migration.js";
import { buildAdminConfigForm, buildYamlTextFromAdminForm } from "../src/pages/admin-config-form.js";
import { createTokenRoutes } from "../src/tokens/token-routes.js";
import { renderTokensPage } from "../src/tokens/tokens-page.js";
import { readTokenDrafts, writeTokenDrafts } from "../src/tokens/tokens.js";

const MODELS = `
models:
  - { name: m1, provider: openai-chat, base_url: https://example.com/v1, api_key: k, model: up1 }
  - { name: m2, provider: anthropic, base_url: https://example.com/v1, api_key: k, model: up2 }
  - { name: wild-*, provider: openai-chat, base_url: https://example.com/v1, api_key: k, model: "*" }
fallback:
  plain: [m1, m2]
`;

const TOKENS = `
tokens:
  - name: team
    value: team-token
    available_models:
      - plain
      - fast: m1
  - value: \${NANOLLM_TEST_TOKEN}
    available_models:
      - w-*: wild-*
      - m1: m1
  - value: m2-token
    available_models:
      - any-*: m2
`;

const ADMIN = "server:\n  auth:\n    token: admin-token\n";

test("config parses tokens and their available models", () => {
  process.env.NANOLLM_TEST_TOKEN = "env-token";
  const config = parseConfigText(ADMIN + MODELS + TOKENS);
  assert.deepEqual(config.tokens, [
    { name: "team", value: "team-token", models: [{ alias: "plain", target: "plain" }, { alias: "fast", target: "m1" }] },
    { value: "env-token", models: [{ alias: "w-*", target: "wild-*" }, { alias: "m1", target: "m1" }] },
    { value: "m2-token", models: [{ alias: "any-*", target: "m2" }] },
  ]);
  assert.deepEqual(parseConfigText(MODELS).tokens, []);
});

test("config rejects invalid tokens and the old auth_token fields", () => {
  const withTokens = (yaml: string) => () => parseConfigText(ADMIN + MODELS + "tokens:\n" + yaml);
  assert.throws(withTokens("  - value: t\n    available_models: [{ a: nope }]\n"), /maps 'a' to unknown model or group 'nope'/);
  assert.throws(withTokens("  - value: t\n    available_models: [m1, { m1: m2 }]\n"), /lists 'm1' more than once/);
  assert.throws(withTokens("  - value: t\n  - value: t\n"), /repeats the value of another token/);
  assert.throws(withTokens("  - value: admin-token\n"), /same value as 'server.auth.token'/);
  assert.throws(withTokens("  - name: x\n    available_models: [m1]\n"), /Token 'x' is missing 'value'/);
  assert.throws(withTokens("  - value: t\n    available_models: [{ w: wild-* }]\n"), /'w' must end with '\*'/);
  assert.throws(withTokens("  - value: t\n    available_models: [{ a*b: m1 }]\n"), /invalid wildcard/);
  assert.throws(() => parseConfigText(MODELS.replace("model: up1 }", "model: up1, auth_token: x }")), /'auth_token'; access tokens are now configured in the top-level 'tokens' list/);
  assert.throws(() => parseConfigText(MODELS.replace("plain: [m1, m2]", "plain: { models: [m1] }")), /must be a non-empty model array/);
});

test("a client token routes only its own names, mapped to their targets", () => {
  process.env.NANOLLM_TEST_TOKEN = "env-token";
  const config = parseConfigText(ADMIN + MODELS + TOKENS);
  const cases: Array<[string, string | undefined, string | undefined]> = [
    ["plain", "admin-token", "plain"], ["m1", "admin-token", "m1"], ["unknown", "admin-token", "unknown"],
    ["plain", "team-token", "plain"], ["fast", "team-token", "m1"], ["m1", "team-token", undefined], ["m2", "team-token", undefined],
    ["w-foo", "env-token", "wild-foo"], ["m1", "env-token", "m1"], ["wild-foo", "env-token", undefined],
    ["any-thing", "m2-token", "m2"], ["m2", "m2-token", undefined],
    ["m1", undefined, undefined], ["m1", "wrong", undefined],
  ];
  for (const [name, token, expected] of cases) assert.equal(resolveModelAccess(config, name, token), expected, `${name} with ${token}`);
  assert.deepEqual(listAccessibleModels(config, "team-token"), [{ name: "plain", target: "plain" }, { name: "fast", target: "m1" }]);
  assert.deepEqual(getAccessibleModelNames(config, "admin-token"), ["plain", "m1", "m2", "wild-*"]);
  assert.deepEqual(getAccessibleModelNames(config, undefined), []);
  assert.equal(isScopedToken(config, "team-token"), true);
  assert.equal(isScopedToken(config, "env-token"), true);
  assert.equal(isScopedToken(config, "admin-token"), false);
  assert.equal(isScopedToken(config, undefined), false);
  // In-process calls (jobs, replays) route public names as is and other names through the first token that maps them.
  assert.equal(resolveInternalModelName(config, "m2"), "m2");
  assert.equal(resolveInternalModelName(config, "fast"), "m1");
  assert.equal(resolveInternalModelName(config, "w-x"), "wild-x");
  assert.equal(resolveInternalModelName(config, "nope"), "nope");
});

test("without an admin token, names no token maps to stay open", () => {
  const config = parseConfigText(MODELS + "tokens:\n  - value: t\n    available_models: [{ fast: m1 }]\n");
  assert.equal(resolveModelAccess(config, "m2", undefined), "m2");
  assert.equal(resolveModelAccess(config, "plain", undefined), "plain");
  assert.equal(resolveModelAccess(config, "wild-x", undefined), "wild-x");
  assert.equal(resolveModelAccess(config, "m1", undefined), undefined);
  assert.equal(resolveModelAccess(config, "m1", "t"), undefined);
  assert.equal(resolveModelAccess(config, "fast", "t"), "m1");
  assert.equal(resolveModelAccess(config, "m2", "t"), "m2");
  assert.deepEqual(getAccessibleModelNames(config, undefined), ["plain", "m2", "wild-*"]);
  assert.deepEqual(getAccessibleModelNames(config, "t"), ["fast", "plain", "m2", "wild-*"]);
});

const LEGACY = `# gateway config
server:
  auth:
    token: admin-token
models:
  - name: m1 # first model
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: k
    model: up1
    auth_token: shared
  - name: m2
    provider: anthropic
    base_url: https://example.com/v1
    api_key: k
    model: up2
    auth_token: \${NANOLLM_TEST_TOKEN}
  - name: wild-*
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: k
    model: "*"
    auth_token: shared
fallback:
  plain: [m1, m2]
  team:
    models: [m1, m2]
    auth_token: shared
  other:
    models: [m2]
tokens:
  - name: existing
    value: \${NANOLLM_TEST_TOKEN}
    available_models:
      - m2: m1
`;

test("legacy model and group auth_token fields migrate into tokens", () => {
  process.env.NANOLLM_TEST_TOKEN = "env-token";
  const migrated = migrateLegacyAuthTokens(LEGACY);
  assert.ok(migrated);
  assert.match(migrated, /^# gateway config/);
  assert.match(migrated, /name: m1 # first model/);
  assert.doesNotMatch(migrated, /auth_token/);
  const document = parse(migrated);
  assert.deepEqual(document.fallback, { plain: ["m1", "m2"], team: ["m1", "m2"], other: ["m2"] });
  assert.deepEqual(document.tokens, [
    // The existing entry with the same value keeps its own mapping for m2.
    { name: "existing", value: "${NANOLLM_TEST_TOKEN}", available_models: [{ m2: "m1" }] },
    { value: "shared", available_models: [{ m1: "m1" }, { "wild-*": "wild-*" }, { team: "team" }] },
  ]);
  const config = parseConfigText(migrated);
  assert.equal(resolveModelAccess(config, "team", "shared"), "team");
  assert.equal(resolveModelAccess(config, "wild-x", "shared"), "wild-x");
  assert.equal(resolveModelAccess(config, "plain", "shared"), undefined);
  assert.equal(migrateLegacyAuthTokens(migrated), undefined);
  assert.equal(migrateLegacyAuthTokens(MODELS), undefined);
});

test("the config manager migrates config.yaml when it loads", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nanollm-token-migration-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, MODELS.replace("model: up1 }", "model: up1, auth_token: m1-token }"));
  const manager = new ConfigManager(path);
  t.after(() => { manager.dispose(); rmSync(dir, { recursive: true, force: true }); });
  assert.doesNotMatch(readFileSync(path, "utf-8"), /auth_token/);
  assert.equal(manager.getActiveSnapshot().rawText, readFileSync(path, "utf-8"));
  assert.deepEqual(manager.getActiveSnapshot().effectiveConfig.tokens, [{ value: "m1-token", models: [{ alias: "m1", target: "m1" }] }]);
});

test("the admin form keeps the tokens list and writes fallback groups as lists", () => {
  const form = buildAdminConfigForm(ADMIN + MODELS + TOKENS);
  assert.deepEqual(form.fallbackGroups, [{ name: "plain", members: ["m1", "m2"] }]);
  const yamlText = buildYamlTextFromAdminForm(form);
  assert.match(yamlText, /plain:\n    - m1\n    - m2/);
  assert.deepEqual(parse(yamlText).tokens, parse(TOKENS).tokens);
});

test("token drafts round-trip through config.yaml text and keep its comments", () => {
  const source = "# keep\n" + ADMIN + MODELS + TOKENS;
  assert.deepEqual(readTokenDrafts(source)[0], { name: "team", value: "team-token", models: [{ alias: "plain", target: "plain" }, { alias: "fast", target: "m1" }] });
  const written = writeTokenDrafts(source, [{ name: "", value: "new", models: [{ alias: "a", target: "m1" }] }]);
  assert.match(written, /^# keep/);
  assert.deepEqual(parse(written).tokens, [{ value: "new", available_models: [{ a: "m1" }] }]);
  assert.equal(parse(writeTokenDrafts(source, [])).tokens, undefined);
});

test("token routes save the list into config.yaml and apply it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nanollm-token-routes-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, "# keep\n" + ADMIN + MODELS);
  const manager = new ConfigManager(path);
  t.after(() => { manager.dispose(); rmSync(dir, { recursive: true, force: true }); });
  const routes = createTokenRoutes(manager, (text) => writeFileSync(path, text));
  const put = (body: unknown, headers: Record<string, string> = {}) => routes.request("http://localhost/tokens", {
    method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });

  const data = await (await routes.request("http://localhost/data")).json() as any;
  assert.deepEqual(data.tokens, []);
  assert.equal(data.hasAdminToken, true);
  assert.deepEqual(data.targets.map((target: any) => `${target.kind}:${target.name}`), ["group:plain", "model:m1", "model:m2", "model:wild-*"]);

  const tokens = [{ name: "team", value: "team-token", models: [{ alias: "fast", target: "m1" }] }];
  const saved = await put({ tokens, baseVersion: data.version });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json() as any).tokens, tokens);
  assert.match(readFileSync(path, "utf-8"), /^# keep/);
  assert.equal(resolveModelAccess(manager.getActiveSnapshot().effectiveConfig, "fast", "team-token"), "m1");

  const version = manager.getActiveSnapshot().version;
  const invalid = await put({ tokens: [{ name: "", value: "x", models: [{ alias: "a", target: "nope" }] }], baseVersion: version });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json() as any).error, /unknown model or group 'nope'/);
  assert.equal((await put({ tokens: "nope", baseVersion: version })).status, 400);
  assert.equal((await put({ tokens, baseVersion: version - 1 })).status, 409);
  assert.equal((await put({ tokens, baseVersion: version }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await routes.request("http://localhost/tokens", { method: "PUT", body: "{}" })).status, 415);
  assert.equal(manager.getActiveSnapshot().version, version);
});

test("the tokens page renders in both languages", () => {
  assert.match(renderTokensPage("en"), /<title>Tokens · nanollm<\/title>/);
  assert.match(renderTokensPage("zh"), /访问令牌/);
  assert.match(renderTokensPage("en"), /fetch\('\/tokens\/api\/'\+path/);
});

test("the gateway migrates config.yaml on startup and routes token names", { timeout: 60000 }, async (t) => {
  const upstreamModels: string[] = [];
  const upstream = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    upstreamModels.push(JSON.parse(body).model);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "c1", object: "chat.completion", model: "up", choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const upstreamBase = `http://127.0.0.1:${(upstream.address() as import("node:net").AddressInfo).port}/v1`;
  const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as import("node:net").AddressInfo).port; await new Promise((resolve) => probe.close(resolve));

  const dir = mkdtempSync(join(tmpdir(), "nanollm-tokens-e2e-"));
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, `server:
  auth:
    token: admin-token
models:
  - { name: m1, provider: openai-chat, base_url: ${upstreamBase}, api_key: k, model: up1, auth_token: legacy-token }
  - { name: m2, provider: openai-chat, base_url: ${upstreamBase}, api_key: k, model: up2 }
tokens:
  - value: alias-token
    available_models:
      - fast: m2
`);
  const child = spawn(process.execPath, ["--import", "tsx", "server.ts", "--config", configPath, "--storage", "memory"],
    { cwd: process.cwd(), env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => { log += d; }); child.stderr.on("data", (d) => { log += d; });
  t.after(() => { child.kill(); rmSync(dir, { recursive: true, force: true }); });

  const base = `http://127.0.0.1:${port}`;
  for (const deadline = Date.now() + 30000; ;) {
    if (child.exitCode !== null) assert.fail("server exited:\n" + log);
    if (await fetch(base + "/health").then((r) => r.ok, () => false)) break;
    if (Date.now() > deadline) assert.fail("server did not start:\n" + log);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.deepEqual(parse(readFileSync(configPath, "utf-8")).tokens, [
    { value: "alias-token", available_models: [{ fast: "m2" }] },
    { value: "legacy-token", available_models: [{ m1: "m1" }] },
  ]);

  const chat = (model: string, token: string) => fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal((await chat("fast", "alias-token")).status, 200, log);
  assert.equal((await chat("m1", "legacy-token")).status, 200, log);
  assert.equal((await chat("m2", "alias-token")).status, 403);
  assert.equal((await chat("m2", "legacy-token")).status, 403);
  assert.equal((await chat("fast", "admin-token")).status, 404);
  assert.deepEqual(upstreamModels, ["up2", "up1"]);

  // A replay runs in-process with the admin token, and still resolves the client's own name.
  const admin = { authorization: "Bearer admin-token" };
  const summary = await fetch(base + "/record/summary", { headers: admin }).then((r) => r.json()) as { recentKeys: Array<{ requestId: string; model?: string }> };
  const recorded = summary.recentKeys.find((entry) => entry.model === "fast");
  assert.ok(recorded, JSON.stringify(summary));
  const replay = await fetch(`${base}/record/${recorded.requestId}/replay`, { method: "POST", headers: admin });
  assert.equal(replay.status, 200, await replay.clone().text());
  assert.equal(upstreamModels.at(-1), "up2");

  const models = await fetch(base + "/v1/models", { headers: { "x-api-key": "alias-token" } }).then((r) => r.json()) as any;
  assert.deepEqual(models.data, [{ id: "fast", object: "model", owned_by: "openai-chat" }]);
  // A client token reaches model routes only; the page sends it to the login form.
  assert.equal((await fetch(base + "/tokens", { headers: { authorization: "Bearer alias-token" }, redirect: "manual" })).status, 302);
  assert.equal((await fetch(base + "/tokens", { headers: { authorization: "Bearer admin-token" } })).status, 200);
});
