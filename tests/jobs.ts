import { JobModelCatalog } from "../src/jobs/job-model-catalog.js";
import { buildModelTestRequest } from "../src/proxy/model-test.js";
import type { ServerConfig } from "../src/core/config.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import http from "node:http";
import { spawn } from "node:child_process";
import vm from "node:vm";
import { createClient } from "@libsql/client";
import { Hono } from "hono";
import { stringify } from "yaml";
import type { ModelConfig } from "../src/core/config.js";
import { JobConfigStore, nextJobDates, validateJob, type JobRun, type Job } from "../src/jobs/jobs.js";
import { MemoryJobRunStore, SqliteJobRunStore, type JobRunStore } from "../src/jobs/job-run-store.js";
import { JobScheduler } from "../src/jobs/job-scheduler.js";
import { createModelRequestExecutor, JobExecutionError, type JobExecutor } from "../src/jobs/job-executor.js";
import { createJobRoutes } from "../src/jobs/job-routes.js";
import { renderJobsPage } from "../src/jobs/jobs-page.js";
import { LOGO_DATA_URI, LOGO_SVG } from "../src/pages/logo.js";
import { SSEParser } from "../src/converters/streams.js";

const model: ModelConfig = { name: "chosen", provider: "openai-chat", base_url: "https://example.test/v1", api_key: "test-secret", model: "real-model" };
function job(id = "hourly"): Job {
  return validateJob({ id, name: "绘图巡检", enabled: true, type: "model_request", schedule: { cron: "0 * * * *", timezone: "Asia/Singapore" }, models: [model.name],
    request: { message: "Draw a pelican" } });
}
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "nanollm-jobs-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new JobConfigStore(join(dir, "jobs.yaml"));
}
const output = { output: { text: "<svg>pelican</svg>", media_type: "image/svg+xml", truncated: false }, metrics: { ttfb_ms: 50 } };
const success: JobExecutor = { type: "model_request", execute: async () => structuredClone(output) };
async function finished(scheduler: JobScheduler) { await scheduler.flush(); }
function runFixture(id: string, started: number, status: JobRun["status"] = "succeeded"): JobRun {
  return { id, job_id: "hourly", trigger: "manual", scheduled_at: null, started_at: started,
    finished_at: status === "running" ? null : started + 20, status, snapshot_version: 1, job_snapshot: job(),
    results: [{ model_name: model.name, provider: model.provider, upstream_model: model.model, connection_fingerprint: "fp", status: status === "running" ? "running" : "succeeded",
      started_at: started, finished_at: status === "running" ? null : started + 20, attempts: [], output: structuredClone(output.output), metrics: null, evaluation: null,
      review: { status: "unreviewed", note: "", reviewed_at: null }, error: null }], error: null, updated_at: started };
}

test("cron supports five fields and explicit timezones, including DST", () => {
  const now = Date.parse("2026-10-03T00:15:00Z");
  assert.equal(nextJobDates(job().schedule, now, 1)[0], Date.parse("2026-10-03T01:00:00Z"));
  assert.equal(nextJobDates({ cron: "0 9 * * *", timezone: "Asia/Shanghai" }, now, 1)[0], Date.parse("2026-10-03T01:00:00Z"));
  const dst = nextJobDates({ cron: "0 9 * * *", timezone: "America/New_York" }, Date.parse("2026-10-31T12:00:00Z"), 3);
  assert.deepEqual(dst, ["2026-10-31T13:00:00Z", "2026-11-01T14:00:00Z", "2026-11-02T14:00:00Z"].map(Date.parse));
  assert.ok(nextJobDates({ cron: "0 9 * * THU", timezone: "UTC" }, now, 1).length);
  assert.throws(() => nextJobDates({ cron: "* * * * * *", timezone: "UTC" }));
  assert.throws(() => nextJobDates({ cron: "0 * * * *", timezone: "invalid/timezone" }));
});

test("SSE completion survives chunk boundaries and an EOF without a blank line", () => {
  const parser = new SSEParser(true);
  assert.deepEqual(parser.push("data: [DO"), []);
  assert.deepEqual(parser.push("NE]\r\n\r\n"), [{ event: undefined, data: "[DONE]" }]);
  assert.deepEqual(parser.push('data: {"type":"message_stop"}'), []);
  assert.deepEqual(parser.flush(), [{ event: undefined, data: '{"type":"message_stop"}' }]);
  const defaultParser = new SSEParser(); assert.deepEqual(defaultParser.push("data: [DONE]\n\n"), []);
});

