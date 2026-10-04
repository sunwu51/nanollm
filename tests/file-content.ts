import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";

const PDF_DOCUMENT = { type: "document", title: "report.pdf", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK" } };

test("file content passes through to a same-protocol model and is rejected with 400 across protocols", { timeout: 60000 }, async t => {
  const upstreamCalls: Array<{ path: string; body: any }> = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    upstreamCalls.push({ path: req.url ?? "", body: JSON.parse(raw) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_file", type: "message", role: "assistant", model: "claude-upstream",
      content: [{ type: "text", text: "read it" }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 2 },
    }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening"); t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const upstreamBase = `http://127.0.0.1:${(upstream.address() as import("node:net").AddressInfo).port}/v1`;
  const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as import("node:net").AddressInfo).port; await new Promise(resolve => probe.close(resolve));

  const dir = mkdtempSync(join(tmpdir(), "nanollm-file-content-"));
  writeFileSync(join(dir, "config.yaml"), stringify({
    models: [
      { name: "chat-model", provider: "openai-chat", base_url: upstreamBase, api_key: "k", model: "gpt-upstream" },
      { name: "claude-model", provider: "anthropic", base_url: upstreamBase, api_key: "k", model: "claude-upstream" },
    ],
    fallback: { "docs-group": ["chat-model", "claude-model"] },
  }));
  const child = spawn(process.execPath, ["--import", "tsx", "server.ts", "--config", join(dir, "config.yaml"), "--storage", "memory"],
    { cwd: process.cwd(), env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", d => { log += d; }); child.stderr.on("data", d => { log += d; });
  t.after(() => { child.kill(); rmSync(dir, { recursive: true, force: true }); });

  const base = `http://127.0.0.1:${port}`;
  for (const deadline = Date.now() + 30000; ;) {
    if (child.exitCode !== null) assert.fail("server exited:\n" + log);
    if (await fetch(base + "/health").then(r => r.ok, () => false)) break;
    if (Date.now() > deadline) assert.fail("server did not start:\n" + log);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const send = async (model: string) => {
    const response = await fetch(base + "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 100, messages: [{ role: "user", content: [{ type: "text", text: "summarize" }, PDF_DOCUMENT] }] }),
    });
    return { status: response.status, body: await response.json() as any };
  };

  const rejected = await send("chat-model");
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /Anthropic "document" content.*not converted between protocols/);
  assert.equal(upstreamCalls.length, 0, "a rejected conversion never reaches the upstream");

  const grouped = await send("docs-group");
  assert.equal(grouped.status, 200, JSON.stringify(grouped.body));
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].path, "/v1/messages");
  assert.deepEqual(upstreamCalls[0].body.messages[0].content[1], PDF_DOCUMENT, "same-protocol passthrough forwards the document unchanged");

  // A real failure counted twice or more would move chat-model behind claude-model; rejected content must not.
  for (let i = 0; i < 2; i += 1) assert.equal((await send("docs-group")).status, 200);
  const status = await fetch(base + "/status/data").then(r => r.json()) as any;
  const group = status.fallbackGroups.find((entry: any) => entry.name === "docs-group");
  assert.deepEqual(group.members, ["chat-model", "claude-model"], "rejected content does not demote the member");
});
