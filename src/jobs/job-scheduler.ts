import { randomUUID } from "node:crypto";
import type { ModelConfig } from "../core/config.js";
import { clone, connectionFingerprint, JobConfigStore, JobConflictError, jobError, nextJobDates, type Job, type JobRun, type JobResult } from "./jobs.js";
import type { JobRunStore } from "./job-run-store.js";
import { JobExecutionError, type ExecutionOutput, type JobExecutor } from "./job-executor.js";

interface ActiveRun { controller: AbortController; work?: Promise<void>; run: JobRun }
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class JobScheduler {
  private executors = new Map<string, JobExecutor>();
  private active = new Map<string, ActiveRun>();
  private next = new Map<string, { signature: string; at: number }>();
  private modelLocks = new Map<string, Promise<void>>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private ticking = false;
  lastError?: string;
  constructor(readonly config: JobConfigStore, readonly runs: JobRunStore,
    private getModels: () => ModelConfig[], executors: JobExecutor[], private now = Date.now,
    private maxConcurrentRuns = 2, private resolveTarget?: (name: string) => ModelConfig | undefined) {
    for (const executor of executors) this.executors.set(executor.type, executor);
  }
  async initialize() {
    await this.runs.initialize();
    for (const job of this.config.snapshot().jobs) await this.runs.prune(job.id, job.retention.max_runs);
    this.sync();
  }
  sync() {
    const snapshot = this.config.snapshot();
    if (snapshot.lastError) return snapshot;
    const ids = new Set(snapshot.jobs.map(j => j.id));
    for (const id of this.next.keys()) if (!ids.has(id)) this.next.delete(id);
    for (const job of snapshot.jobs) {
      if (!job.enabled) { this.next.delete(job.id); continue; }
      const signature = JSON.stringify(job.schedule);
      if (this.next.get(job.id)?.signature !== signature) this.next.set(job.id, { signature, at: nextJobDates(job.schedule, this.now(), 1)[0] });
    }
    return snapshot;
  }
  async data() {
    const snapshot = this.sync();
    return { ...snapshot, storageError: this.lastError, activeJobIds: [...this.active.keys()],
      nextRuns: Object.fromEntries([...this.next].map(([id, value]) => [id, snapshot.lastError ? null : value.at])),
      models: this.getModels().filter(m => m.provider !== "openai-image" && !m.name.includes("*")).map(m => m.name),
      runs: await this.runs.list() };
  }
  async tick() {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      const snapshot = this.sync(); if (snapshot.lastError) return;
      for (const job of snapshot.jobs) {
        const schedule = this.next.get(job.id);
        if (!schedule || schedule.at > this.now()) continue;
        if (this.active.has(job.id)) {
          schedule.at = nextJobDates(job.schedule, this.now(), 1)[0]; continue;
        }
        // Keep an overdue trigger pending until resources are available. No backlog is replayed.
        if (this.active.size >= this.maxConcurrentRuns) continue;
        const scheduledAt = schedule.at;
        schedule.at = nextJobDates(job.schedule, this.now(), 1)[0];
        try { await this.launch(job, "scheduled", scheduledAt); }
        catch (error) { this.lastError = jobError(error).message; }
      }
    } finally { this.ticking = false; }
  }
  async runNow(id: string): Promise<JobRun> {
    const snapshot = this.sync();
    if (snapshot.lastError) throw new JobConflictError("请先修复 jobs.yaml");
    const job = snapshot.jobs.find(j => j.id === id); if (!job) throw new JobConflictError("任务不存在");
    return this.launch(job, "manual", null);
  }
  isRunning(id: string) { return this.active.has(id); }
  cancel(id: string) {
    const active = this.active.get(id); if (!active) throw new JobConflictError("任务没有正在执行的运行");
    active.controller.abort(new Error("管理员取消执行"));
  }
  private async launch(job: Job, trigger: JobRun["trigger"], scheduledAt: number | null): Promise<JobRun> {
    if (this.stopped) throw new JobConflictError("调度器已停止");
    if (this.active.has(job.id)) throw new JobConflictError("该任务正在执行，不能重复运行");
    if (this.active.size >= this.maxConcurrentRuns) throw new JobConflictError("执行资源繁忙，请稍后重试");
    const models = clone(this.resolveTarget ? job.models.map(name => this.resolveTarget!(name)).filter((m): m is ModelConfig => !!m) : this.getModels());
    const now = this.now();
    const run: JobRun = { id: randomUUID(), job_id: job.id, trigger, scheduled_at: scheduledAt,
      started_at: now, finished_at: null, status: "running", snapshot_version: 1, job_snapshot: clone(job),
      results: job.models.map(name => {
        const model = models.find(m => m.name === name && m.provider !== "openai-image");
        return { model_name: name, provider: model?.provider ?? null, upstream_model: model?.model ?? null,
          connection_fingerprint: model ? connectionFingerprint(model) : null, status: "pending", started_at: null, finished_at: null,
          attempts: [], output: null, metrics: null, evaluation: null,
          review: { status: "unreviewed", note: "", reviewed_at: null }, error: null };
      }), error: null, updated_at: now };
    const active: ActiveRun = { controller: new AbortController(), run }; this.active.set(job.id, active);
    // Reserve the lock before the initial async write, so parallel HTTP calls cannot duplicate it.
    const ready = this.runs.save(run, job.retention.max_runs);
    active.work = ready.then(() => this.executeRun(active, models)).catch(error => { this.lastError = jobError(error).message; }).finally(() => this.active.delete(job.id));
    await ready;
    return clone(run);
  }
  private async save(run: JobRun) {
    run.updated_at = this.now();
    const retention = this.config.get(run.job_id)?.retention.max_runs ?? run.job_snapshot.retention.max_runs;
    await this.runs.save(run, retention);
  }
  private async withModelLock<T>(name: string, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    const previous = this.modelLocks.get(name) ?? Promise.resolve();
    let release!: () => void; const done = new Promise<void>(resolve => { release = resolve; });
    const chain = previous.then(() => done); this.modelLocks.set(name, chain);
    try { await abortable(previous, signal); signal.throwIfAborted(); return await task(); }
    finally { release(); if (this.modelLocks.get(name) === chain) void chain.then(() => { if (this.modelLocks.get(name) === chain) this.modelLocks.delete(name); }); }
  }
  private async executeResult(run: JobRun, result: JobResult, model: ModelConfig, parent: AbortSignal) {
    await this.withModelLock(model.name, parent, async () => {
      result.status = "running"; result.started_at = this.now(); await this.save(run);
      const executor = this.executors.get(run.job_snapshot.type); if (!executor) throw new Error("任务执行器不存在");
      for (let index = 1; index <= run.job_snapshot.execution.max_attempts; index++) {
        parent.throwIfAborted();
        const attempt: JobResult["attempts"][number] = { attempt: index, status: "running", started_at: this.now(), finished_at: null, error: null };
        result.attempts.push(attempt); await this.save(run);
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(new Error("模型调用超过任务超时限制")), run.job_snapshot.execution.timeout_ms);
        const signal = AbortSignal.any([parent, timeout.signal]);
        try {
          const output: ExecutionOutput = await abortable(executor.execute(run.job_snapshot, model, signal), signal);
          signal.throwIfAborted();
          result.output = output.output; result.metrics = output.metrics; result.status = attempt.status = "succeeded"; result.error = null;
        } catch (error) {
          result.status = attempt.status = parent.aborted ? "cancelled" : timeout.signal.aborted ? "timed_out" : "failed";
          result.error = attempt.error = jobError(error);
          if (error instanceof JobExecutionError) { result.output = error.partial.output; result.metrics = error.partial.metrics; }
        } finally { clearTimeout(timer); attempt.finished_at = this.now(); }
        await this.save(run);
        if (result.status === "succeeded" || parent.aborted || result.output?.truncated) break;
      }
      result.finished_at = this.now();
    });
  }
  private async executeRun(active: ActiveRun, models: ModelConfig[]) {
    const { run, controller } = active;
    try {
      for (const result of run.results) {
        if (controller.signal.aborted) break;
        const model = models.find(m => m.name === result.model_name && m.provider !== "openai-image" && !m.name.includes("*"));
        if (!model) { result.status = "failed"; result.finished_at = this.now(); result.error = { message: "目标模型已移除或不支持任务测试" }; }
        else {
          try { await this.executeResult(run, result, model, controller.signal); }
          catch (error) { if (!controller.signal.aborted) throw error; }
        }
        await this.save(run);
      }
      const successes = run.results.filter(r => r.status === "succeeded").length;
      run.status = controller.signal.aborted ? "cancelled" : successes === run.results.length ? "succeeded" : successes ? "partial_failed" : "failed";
    } catch (error) { run.status = "failed"; run.error = jobError(error); }
    finally {
      run.finished_at = this.now();
      for (const result of run.results) if (["pending", "running"].includes(result.status)) {
        result.status = controller.signal.aborted ? "cancelled" : "failed"; result.finished_at = run.finished_at;
        result.error = jobError(controller.signal.aborted ? controller.signal.reason : run.error?.message ?? "任务执行中断");
        for (const attempt of result.attempts) if (attempt.status === "running") {
          attempt.status = result.status; attempt.finished_at = run.finished_at; attempt.error = result.error;
        }
      }
      await this.save(run);
    }
  }
  start() { this.timer = setInterval(() => { void this.tick().catch(e => { this.lastError = jobError(e).message; }); }, 1000); this.timer.unref(); }
  stop() { this.stopped = true; clearInterval(this.timer); for (const active of this.active.values()) active.controller.abort(new Error("服务正在关闭")); }
  async flush() { await Promise.allSettled([...this.active.values()].map(a => a.work)); await this.runs.flush(); }
}