test("jobs.yaml saves configuration only, survives restart and rejects stale edits/invalid hot reloads", t => {
  const config = fixture(t), original = config.snapshot(); config.save(job(), original.version, true);
  const raw = readFileSync(config.path, "utf8"); assert.match(raw, /cron:/); assert.doesNotMatch(raw, /results|test-secret/);
  const restored = new JobConfigStore(config.path); assert.equal(restored.snapshot().jobs[0].id, "hourly");
  assert.throws(() => config.save(job(), original.version, false), /刷新/);
  writeFileSync(config.path, "version: 1\njobs: [broken\n"); assert.ok(config.snapshot().lastError); assert.equal(config.snapshot().jobs[0].id, "hourly");
  assert.throws(() => config.save(job(), config.snapshot().version, false), /修复/);
  writeFileSync(config.path, stringify({ version: 1, jobs: [{ ...job(), name: "改名" }] })); assert.equal(config.snapshot().jobs[0].name, "改名");
});

test("job validation disallows fallback-like wildcard/model/stream overrides and malformed bodies", () => {
  for (const body of [{ model: "other", messages: [] }, { stream: true, messages: [] }, {}]) assert.throws(() => validateJob({ ...job(), request: { format: "openai-chat", body } }));
  assert.throws(() => validateJob({ ...job(), models: ["wild-*"] }));
  assert.throws(() => validateJob({ ...job(), models: ["chosen", "chosen"] }));
  assert.throws(() => validateJob({ ...job(), retention: { max_runs: 0 } }));
});

for (const storage of ["memory", "sqlite"] as const) {
  test(`${storage}: retain completed runs per job, preserve active run and isolate reviews`, async () => {
    const client = storage === "sqlite" ? createClient({ url: "file::memory:", intMode: "number" }) : undefined;
    const store: JobRunStore = client ? new SqliteJobRunStore(client, "test") : new MemoryJobRunStore();
    try {
      await store.initialize();
      for (let i = 0; i < 27; i++) await store.save(runFixture("run-" + i, i), 24);
      await store.save(runFixture("active", 100, "running"), 24);
      assert.equal((await store.list("hourly")).length, 25); assert.equal(await store.get("run-0"), undefined);
      await assert.rejects(store.review("active", model.name, "suspect", ""), /等待/);
      await store.review("run-26", model.name, "suspect", "缺少自行车");
      assert.equal((await store.get("run-26"))!.results[0].review.note, "缺少自行车");
      const summaries = await store.list(); assert.equal(summaries[1].results[0].review.status, "suspect");
      assert.ok(!JSON.stringify(summaries).includes("<svg>"));
      if (client) {
        const other = new SqliteJobRunStore(client, "other"); await other.initialize(); assert.deepEqual(await other.list(), []);
        const restart = new SqliteJobRunStore(client, "test"); await restart.initialize();
        assert.equal((await restart.get("active"))!.status, "interrupted");
        assert.equal((await restart.get("active"))!.results[0].status, "interrupted");
        assert.equal((await restart.get("run-26"))!.results[0].review.status, "suspect");
        assert.equal((await restart.list()).length, 24);
      } else assert.deepEqual(await new MemoryJobRunStore().list(), []);
      await store.deleteJob("hourly"); assert.deepEqual(await store.list(), []);
    } finally { client?.close(); }
  });
}

test("scheduler waits for cron, snapshots config, skips overlaps and does not replay missed intervals", async t => {
  const config = fixture(t); config.save(job(), config.snapshot().version, true);
  let now = Date.parse("2026-10-03T00:15:00Z"), calls = 0, release!: () => void;
  const executor: JobExecutor = { type: "model_request", execute: async () => { calls++; await new Promise<void>(r => { release = r; }); return output; } };
  const scheduler = new JobScheduler(config, new MemoryJobRunStore(), () => [model], [executor], () => now);
  await scheduler.initialize(); await scheduler.tick(); assert.equal(calls, 0);
  now = Date.parse("2026-10-03T01:00:00Z"); await scheduler.tick();
  await new Promise(r => setImmediate(r)); assert.equal(calls, 1);
  await assert.rejects(scheduler.runNow("hourly"), /正在执行/);
  now += 3600000; await scheduler.tick(); assert.equal(calls, 1);
  release(); await finished(scheduler);
  const run = (await scheduler.runs.list())[0]; assert.equal(run.status, "succeeded"); assert.equal(run.scheduled_at, Date.parse("2026-10-03T01:00:00Z"));
  const changed = { ...job(), name: "后来改名" }; config.save(changed, config.snapshot().version, false);
  assert.equal((await scheduler.runs.get(run.id))!.job_snapshot.name, "绘图巡检");
  now += 10 * 3600000; await scheduler.tick(); await new Promise(r => setImmediate(r)); assert.equal(calls, 2);
  release(); await finished(scheduler);
  const restarted = new JobScheduler(config, scheduler.runs, () => [model], [success], () => now);
  await restarted.initialize(); await restarted.tick(); assert.equal((await restarted.runs.list()).length, 2);
});

