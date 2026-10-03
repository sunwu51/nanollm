import { Hono } from "hono";
import type { ModelConfig } from "../core/config.js";
import { JobConflictError, JobValidationError, jobError, nextJobDates, validateJob, validateJobModels } from "./jobs.js";
import type { JobScheduler } from "./job-scheduler.js";

export function createJobRoutes(scheduler: JobScheduler, getModels: () => ModelConfig[], storageMode: string, catalog?: { list(refresh?: boolean): Promise<unknown>; resolve(name: string): ModelConfig | undefined }) {
  const routes = new Hono();
  routes.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.req.method !== "GET") {
      const origin = c.req.header("origin");
      if (origin) {
        try { if (new URL(origin).host !== new URL(c.req.url).host) return c.json({ error: "Cross-origin mutations are not allowed" }, 403); }
        catch { return c.json({ error: "Invalid Origin" }, 403); }
      }
      if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) return c.json({ error: "请求应使用 application/json" }, 415);
      const body = await c.req.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new JobValidationError("请求体应为 JSON 对象");
    }
    await next();
  });
  routes.onError((error, c) => c.json({ error: jobError(error).message }, error instanceof JobConflictError ? 409 : error instanceof JobValidationError || error instanceof SyntaxError ? 400 : 500));
  const validateModels = (job: Parameters<typeof validateJobModels>[0]) => { if (!catalog) return validateJobModels(job, getModels()); for (const name of job.models) if (!catalog.resolve(name)) throw new JobValidationError("models: 目标模型不存在"); };
  routes.get("/model-options", async c => c.json(catalog ? await catalog.list(c.req.query("refresh") === "1") : { modelOptions: getModels().filter(m => m.provider !== "openai-image" && !m.name.includes("*")).map(m => ({ name: m.name, label: m.name, group: m.provider })), modelErrors: [] }));
  routes.get("/data", async c => c.json({ ...await scheduler.data(), storageMode }));
  routes.post("/schedule-preview", async c => {
    const body = await c.req.json(); return c.json({ dates: nextJobDates({ cron: body.cron, timezone: body.timezone }) });
  });
  routes.post("/jobs", async c => {
    const body = await c.req.json(), job = validateJob(body.job); validateModels(job);
    scheduler.config.save(job, body.baseVersion, true); scheduler.sync(); return c.json({ job }, 201);
  });
  routes.put("/jobs/:id", async c => {
    const body = await c.req.json(), job = validateJob(body.job);
    if (job.id !== c.req.param("id")) throw new JobValidationError("任务 ID 不能修改");
    validateModels(job); scheduler.config.save(job, body.baseVersion, false);
    await scheduler.runs.prune(job.id, job.retention.max_runs); scheduler.sync(); return c.json({ job });
  });
  routes.post("/jobs/:id/enabled", async c => {
    const body = await c.req.json(), job = scheduler.config.get(c.req.param("id"));
    if (!job) return c.json({ error: "任务不存在" }, 404);
    if (typeof body.enabled !== "boolean") throw new JobValidationError("enabled 应为布尔值");
    if (body.enabled) validateModels(job);
    job.enabled = body.enabled; scheduler.config.save(job, body.baseVersion, false); scheduler.sync(); return c.json({ job });
  });
  routes.delete("/jobs/:id", async c => {
    const body = await c.req.json(), id = c.req.param("id");
    if (scheduler.isRunning(id)) throw new JobConflictError("请先取消当前执行并等待结束，再删除任务");
    if (body.deleteRecords !== undefined && typeof body.deleteRecords !== "boolean") throw new JobValidationError("deleteRecords 应为布尔值");
    scheduler.config.delete(id, body.baseVersion); scheduler.sync();
    if (body.deleteRecords) await scheduler.runs.deleteJob(id); return c.json({ ok: true });
  });
  routes.post("/jobs/:id/run", async c => c.json(await scheduler.runNow(c.req.param("id")), 202));
  routes.post("/jobs/:id/cancel", c => { scheduler.cancel(c.req.param("id")); return c.json({ ok: true }); });
  routes.get("/runs/:id", async c => {
    const run = await scheduler.runs.get(c.req.param("id")); return run ? c.json(run) : c.json({ error: "执行记录不存在或已被清理" }, 404);
  });
  routes.post("/runs/:id/review", async c => {
    const body = await c.req.json(); if (typeof body.modelName !== "string") throw new JobValidationError("modelName 应为字符串");
    await scheduler.runs.review(c.req.param("id"), body.modelName, body.status, body.note); return c.json({ ok: true });
  });
  return routes;
}
