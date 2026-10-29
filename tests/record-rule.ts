import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { parseConfigText } from "../src/core/config.js";
import { shouldSkipRecord } from "../src/core/record-rule.js";
import { buildAdminConfigForm, buildAdminConfigFormFromEffectiveConfig, buildYamlTextFromAdminForm } from "../src/pages/admin-config-form.js";
import { renderAdminConfigPage } from "../src/pages/admin-config-page.js";

const MODELS = `
models:
  - name: alpha
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: k
    model: upstream-alpha
`;

function request(body: unknown, headers: Record<string, string> = {}) {
  return { path: "/v1/chat/completions", headers: new Headers(headers), body };
}

/** Runs fn with console.error captured, so expected rule failures don't clutter the test output. */
function captureErrors(fn: () => void): string[] {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try { fn(); } finally { console.error = original; }
  return errors;
}

test("skip_when matches on the requested model, client headers and path", () => {
  const rule = "model === 'cheap' || headers['authorization']?.endsWith('-nolog') || path.startsWith('/v1/images/')";
  assert.equal(shouldSkipRecord(rule, request({ model: "cheap" })), true);
  assert.equal(shouldSkipRecord(rule, request({ model: "alpha" }, { Authorization: "Bearer sk-team-nolog" })), true);
  assert.equal(shouldSkipRecord(rule, request({ model: "alpha" }, { Authorization: "Bearer sk-team" })), false);
  assert.equal(shouldSkipRecord(rule, { path: "/v1/images/generations", headers: new Headers(), body: { model: "alpha" } }), true);
  assert.equal(shouldSkipRecord("body.metadata?.nolog", request({ model: "alpha", metadata: { nolog: 1 } })), true);
  assert.equal(shouldSkipRecord(undefined, request({ model: "cheap" })), false);
});

test("skip_when header names are case-insensitive whatever casing the client sent", () => {
  const sent = request({ model: "alpha" }, { Authorization: "Bearer sk-team-nolog", "X-Api-Key": "key-1" });
  assert.equal(shouldSkipRecord("headers['authorization'] === 'Bearer sk-team-nolog'", sent), true);
  assert.equal(shouldSkipRecord("headers.Authorization?.endsWith('-nolog')", sent), true);
  assert.equal(shouldSkipRecord("headers['AUTHORIZATION'] === headers.authorization", sent), true);
  assert.equal(shouldSkipRecord("'X-API-KEY' in headers && headers['x-api-key'] === 'key-1'", sent), true);
  assert.equal(shouldSkipRecord("Object.keys(headers).includes('authorization')", sent), true);
  assert.equal(shouldSkipRecord("'Cookie' in headers || headers.Cookie !== undefined", sent), false);
  assert.equal(shouldSkipRecord("(headers.Authorization = 'x', headers.authorization === 'x')", sent), false, "headers stay read-only");
});

test("admin page renders the Advanced section collapsed", () => {
  const html = renderAdminConfigPage({}, "en");
  assert.match(html, /<div class="field-grid" id="advanced-fields" hidden=""><\/div>/);
  assert.match(html, /<button id="advanced-toggle"[^>]*aria-expanded="false"[^>]*>Show advanced fields<\/button>/);
});

test("skip_when cannot change the request and records it when it fails", () => {
  const body = { model: "alpha" };
  assert.equal(shouldSkipRecord("body.model = 'other'", request(body)), true);
  assert.equal(body.model, "alpha", "an accidental assignment does not reach the routed body");

  const errors = captureErrors(() => {
    assert.equal(shouldSkipRecord("body.missing.field", request(body)), false);
    assert.equal(shouldSkipRecord("Promise.resolve(true)", request(body)), false);
    assert.equal(shouldSkipRecord("(() => { while (true) {} })()", request(body)), false);
  });
  assert.equal(errors.length, 3);
  assert.match(errors[0], /\[RECORD RULE\] record\.skip_when failed, recording the request: .*reading 'field'/);
  assert.match(errors[1], /must return synchronously/);
  assert.match(errors[2], /timed out/);
});