test("memory history budget includes review notes and evicts old finished records first", async () => {
  const old = runFixture("old", 1), recent = runFixture("recent", 2);
  const budget = Buffer.byteLength(JSON.stringify(old)) + Buffer.byteLength(JSON.stringify(recent)) + 100;
  const store = new MemoryJobRunStore(budget);
  await store.save(old, 24); await store.save(recent, 24);
  assert.equal((await store.list()).length, 2);
  await store.review(recent.id, model.name, "suspect", "n".repeat(300));
  assert.equal(await store.get(old.id), undefined);
  assert.equal((await store.get(recent.id))!.results[0].review.note.length, 300);
});

test("scheduler retries failed calls, records per-model failures, allows disabled manual runs and cancels", async t => {
  const config = fixture(t), configured = job(); configured.enabled = false; configured.models = [model.name, "removed"]; configured.execution.max_attempts = 2;
  config.save(configured, config.snapshot().version, true); let calls = 0;
  const executor: JobExecutor = { type: "model_request", execute: async () => { if (++calls === 1) throw new Error("first attempt failed"); return output; } };
  const scheduler = new JobScheduler(config, new MemoryJobRunStore(), () => [model], [executor]); await scheduler.initialize();
  const run = await scheduler.runNow(configured.id); await finished(scheduler);
  const result = (await scheduler.runs.get(run.id))!; assert.equal(result.status, "partial_failed"); assert.equal(result.results[0].attempts.length, 2); assert.equal(result.results[1].status, "failed");
  assert.equal(result.results[0].review.status, "unreviewed");
  const hanging: JobExecutor = { type: "model_request", execute: async (_, __, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) };
  const next = new JobScheduler(config, scheduler.runs, () => [model], [hanging]); await next.initialize();
  const active = await next.runNow(configured.id); next.cancel(configured.id); await finished(next);
  assert.equal((await next.runs.get(active.id))!.status, "cancelled");
  assert.ok((await next.runs.get(active.id))!.results.every(r => !["running", "pending"].includes(r.status)));
});

test("scheduler timeout and shutdown finish records even if an executor never settles", { timeout: 10000 }, async t => {
  const config = fixture(t), configured = job(); configured.execution.timeout_ms = 1000; config.save(configured, config.snapshot().version, true);
  const hanging: JobExecutor = { type: "model_request", execute: async () => new Promise(() => {}) };
  const scheduler = new JobScheduler(config, new MemoryJobRunStore(), () => [model], [hanging]); await scheduler.initialize();
  const run = await scheduler.runNow(configured.id); await finished(scheduler);
  assert.equal((await scheduler.runs.get(run.id))!.results[0].status, "timed_out");
  const next = await scheduler.runNow(configured.id); scheduler.stop(); await finished(scheduler);
  assert.equal((await scheduler.runs.get(next.id))!.status, "cancelled");
  await assert.rejects(scheduler.runNow(configured.id), /停止/);
});

test("resource limits keep due jobs pending and serialize calls to the same model", async t => {
  const config = fixture(t); for (const id of ["a", "b", "c"]) config.save(job(id), config.snapshot().version, true);
  let now = Date.parse("2026-10-03T00:30:00Z"), calls = 0; const releases: Array<() => void> = [];
  const executor: JobExecutor = { type: "model_request", execute: async () => { calls++; await new Promise<void>(r => releases.push(r)); return output; } };
  const scheduler = new JobScheduler(config, new MemoryJobRunStore(), () => [model], [executor], () => now); await scheduler.initialize();
  now = Date.parse("2026-10-03T01:00:00Z"); await scheduler.tick(); await new Promise(r => setImmediate(r));
  assert.equal((await scheduler.data()).activeJobIds.length, 2); assert.equal(calls, 1);
  assert.equal((await scheduler.runs.list("c")).length, 0);
  releases.shift()!(); await new Promise(r => setImmediate(r)); assert.equal(calls, 2);
  releases.shift()!(); await scheduler.flush();
  await scheduler.tick(); await new Promise(r => setImmediate(r)); assert.equal(calls, 3);
  releases.shift()!(); await scheduler.flush();
  assert.equal((await scheduler.runs.list("c"))[0].scheduled_at, now);
});

