import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";

interface UpstreamCall { path: string; model: string; closed: Promise<void> }

test("a client disconnect aborts the upstream call for streaming and non-streaming requests", { timeout: 90000 }, async t => {
  // The upstream model id picks the behaviour: "ok" answers, "hang-headers" never responds,
  // "hang-stream" sends one real SSE event and then stalls.
  const calls: UpstreamCall[] = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ path: req.url ?? "", model: body.model, closed: once(res, "close").then(() => {}) });
    if (body.model === "hang-headers") return;
    if (body.model === "hang-stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "hang-stream", choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] }) + "\n\n");
      return;
    }
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ id: "c2", object: "chat.completion.chunk", model: "ok", choices: [{ index: 0, delta: { role: "assistant", content: "done" } }] }) + "\n\n");
      res.write("data: " + JSON.stringify({ id: "c2", object: "chat.completion.chunk", model: "ok", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "\n\n");
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "c3", object: "chat.completion", model: "ok", choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening"); t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const upstreamBase = `http://127.0.0.1:${(upstream.address() as import("node:net").AddressInfo).port}/v1`;
  const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as import("node:net").AddressInfo).port; await new Promise(resolve => probe.close(resolve));

  const dir = mkdtempSync(join(tmpdir(), "nanollm-client-disconnect-"));
  writeFileSync(join(dir, "config.yaml"), stringify({
    // Far beyond the assertion window, so only the disconnect can close a hung upstream call.
    server: { ttfb_timeout: 600000 },
    models: [
      { name: "chat-ok", provider: "openai-chat", base_url: upstreamBase, api_key: "k", model: "ok" },
      { name: "chat-hang-headers", provider: "openai-chat", base_url: upstreamBase, api_key: "k", model: "hang-headers" },
      { name: "chat-hang-stream", provider: "openai-chat", base_url: upstreamBase, api_key: "k", model: "hang-stream" },
      { name: "image-hang", provider: "openai-image", base_url: upstreamBase, api_key: "k", model: "hang-headers" },
      { name: "search-hang", provider: "openai-responses", base_url: upstreamBase, api_key: "k", model: "hang-headers" },
    ],
    fallback: { "hang-group": ["chat-hang-headers", "chat-ok"] },
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

  const post = (path: string, body: unknown, signal?: AbortSignal) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  const nextCall = async (count: number) => {
    for (const deadline = Date.now() + 10000; calls.length <= count;) {
      if (Date.now() > deadline) assert.fail("upstream was not called:\n" + log);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return calls[count];
  };
  const assertClosed = async (call: UpstreamCall, label: string) => {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 3000); });
    const closed = await Promise.race([call.closed.then(() => true), timedOut]);
    clearTimeout(timer);
    assert.ok(closed, `${label}: upstream connection still open after the client disconnected\n${log}`);
  };
  /** Starts a request, waits until it reaches the upstream, optionally reads the first SSE chunk, then disconnects. */
  const disconnect = async (label: string, path: string, body: unknown, { readFirstChunk = false } = {}) => {
    const controller = new AbortController(), before = calls.length;
    const pending = post(path, body, controller.signal);
    pending.catch(() => {});
    const call = await nextCall(before);
    if (readFirstChunk) {
      const response = await pending;
      assert.equal(response.status, 200, label);
      const first = await response.body!.getReader().read();
      assert.ok(first.value && first.value.byteLength > 0, `${label}: received the first chunk`);
    }
    controller.abort();
    await assertClosed(call, label);
    return call;
  };
  const chat = (model: string, stream: boolean) => ({ model, stream, messages: [{ role: "user", content: "hi" }] });

  // Unaffected requests still complete.
  const plain = await post("/v1/chat/completions", chat("chat-ok", false));
  assert.equal(plain.status, 200); assert.equal((await plain.json() as any).choices[0].message.content, "done");
  const streamed = await post("/v1/chat/completions", chat("chat-ok", true));
  assert.equal(streamed.status, 200); assert.match(await streamed.text(), /"done"/);

  await disconnect("SSE mid-stream, same protocol", "/v1/chat/completions", chat("chat-hang-stream", true), { readFirstChunk: true });
  await disconnect("SSE mid-stream, converted protocol", "/v1/messages",
    { model: "chat-hang-stream", stream: true, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }, { readFirstChunk: true });
  await disconnect("SSE before the first byte", "/v1/chat/completions", chat("chat-hang-headers", true));
  await disconnect("non-stream, same protocol", "/v1/chat/completions", chat("chat-hang-headers", false));
  await disconnect("non-stream, converted protocol", "/v1/responses", { model: "chat-hang-headers", stream: false, input: "hi" });
  const image = await disconnect("image generation", "/v1/images/generations", { model: "image-hang", prompt: "a cat" });
  assert.equal(image.path, "/v1/images/generations");
  const search = await disconnect("alpha search", "/v1/alpha/search", { model: "search-hang", query: "cats" });
  assert.equal(search.path, "/v1/alpha/search");

  // A disconnect is not a model failure: the fallback group neither moves on nor demotes the member.
  for (let i = 0; i < 2; i += 1) {
    const before = calls.length;
    await disconnect("fallback group", "/v1/chat/completions", chat("hang-group", false));
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(calls.slice(before).map(call => call.model), ["hang-headers"], "no fallback candidate is tried for a gone client");
  }
  const status = await fetch(base + "/status/data").then(r => r.json()) as any;
  assert.deepEqual(status.fallbackGroups.find((entry: any) => entry.name === "hang-group").members, ["chat-hang-headers", "chat-ok"]);
  assert.match(log, /\[CLIENT CLOSED\] path=\/v1\/chat\/completions/);

  const after = await post("/v1/chat/completions", chat("chat-ok", false));
  assert.equal(after.status, 200, "the gateway keeps serving after disconnects");
});