test("config parses record.skip_when and rejects a syntax error on load", () => {
  const config = parseConfigText(`${MODELS}
record:
  max_size: 20
  skip_when: "model === 'alpha'"
`);
  assert.equal(config.record.skip_when, "model === 'alpha'");
  assert.equal(parseConfigText(`${MODELS}\nrecord:\n  skip_when: "  "\n`).record.skip_when, undefined);
  assert.throws(() => parseConfigText(`${MODELS}\nrecord:\n  skip_when: "model ==="\n`), /'record\.skip_when' is not a valid expression/);
});

test("admin config form round-trips record.skip_when", () => {
  const form = buildAdminConfigForm(`${MODELS}\nrecord:\n  max_size: 20\n  keep: me\n  skip_when: "model === 'alpha'"\n`);
  assert.equal(form.record.skip_when, "model === 'alpha'");
  assert.deepEqual(form.recordExtras, { keep: "me" });

  form.record.skip_when = "model === 'alpha'\n  || headers['x-api-key'] === 'k'\n";
  const config = parseConfigText(buildYamlTextFromAdminForm(form));
  assert.equal(config.record.skip_when, "model === 'alpha'\n  || headers['x-api-key'] === 'k'");
  assert.equal(config.record.max_size, 20);
  assert.equal(buildAdminConfigFormFromEffectiveConfig(config).record.skip_when, config.record.skip_when);

  form.record = { max_size: "", skip_when: " " };
  form.recordExtras = {};
  assert.doesNotMatch(buildYamlTextFromAdminForm(form), /record:/);
});

test("the gateway keeps matching requests out of the records but still counts them in status", { timeout: 60000 }, async (t) => {
  const upstream = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "c1", object: "chat.completion", model: "up", choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const upstreamBase = `http://127.0.0.1:${(upstream.address() as import("node:net").AddressInfo).port}/v1`;
  const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as import("node:net").AddressInfo).port; await new Promise((resolve) => probe.close(resolve));

  const dir = mkdtempSync(join(tmpdir(), "nanollm-record-rule-e2e-"));
  writeFileSync(join(dir, "config.yaml"), stringify({
    models: [
      { name: "kept", provider: "openai-chat", base_url: upstreamBase, api_key: "k", model: "up" },
      { name: "quiet", provider: "openai-chat", base_url: upstreamBase, api_key: "k", model: "up" },
    ],
    fallback: { "quiet-group": ["kept"] },
    record: { skip_when: "model === 'quiet' || model === 'quiet-group' || headers['x-nolog'] === '1'" },
  }));
  const child = spawn(process.execPath, ["--import", "tsx", "server.ts", "--config", join(dir, "config.yaml"), "--storage", "memory"],
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

  const chat = async (model: string, headers: Record<string, string> = {}) => {
    const response = await fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model, messages: [{ role: "user", content: `hi ${model}` }] }),
    });
    assert.equal(response.status, 200, log);
    await response.text();
  };
  await chat("kept");
  await chat("quiet");
  await chat("quiet-group");
  await chat("kept", { "x-nolog": "1" });

  const summary = await fetch(base + "/record/summary").then((r) => r.json()) as { capturedCount: number; recentKeys: Array<{ requestId: string; model?: string }> };
  assert.equal(summary.capturedCount, 1, "skipped requests take no slot of record.max_size");
  assert.deepEqual(summary.recentKeys.map((entry) => entry.model), ["kept"]);
  const record = (await fetch(`${base}/record/${summary.recentKeys[0].requestId}`).then((r) => r.json()) as any).record;
  assert.match(JSON.stringify(record.clientRequest.body), /hi kept/);

  const status = await fetch(base + "/status/data").then((r) => r.json()) as { models: Array<{ name: string; series: Array<{ totalRequests: number; successRequests: number }> }> };
  const totals = Object.fromEntries(status.models.map((model) => [model.name, model.series.reduce((sum, cell) => sum + cell.totalRequests, 0)]));
  assert.deepEqual(totals, { kept: 3, quiet: 1 }, "status counts every request, recorded or not");
});
