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
import { createClient } from "@libsql/client";
import { Hono } from "hono";
import { stringify } from "yaml";
import type { ModelConfig } from "../src/core/config.js";
import { JobConfigStore, nextJobDates, validateJob, type JobRun, type Job } from "../src/jobs/jobs.js";
import { MemoryJobRunStore, SqliteJobRunStore, type JobRunStore } from "../src/jobs/job-run-store.js";
import { JobScheduler } from "../src/jobs/job-scheduler.js";
import { JobExecutionError, modelRequestExecutor, type JobExecutor } from "../src/jobs/job-executor.js";
import { createJobRoutes } from "../src/jobs/job-routes.js";
import { renderJobsPage } from "../src/jobs/jobs-page.js";
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

test("real upstream streaming preserves chosen connection, uses native protocols, bounds output and aborts", { timeout: 15000 }, async t => {
  let mode = "chat"; const calls: any[] = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    calls.push({ path: req.url, body: JSON.parse(raw) }); res.writeHead(200, { "content-type": "text/event-stream" });
    if (mode === "anthropic") {
      res.end('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"<svg/>"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'); return;
    }
    const text = mode === "large" ? "x".repeat(2000) : "<svg>pelican</svg>";
    res.write("data: " + JSON.stringify({ choices: [{ delta: { content: text } }] }) + "\n\n");
    if (mode === "hang") return;
    if (mode === "length") res.write('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n');
    if (mode !== "incomplete") res.write("data: [DONE]\n\n"); res.end();
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening"); t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const port = (upstream.address() as import("node:net").AddressInfo).port;
  const config = { ...model, base_url: `http://127.0.0.1:${port}/v1`, ttfb_timeout: 2000 };
  const execute = () => modelRequestExecutor.execute(job(), config, new AbortController().signal);
  assert.equal((await execute()).output.text, "<svg>pelican</svg>"); assert.equal(calls[0].body.model, "real-model");
  mode = "incomplete"; await assert.rejects(execute(), /未正常结束/);
  mode = "length"; await assert.rejects(execute(), (e: JobExecutionError) => !!e.partial.output.truncated);
  mode = "large"; const limited = job(); limited.execution.max_output_bytes = 1024;
  await assert.rejects(modelRequestExecutor.execute(limited, config, new AbortController().signal), (e: JobExecutionError) => e.partial.output.text.length <= 1024 && e.partial.output.truncated);
  mode = "anthropic"; const converted = await modelRequestExecutor.execute(job(), { ...config, provider: "anthropic" }, new AbortController().signal);
  assert.equal(converted.output.text, "<svg/>"); assert.equal(calls.at(-1).path, "/v1/messages"); assert.equal(calls.at(-1).body.model, "real-model");
  mode = "hang"; const controller = new AbortController(), task = modelRequestExecutor.execute(job(), config, controller.signal);
  const timer = setTimeout(() => controller.abort(new Error("cancelled")), 100); try { await assert.rejects(task); } finally { clearTimeout(timer); }
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

test("run detail page only polls while its run is active and keeps scroll position", () => {
  const html=renderJobsPage();
  for (const part of ["runActive=['pending','running'].includes(run.status)", "route[0]==='runs'?(runActive?2000:0)", 'window.scrollTo(0,keepScroll)']) assert.ok(html.includes(part), part);
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
