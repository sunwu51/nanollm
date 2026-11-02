import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { isFallbackGroupDisabled, isModelDisabled, isPublicNameDisabled, parseConfigText, resolveModel } from "../src/core/config.js";
import { listAccessibleModels } from "../src/core/auth.js";
import { buildAdminConfigForm, buildAdminConfigFormFromEffectiveConfig, buildYamlTextFromAdminForm } from "../src/pages/admin-config-form.js";

const YAML = `
providers:
  - name: paused-provider
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: k
    disabled: true
  - name: live-provider
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: k
models:
  - name: a
    custom_provider: paused-provider
    model: up
  - name: b
    custom_provider: live-provider
    model: up
  - name: c
    provider: openai-chat
    base_url: https://example.com/v1
    api_key: k
    model: up
    disabled: true
fallback:
  mixed: [a, b, c]
  all-off: [a, c]
  paused:
    members: [b]
    disabled: true
  plain: [b]
`;

test("disabled flags parse on providers, models and fallback groups", () => {
  const config = parseConfigText(YAML);
  assert.equal(isModelDisabled(config, resolveModel(config, "a")!), true, "inherited from the provider");
  assert.equal(isModelDisabled(config, resolveModel(config, "b")!), false);
  assert.equal(isModelDisabled(config, resolveModel(config, "c")!), true);
  assert.equal(isFallbackGroupDisabled(config, "mixed"), false);
  assert.equal(isFallbackGroupDisabled(config, "all-off"), true, "every member is disabled");
  assert.equal(isFallbackGroupDisabled(config, "paused"), true);
  assert.equal(isFallbackGroupDisabled(config, "plain"), false);
  assert.deepEqual(config.fallback.paused, ["b"]);
  assert.equal(isPublicNameDisabled(config, "b"), false);
  assert.equal(isPublicNameDisabled(config, "unknown"), false);
});

test("disabled entries are hidden from model listings", () => {
  const config = parseConfigText(YAML);
  assert.deepEqual(listAccessibleModels(config, undefined).map((entry) => entry.name).sort(), ["b", "mixed", "plain"]);
});

test("invalid disabled values are rejected", () => {
  assert.throws(() => parseConfigText(YAML.replace("disabled: true\n  - name: live", "disabled: maybe\n  - name: live")), /disabled/);
});

test("the admin form round-trips disabled flags and writes the object form only for paused groups", () => {
  const form = buildAdminConfigForm(YAML);
  assert.equal(form.providers[0].disabled, true);
  assert.equal(form.models.find((m) => m.name === "c")!.disabled, true);
  assert.equal(form.models.find((m) => m.name === "c")!.extras?.disabled, undefined);
  assert.equal(form.fallbackGroups.find((g) => g.name === "paused")!.disabled, true);
  const yaml = buildYamlTextFromAdminForm(form);
  const reparsed = parseConfigText(yaml);
  assert.deepEqual(reparsed.disabled_fallback, ["paused"]);
  assert.equal(isModelDisabled(reparsed, resolveModel(reparsed, "c")!), true);
  assert.match(yaml, /plain:\n\s+- b/);

  const fromEffective = buildAdminConfigFormFromEffectiveConfig(parseConfigText(YAML));
  assert.equal(fromEffective.fallbackGroups.find((g) => g.name === "paused")!.disabled, true);
  form.providers[0].disabled = false;
  form.models.find((m) => m.name === "c")!.disabled = false;
  assert.doesNotMatch(buildYamlTextFromAdminForm(form).replace(/paused:[\s\S]*?disabled: true/, ""), /disabled/);
});

test("the gateway answers 503 for disabled targets, skips disabled members, and still allows admin model tests", { timeout: 60000 }, async (t) => {
  const hits: string[] = [];
  const upstream = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    hits.push(String(JSON.parse(body).model));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "c1", object: "chat.completion", model: "up", choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const upstreamBase = `http://127.0.0.1:${(upstream.address() as import("node:net").AddressInfo).port}/v1`;
  const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as import("node:net").AddressInfo).port; await new Promise((resolve) => probe.close(resolve));

  const dir = mkdtempSync(join(tmpdir(), "nanollm-disabled-e2e-"));
  const model = (name: string, up: string, extra: object = {}) => ({ name, provider: "openai-chat", base_url: upstreamBase, api_key: "k", model: up, ...extra });
  writeFileSync(join(dir, "config.yaml"), stringify({
    models: [model("on", "up-on"), model("off", "up-off", { disabled: true })],
    fallback: { mixed: ["off", "on"], "all-off": ["off"], paused: { members: ["on"], disabled: true } },
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
  const chat = (model: string) => fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });

  assert.equal((await chat("on")).status, 200, log);
  for (const name of ["off", "all-off", "paused"]) {
    const response = await chat(name);
    assert.equal(response.status, 503, name);
    assert.match(((await response.json()) as { error: string }).error, /disabled/);
  }
  hits.length = 0;
  assert.equal((await chat("mixed")).status, 200, log);
  assert.deepEqual(hits, ["up-on"], "the disabled member is skipped");

  const listed = (await fetch(base + "/v1/models").then((r) => r.json())) as { data: Array<{ id: string }> };
  assert.deepEqual(listed.data.map((entry) => entry.id).sort(), ["mixed", "on"]);
  const status = (await fetch(base + "/status/data").then((r) => r.json())) as { fallbackGroups: Array<{ name: string; members: string[] }> };
  assert.deepEqual(status.fallbackGroups.map((group) => group.name).sort(), ["mixed"], "paused groups are not shown in status");
  assert.deepEqual(status.fallbackGroups[0].members, ["on"], "paused members are not listed in status");
  const root = (await fetch(base + "/").then((r) => r.json())) as { models: Array<{ name: string; model?: unknown }> };
  assert.deepEqual(root.models.find((entry) => entry.name === "mixed")?.model, ["on"], "paused members are not listed in /");

  hits.length = 0;
  const tested = await fetch(base + "/admin/models/off/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "ping" }) });
  assert.equal(tested.status, 200, log);
  assert.deepEqual(hits, ["up-off"], "a disabled model can still be tested");
});