test("API validates models and versions, launches asynchronously, reviews and deletes separately", async t => {
  const config = fixture(t), scheduler = new JobScheduler(config, new MemoryJobRunStore(), () => [model], [success]); await scheduler.initialize();
  const app = new Hono(); app.route("/api", createJobRoutes(scheduler, () => [model], "memory"));
  const request = (path: string, method: string, body: unknown) => app.request("http://localhost/api/" + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const version = config.snapshot().version;
  assert.equal((await request("jobs", "POST", { job: { ...job(), models: ["unknown"] }, baseVersion: version })).status, 400);
  assert.equal((await request("jobs", "POST", { job: job(), baseVersion: version })).status, 201);
  assert.equal((await request("jobs/hourly", "PUT", { job: job(), baseVersion: version })).status, 409);
  const started = await request("jobs/hourly/run", "POST", {}); assert.equal(started.status, 202); const run = await started.json(); await finished(scheduler);
  assert.equal((await request("runs/" + run.id + "/review", "POST", { modelName: model.name, status: "suspect", note: "需要检查" })).status, 200);
  const detail = await app.request("http://localhost/api/runs/" + run.id); assert.equal((await detail.json()).results[0].review.note, "需要检查");
  assert.equal((await request("jobs/hourly", "DELETE", { baseVersion: config.snapshot().version, deleteRecords: false })).status, 200);
  assert.equal((await scheduler.runs.list()).length, 1); assert.equal(config.snapshot().jobs.length, 0);
  const csrf = await app.request("http://localhost/api/jobs", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" }); assert.equal(csrf.status, 403);
  assert.equal((await request("jobs", "POST", null)).status, 400);
});

test("executor sends client-format requests, parses the stream, bounds output and cancels on abort", { timeout: 15000 }, async t => {
  let mode = "chat", closed = 0; const calls: any[] = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    calls.push({ path: req.url, body: JSON.parse(raw) }); res.on("close", () => { closed++; });
    if (mode === "error") { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "upstream exploded" } })); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (mode === "anthropic") {
      res.end('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"<svg/>"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'); return;
    }
    const text = mode === "large" ? "x".repeat(2000) : "<svg>pelican</svg>";
    res.write("data: " + JSON.stringify({ choices: [{ delta: { content: text } }] }) + "\n\n");
    if (mode === "hang") return;
    if (mode === "length") res.write('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n');
    if (mode === "chat") res.write('data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}\n\n');
    if (mode !== "incomplete") res.write("data: [DONE]\n\n"); res.end();
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening"); t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const port = (upstream.address() as import("node:net").AddressInfo).port;
  const sent: ModelConfig[] = [];
  const executor = createModelRequestExecutor(async (target, request) => {
    sent.push(target);
    return fetch(`http://127.0.0.1:${port}${request.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request.body) });
  });
  const execute = (j = job(), target: ModelConfig = model, signal = new AbortController().signal) => executor.execute(j, target, signal);
  const first = await execute();
  assert.equal(first.output.text, "<svg>pelican</svg>"); assert.equal(first.output.media_type, "image/svg+xml");
  assert.equal(first.metrics?.usage?.outputTokens, 7); assert.equal(typeof first.metrics?.ttfb_ms, "number");
  // The gateway resolves the model, so the request carries the configured name, not the upstream id.
  assert.equal(calls[0].path, "/v1/chat/completions"); assert.equal(calls[0].body.model, "chosen");
  assert.deepEqual(calls[0].body.stream_options, { include_usage: true }); assert.equal(sent[0], model);
  mode = "incomplete"; await assert.rejects(execute(), /未正常结束/);
  mode = "length"; await assert.rejects(execute(), (e: JobExecutionError) => !!e.partial.output.truncated);
  mode = "large"; const limited = job(); limited.execution.max_output_bytes = 1024;
  await assert.rejects(execute(limited), (e: JobExecutionError) => e.partial.output.text.length <= 1024 && e.partial.output.truncated);
  mode = "error"; await assert.rejects(execute(), (e: Error) => !(e instanceof JobExecutionError) && e.message === "HTTP 502: upstream exploded");
  mode = "anthropic"; const converted = await execute(job(), { ...model, provider: "anthropic" });
  assert.equal(converted.output.text, "<svg/>"); assert.equal(calls.at(-1).path, "/v1/messages"); assert.equal(calls.at(-1).body.model, "chosen");
  mode = "hang"; const controller = new AbortController(), closedBefore = closed, task = execute(job(), model, controller.signal);
  const timer = setTimeout(() => controller.abort(new Error("cancelled")), 100);
  try { await assert.rejects(task, (e: JobExecutionError) => e.message === "cancelled" && e.partial.output.text === "<svg>pelican</svg>"); } finally { clearTimeout(timer); }
  // Aborting cancels the response stream, which is what stops the gateway's upstream call.
  const deadline = Date.now() + 3000; while (closed === closedBefore && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(closed > closedBefore, "hanging stream was closed");
});

test("scheduler gives every attempt a request id and passes it to the executor", async t => {
  const store = fixture(t), runs = new MemoryJobRunStore(), seen: Array<string | undefined> = [];
  let calls = 0;
  const scheduler = new JobScheduler(store, runs, () => [model], [{ type: "model_request", execute: async (_job, _model, _signal, context) => {
    seen.push(context?.requestId); if (++calls === 1) throw new Error("first attempt fails"); return structuredClone(output);
  } }]);
  const value = job(); value.execution.max_attempts = 2; store.save(value, store.snapshot().version, true); await scheduler.initialize();
  const started = await scheduler.runNow(value.id); await finished(scheduler);
  const run = (await runs.get(started.id))!;
  const ids = run.results[0].attempts.map(a => a.request_id);
  assert.equal(ids.length, 2); assert.deepEqual(seen, ids); assert.ok(ids.every(id => typeof id === "string" && id.length > 0)); assert.notEqual(ids[0], ids[1]);
});

test("scheduled jobs go through the gateway's /v1 routes: recorded, counted once, with usage and speed", { timeout: 60000 }, async t => {
  const upstreamCalls: any[] = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    upstreamCalls.push({ path: req.url, body: JSON.parse(raw), auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"<svg>"}}]}\n\n');
    await new Promise(resolve => setTimeout(resolve, 80));
    res.write('data: {"choices":[{"delta":{"content":"pelican</svg>"},"finish_reason":"stop"}]}\n\n');
    // Like OpenAI, only report usage when the request asks for it.
    if (upstreamCalls.at(-1).body.stream_options?.include_usage) res.write('data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}\n\n');
    res.write("data: [DONE]\n\n"); res.end();
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening"); t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const upstreamPort = (upstream.address() as import("node:net").AddressInfo).port;
  const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as import("node:net").AddressInfo).port; await new Promise(resolve => probe.close(resolve));
  const dir = mkdtempSync(join(tmpdir(), "nanollm-job-e2e-"));
  writeFileSync(join(dir, "config.yaml"), stringify({ server: { auth: { token: "job-token" } },
    models: [{ name: "chosen", provider: "openai-chat", base_url: `http://127.0.0.1:${upstreamPort}/v1`, api_key: "upstream-key", model: "real-model" }] }));
  const child = spawn(process.execPath, ["--import", "tsx", "server.ts", "--config", join(dir, "config.yaml"), "--storage", "memory"],
    { cwd: process.cwd(), env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", d => { log += d; }); child.stderr.on("data", d => { log += d; });
  t.after(() => { child.kill(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`, headers = { authorization: "Bearer job-token", "content-type": "application/json" };
  const call = async (path: string, init?: RequestInit) => { const response = await fetch(base + path, { headers, ...init }); return { status: response.status, body: await response.json() as any }; };
  for (const deadline = Date.now() + 30000; ;) {
    if (child.exitCode !== null) assert.fail("server exited:\n" + log);
    if (await fetch(base + "/health").then(r => r.ok, () => false)) break;
    if (Date.now() > deadline) assert.fail("server did not start:\n" + log);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const { body: data } = await call("/jobs/api/data");
  assert.equal((await call("/jobs/api/jobs", { method: "POST", body: JSON.stringify({ job: job(), baseVersion: data.version }) })).status, 201);
  const started = await call("/jobs/api/jobs/hourly/run", { method: "POST", body: "{}" });
  assert.equal(started.status, 202);
  let run: JobRun;
  for (const deadline = Date.now() + 15000; ;) {
    run = (await call("/jobs/api/runs/" + started.body.id)).body;
    if (!["pending", "running"].includes(run.status)) break;
    if (Date.now() > deadline) assert.fail("job did not finish: " + JSON.stringify(run));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const result = run.results[0];
  assert.equal(run.status, "succeeded", JSON.stringify(run));
  assert.equal(result.output?.text, "<svg>pelican</svg>");
  assert.equal(result.metrics?.usage?.outputTokens, 7);
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].body.model, "real-model"); assert.equal(upstreamCalls[0].auth, "Bearer upstream-key");

  const requestId = result.attempts[0].request_id!;
  const record = await call("/record/" + encodeURIComponent(requestId));
  assert.equal(record.status, 200);
  assert.equal(record.body.record.requestId, requestId);
  assert.equal(record.body.record.clientRequest.path, "/v1/chat/completions");
  assert.equal(record.body.record.clientRequest.status, "success");
  assert.equal(record.body.record.clientRequest.headers["user-agent"], "nanollm-scheduled-job");
  assert.equal(record.body.record.attempts[0].modelName, "chosen");

  const status = await call("/status/data");
  const cells = status.body.models.find((m: any) => m.name === "chosen").series as Array<Record<string, number | null>>;
  const sum = (key: string) => cells.reduce((total, cell) => total + Number(cell[key] ?? 0), 0);
  assert.equal(sum("totalRequests"), 1, "the job request is counted once");
  assert.equal(sum("successRequests"), 1);
  assert.equal(sum("nonCacheInputTokens"), 11);
  assert.equal(sum("outputTokens"), 7);
  assert.ok(cells.some(cell => Number(cell.avgTokenSpeed) > 0), "average speed is recorded");
});

test("page script parses, renders four views and previews without same-origin access", () => {
  const script = renderJobsPage().match(/<script>([\s\S]*)<\/script>/)![1]; assert.doesNotThrow(() => new Function(script));
  assert.match(script, /setAttribute\('sandbox','allow-scripts'\)/); assert.doesNotMatch(script, /allow-same-origin/);
});


test("message-only request rejects empty messages and generation parameters", () => {
  for (const request of [{message:""}, {message:"   "}, {message:123}, {message:"ok",max_tokens:1}])
    assert.throws(() => validateJob({...job(),request}));
  for (const protocol of ["openai-chat","openai-responses","anthropic"] as const) {
    const body = buildModelTestRequest(protocol,"upstream","hello").body;
    assert.equal(body.model,"upstream"); assert.equal(body.stream,true);
    if(protocol === "openai-responses") assert.deepEqual(body.input,[{role:"user",content:[{type:"input_text",text:"hello"}]}]);
    else assert.deepEqual(body.messages,[{role:"user",content:"hello"}]);
  }
});
test("subscription catalog covers both providers, caches discovery and resolves without discovery", async () => {
  const config = {models:[model,{...model,name:"wild-*",model:"*",custom_provider:"oa",subscription_provider:"oa",provider:"openai-responses"}],
    providers:[{name:"oa",provider:"openai-subscription",base_url:"",api_key:"",proxy:"http://localhost:1234"},{name:"cl",provider:"claude-subscription",base_url:"",api_key:""}],
    ttfb_timeout:12345} as ServerConfig;
  let calls=0;
  const catalog = new JobModelCatalog(()=>config,async p=>{calls++;return p.name==="oa"?["gpt-test"]:["claude-test"];});
  const name="subscription:oa:gpt-test";
  assert.equal(catalog.resolve(name)?.subscription_provider,"oa");
  assert.equal(catalog.resolve(name)?.provider_proxy,"http://localhost:1234");
  assert.equal(catalog.resolve("wild-gpt-test")?.model,"gpt-test");
  const [a,b] = await Promise.all([catalog.list(),catalog.list()]);
  assert.equal(calls,2);assert.deepEqual(a,b);
  assert.ok(a.modelOptions.some(m=>m.name===name));
  assert.equal(catalog.resolve("subscription:cl:claude-test")?.provider,"anthropic");
  assert.equal(catalog.resolve("subscription:cl:claude-test")?.claude_subscription_provider,"cl");
  config.providers=[];assert.equal(catalog.resolve(name),undefined);
});
test("subscription discovery errors remain visible", async () => {
  const config={models:[],providers:[{name:"broken",provider:"openai-subscription",base_url:"",api_key:""}]} as unknown as ServerConfig;
  const catalog=new JobModelCatalog(()=>config,async()=>{throw new Error("login required");});
  assert.match((await catalog.list()).modelErrors[0],/broken: login required/);
});
test("jobs page uses aligned URL and only user message editor", () => {
  const html=renderJobsPage();assert.match(html,/\/jobs\/api\//);
  assert.doesNotMatch(html,/请求协议|请求体 JSON|request-format|JSON.parse\(body.value\)/);
});

test("logo is served as the page icon and matches assets/logo.svg", () => {
  assert.equal(LOGO_SVG, readFileSync(join(process.cwd(), "assets", "logo.svg"), "utf8").trim());
  assert.ok(renderJobsPage().includes(`href="${LOGO_DATA_URI}"`));
});

test("run detail page only polls while its run is active and keeps scroll position", () => {
  const html=renderJobsPage();
  for (const part of ["runActive=['pending','running'].includes(run.status)", "route[0]==='runs'?(runActive?2000:0)", 'window.scrollTo(0,keepScroll)']) assert.ok(html.includes(part), part);
});

class FakeJobsElement {
  children: FakeJobsElement[] = []; parent?: FakeJobsElement; className = ""; hidden = false; text = ""; attributes: Record<string, string> = {};
  [key: string]: unknown;
  constructor(readonly tagName: string) {}
  get textContent(): string { return this.text + this.children.map(c => c.textContent).join(""); }
  set textContent(value: string) { this.children = []; this.text = value; }
  get childNodes() { return this.children; }
  get isConnected() { return true; }
  get classList() { return { add: (name: string) => { this.className = (this.className + " " + name).trim(); } }; }
  append(...nodes: Array<FakeJobsElement | string>) { for (const n of nodes) { if (typeof n === "string") this.text += n; else { n.parent = this; this.children.push(n); } } }
  replaceChildren(...nodes: FakeJobsElement[]) { this.children = []; this.text = ""; this.append(...nodes); }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  all(): FakeJobsElement[] { return this.children.flatMap(c => [c, ...c.all()]); }
  /** Visible means neither this element nor an ancestor is hidden. */
  get visible(): boolean { return !this.hidden && (!this.parent || this.parent.visible); }
}

test("history rows expand to show each model result and expand-all pauses auto refresh", async () => {
  const script = renderJobsPage().match(/<script>([\s\S]*)<\/script>/)![1];
  const summary = (id: string, started: number) => ({ id, job_id: "hourly", job_name: "绘图巡检", trigger: "manual", status: "succeeded", started_at: started, finished_at: started + 1000,
    results: [{ model_name: "alpha", status: "succeeded" }, { model_name: "beta", status: "failed" }] });
  const detail = (id: string) => ({ ...summary(id, 0), job_snapshot: job(), results: [
    { model_name: "alpha", status: "succeeded", upstream_model: "real-alpha", output: { text: "<svg>" + id + "</svg>", media_type: "image/svg+xml", truncated: false } },
    { model_name: "beta", status: "failed", error: { message: "beta broke" }, output: { text: "plain " + id, media_type: "text/plain", truncated: false } }] });
  const data = { jobs: [], runs: [summary("r1", 2000), summary("r2", 1000)], activeJobIds: [], nextRuns: {}, version: 1, storageMode: "memory" };
  const calls: string[] = [], timers: Array<() => void> = [], elements = new Map<string, FakeJobsElement>();
  const settle = () => new Promise(resolve => setImmediate(resolve));
  vm.runInContext(script, vm.createContext({
    document: { getElementById: (id: string) => { if (!elements.has(id)) elements.set(id, new FakeJobsElement("div")); return elements.get(id); }, createElement: (tag: string) => new FakeJobsElement(tag) },
    location: { hash: "#/history", pathname: "/jobs" }, history: { replaceState() {} },
    window: { scrollY: 0, scrollTo() {}, addEventListener() {}, confirm: () => true },
    fetch: async (url: string) => { const path = url.replace("/jobs/api/", ""); calls.push(path);
      const body = path === "data" ? data : path.startsWith("model-options") ? { modelOptions: [], modelErrors: [] } : detail(decodeURIComponent(path.slice("runs/".length)));
      return { ok: true, json: async () => structuredClone(body) }; },
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimeout() {},
    Intl, crypto, console,
  }));
  await settle();
  const app = elements.get("app")!;
  const buttons = (label: string) => app.all().filter(n => n.tagName === "button" && n.textContent === label);
  const detailRows = () => app.all().filter(n => n.className === "run-detail");
  assert.equal(buttons("展开").length, 2);
  assert.equal(buttons("展开全部").length, 1);
  // 查看 is a link but must look like the 展开 button next to it.
  assert.deepEqual(app.all().filter(n => n.textContent === "查看").map(n => [n.tagName, n.className]), [["a", "button"], ["a", "button"]]);
  assert.ok(detailRows().every(row => !row.visible));
  const paused = app.all().find(n => n.textContent === "展开期间暂停自动刷新")!;
  assert.equal(paused.visible, false);

  (buttons("展开")[0].onclick as () => void)(); await settle();
  assert.deepEqual(calls.filter(c => c.startsWith("runs/")), ["runs/r1"]);
  const [first, second] = detailRows();
  assert.ok(first.visible); assert.ok(!second.visible); assert.ok(paused.visible);
  const frame = first.all().find(n => n.tagName === "iframe")!;
  assert.match(String(frame.srcdoc), /<svg>r1<\/svg>/);
  assert.match(first.textContent, /alpha[\s\S]*real-alpha[\s\S]*beta[\s\S]*beta broke[\s\S]*plain r1/);
  assert.equal(buttons("收起").length, 1);
  assert.equal(buttons("展开全部").length, 1);

  // A pending refresh only reschedules itself while rows are expanded.
  const dataCalls = calls.filter(c => c === "data").length, pending = timers.length;
  timers.at(-1)!(); await settle();
  assert.equal(calls.filter(c => c === "data").length, dataCalls);
  assert.equal(timers.length, pending + 1);

  (buttons("展开全部")[0].onclick as () => void)(); await settle();
  assert.deepEqual(calls.filter(c => c.startsWith("runs/")), ["runs/r1", "runs/r2"]);
  assert.ok(detailRows().every(row => row.visible));
  assert.match(second.textContent, /plain r2/);
  assert.equal(buttons("收起全部").length, 1);

  (buttons("收起全部")[0].onclick as () => void)(); await settle();
  assert.ok(detailRows().every(row => !row.visible)); assert.equal(paused.visible, false);
  assert.equal(buttons("展开").length, 2);
  // Finished runs are cached, so expanding again does not refetch.
  (buttons("展开")[0].onclick as () => void)(); await settle();
  assert.equal(calls.filter(c => c.startsWith("runs/")).length, 2);

  (buttons("收起")[0].onclick as () => void)();
  timers.at(-1)!(); await settle();
  assert.equal(calls.filter(c => c === "data").length, dataCalls + 1);
});

test("subscription targets save and execute with native credentials tags", async t => {
  const config={models:[],providers:[{name:"oa",provider:"openai-subscription",base_url:"",api_key:""},{name:"cl",provider:"claude-subscription",base_url:"",api_key:""}]} as unknown as ServerConfig;
  const catalog=new JobModelCatalog(()=>config,async()=>[]);
  const store=fixture(t),runs=new MemoryJobRunStore(),seen:ModelConfig[]=[];
  const scheduler=new JobScheduler(store,runs,()=>[],[{type:"model_request",execute:async(j,m)=>{seen.push(m);assert.equal(j.request.message,"Draw a pelican");return output;}}],Date.now,2,n=>catalog.resolve(n));
  await scheduler.initialize();const app=new Hono();app.route("/jobs/api",createJobRoutes(scheduler,()=>[],"memory",catalog));
  const value={...job(),models:["subscription:oa:gpt-test","subscription:cl:claude-test"]};
  const response=await app.request("/jobs/api/jobs",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({job:value,baseVersion:store.snapshot().version})});
  assert.equal(response.status,201);
  await scheduler.runNow(value.id);await finished(scheduler);
  assert.equal(seen[0].subscription_provider,"oa");assert.equal(seen[0].provider,"openai-responses");
  assert.equal(seen[1].claude_subscription_provider,"cl");assert.equal(seen[1].provider,"anthropic");
  assert.equal((await runs.list())[0].status,"succeeded");
});
test("legacy single-user templates migrate to message-only configuration", t => {
  const store=fixture(t);const value={...job(),request:{format:"openai-chat",body:{messages:[{role:"user",content:"legacy prompt"}],max_tokens:8192}}};
  writeFileSync(store.path,stringify({version:1,jobs:[value]}));
  assert.deepEqual(store.snapshot().jobs[0].request,{message:"legacy prompt"});
});
