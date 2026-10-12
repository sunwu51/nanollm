import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { CronExpressionParser } from "cron-parser";
import { parseDocument, stringify } from "yaml";
import type { ModelConfig } from "../core/config.js";
import { localize } from "../core/i18n.js";
import type { NormalizedUsage } from "../converters/shared.js";

export type JobFormat = "openai-chat" | "openai-responses" | "anthropic";
export interface Job {
  id: string;
  name: string;
  enabled: boolean;
  type: "model_request";
  schedule: { cron: string; timezone: string };
  models: string[];
  request: { message: string };
  execution: { timeout_ms: number; overlap_policy: "skip"; max_attempts: number; max_output_bytes: number };
  retention: { max_runs: number };
}
export type RunStatus = "running" | "succeeded" | "partial_failed" | "failed" | "cancelled" | "interrupted";
export type ResultStatus = "pending" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "interrupted";
export interface JobError { message: string }
export interface JobOutput { text: string; media_type: string; truncated: boolean }
export interface JobReview { status: "unreviewed" | "normal" | "suspect"; note: string; reviewed_at: number | null }
export interface JobResult {
  model_name: string; provider: string | null; upstream_model: string | null; connection_fingerprint: string | null;
  status: ResultStatus; started_at: number | null; finished_at: number | null;
  attempts: Array<{ attempt: number; status: ResultStatus; started_at: number; finished_at: number | null; error: JobError | null; request_id?: string }>;
  output: JobOutput | null; metrics: { ttfb_ms?: number; usage?: NormalizedUsage } | null;
  evaluation: null; review: JobReview; error: JobError | null;
}
export interface JobRun {
  id: string; job_id: string; trigger: "scheduled" | "manual"; scheduled_at: number | null;
  started_at: number; finished_at: number | null; status: RunStatus; snapshot_version: 1;
  job_snapshot: Job; results: JobResult[]; error: JobError | null; updated_at: number;
}
export class JobValidationError extends Error {}
export class JobConflictError extends Error {}
export const clone = <T>(value: T): T => structuredClone(value);

/**
 * Errors saved with job runs. They are stored in Chinese, like older records already are,
 * and the jobs page shows the English text when it is in English.
 */
export const RUN_MESSAGES = {
  executorMissing: { zh: "任务执行器不存在", en: "No executor for this job type" },
  timedOut: { zh: "模型调用超过任务超时限制", en: "The model call exceeded the job timeout" },
  modelUnavailable: { zh: "目标模型已移除或不支持任务测试", en: "The target model was removed or can't be used in jobs" },
  runInterrupted: { zh: "任务执行中断", en: "The run was interrupted" },
  cancelledByAdmin: { zh: "管理员取消执行", en: "Cancelled by an admin" },
  shuttingDown: { zh: "服务正在关闭", en: "The server is shutting down" },
  restartInterrupted: { zh: "服务重启，本次执行已中断", en: "The server restarted, so this run was interrupted" },
  outputTooLarge: { zh: "输出超过任务设置的大小限制", en: "The output exceeded the job's size limit" },
  upstreamError: { zh: "上游返回错误响应", en: "The upstream returned an error response" },
  upstreamIncomplete: { zh: "上游响应未完成", en: "The upstream response was incomplete" },
  outputCutOff: { zh: "输出被截断或过滤", en: "The output was truncated or filtered" },
  streamTooLarge: { zh: "上游响应流超过大小限制", en: "The upstream response stream exceeded the size limit" },
  streamUnfinished: { zh: "上游响应流未正常结束", en: "The upstream response stream did not finish properly" },
  noText: { zh: "模型未返回文本内容", en: "The model returned no text" },
} as const;

function object(value: unknown, path: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new JobValidationError(`${path}: ${localize("应为对象", "must be an object")}`);
  return value as Record<string, any>;
}
function keys(value: Record<string, any>, allowed: string[], path: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new JobValidationError(`${path}.${key}: ${localize("不支持的字段", "unsupported field")}`);
}
function integer(value: unknown, fallback: number, min: number, max: number, path: string) {
  const n = value === undefined ? fallback : value;
  if (!Number.isInteger(n) || Number(n) < min || Number(n) > max) throw new JobValidationError(`${path}: ${localize(`应为 ${min}–${max} 的整数`, `must be an integer from ${min} to ${max}`)}`);
  return Number(n);
}
export function nextJobDates(schedule: Job["schedule"], now = Date.now(), count = 5): number[] {
  if (typeof schedule.cron !== "string" || schedule.cron.trim().split(/\s+/).length !== 5 || /\bH\b|\?/.test(schedule.cron)) throw new JobValidationError("schedule.cron: " + localize("请填写五段 cron，不支持秒、H 或 ?", "enter a 5-field cron expression; seconds, H and ? are not supported"));
  try {
    if (typeof schedule.timezone !== "string" || !schedule.timezone.trim()) throw new Error(localize("缺少时区", "time zone is missing"));
    new Intl.DateTimeFormat("en", { timeZone: schedule.timezone }).format(now);
    const cron = CronExpressionParser.parse(schedule.cron, { tz: schedule.timezone, currentDate: now });
    return cron.take(count).map(date => date.toDate().getTime());
  } catch (error) { throw new JobValidationError(`schedule: ${error instanceof Error ? error.message : String(error)}`); }
}
export function validateJob(value: unknown): Job {
  const j = object(value, "job");
  keys(j, ["id", "name", "enabled", "type", "schedule", "models", "request", "execution", "retention"], "job");
  if (typeof j.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(j.id)) throw new JobValidationError("id: " + localize("请输入 1–80 位字母、数字、横线或下划线", "use 1–80 letters, digits, hyphens or underscores"));
  if (typeof j.name !== "string" || !j.name.trim() || j.name.length > 100) throw new JobValidationError("name: " + localize("名称应为 1–100 个字符", "the name must be 1–100 characters"));
  if (j.enabled !== undefined && typeof j.enabled !== "boolean") throw new JobValidationError("enabled: " + localize("应为布尔值", "must be a boolean"));
  if (j.type !== "model_request") throw new JobValidationError("type: " + localize("当前仅支持 model_request", "only model_request is supported"));
  const schedule = object(j.schedule, "schedule"); keys(schedule, ["cron", "timezone"], "schedule");
  nextJobDates(schedule as Job["schedule"], Date.now(), 1);
  if (!Array.isArray(j.models) || j.models.length < 1 || j.models.length > 20 || j.models.some((m: unknown) => typeof m !== "string" || !m.trim() || m.includes("*") || m.length > 512)) throw new JobValidationError("models: " + localize("请选择 1–20 个具体模型", "choose 1–20 specific models"));
  if (new Set(j.models).size !== j.models.length) throw new JobValidationError("models: " + localize("模型不能重复", "models must not repeat"));
  const request = object(j.request, "request"); keys(request, ["message"], "request");
  if (typeof request.message !== "string" || !request.message.trim()) throw new JobValidationError("request.message: " + localize("请填写用户消息", "enter a user message"));
  if (Buffer.byteLength(request.message) > 128 * 1024) throw new JobValidationError("request.message: " + localize("消息不能超过 128 KiB", "the message must not exceed 128 KiB"));
  const ex = object(j.execution ?? {}, "execution"); keys(ex, ["timeout_ms", "overlap_policy", "max_attempts", "max_output_bytes"], "execution");
  if (ex.overlap_policy !== undefined && ex.overlap_policy !== "skip") throw new JobValidationError("execution.overlap_policy: " + localize("当前仅支持 skip", "only skip is supported"));
  const retention = object(j.retention ?? {}, "retention"); keys(retention, ["max_runs"], "retention");
  return { id: j.id, name: j.name.trim(), enabled: j.enabled ?? true, type: "model_request",
    schedule: { cron: schedule.cron.trim(), timezone: schedule.timezone.trim() }, models: [...j.models],
    request: clone(request) as Job["request"], execution: {
      timeout_ms: integer(ex.timeout_ms, 300000, 1000, 3600000, "execution.timeout_ms"), overlap_policy: "skip",
      max_attempts: integer(ex.max_attempts, 1, 1, 5, "execution.max_attempts"),
      max_output_bytes: integer(ex.max_output_bytes, 262144, 1024, 1048576, "execution.max_output_bytes") },
    retention: { max_runs: integer(retention.max_runs, 24, 1, 168, "retention.max_runs") } };
}
export function validateJobModels(job: Job, models: ModelConfig[]) {
  for (const name of job.models) if (!models.some(m => m.name === name && m.provider !== "openai-image" && !m.name.includes("*"))) throw new JobValidationError(`models: ${localize(`'${name}' 不是已保存的具体文本模型`, `'${name}' is not a saved text model`)}`);
}
export function connectionFingerprint(model: ModelConfig): string {
  // API credentials are never included in the stored snapshot or comparison fingerprint.
  const { api_key, headers, ...settings } = model;
  let baseUrl = settings.base_url;
  try { const url = new URL(baseUrl); url.username = ""; url.password = ""; url.search = ""; baseUrl = url.href; } catch {}
  return createHash("sha256").update(JSON.stringify({ ...settings, base_url: baseUrl })).digest("hex");
}
export function jobError(error: unknown): JobError {
  return { message: (error instanceof Error ? error.message : String(error))
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(api[-_ ]?key|authorization|token)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[REDACTED]").slice(0, 2000) };
}

/** Configuration only. Results never get written to this file. */
export class JobConfigStore {
  private jobs: Job[] = [];
  private observed = "";
  private version = "";
  lastError?: string;
  constructor(readonly path: string) { this.refresh(); }
  refresh() {
    try {
      const raw = existsSync(this.path) ? readFileSync(this.path, "utf8") : "version: 1\njobs: []\n";
      const hash = createHash("sha256").update(raw).digest("hex");
      if (hash === this.observed) return;
      this.observed = hash;
      if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error(localize("jobs.yaml 超过 2 MiB", "jobs.yaml is larger than 2 MiB"));
      const doc = parseDocument(raw);
      if (doc.errors.length) throw doc.errors[0];
      const source = object(doc.toJS(), "jobs.yaml"); keys(source, ["version", "jobs"], "jobs.yaml");
      if (source.version !== 1 || !Array.isArray(source.jobs) || source.jobs.length > 100) throw new Error("jobs.yaml: " + localize("version 应为 1，jobs 应为最多 100 个任务的数组", "version must be 1 and jobs an array of at most 100 jobs"));
      const jobs = source.jobs.map((value: any) => {
        // Migrate the first version's single-user templates; reject ambiguous conversations.
        if (value?.request?.message === undefined && value?.request?.body) {
          const body = value.request.body;
          const input = body.messages ?? body.input;
          const content = typeof input === "string" ? input :
            Array.isArray(input) && input.length === 1 && input[0]?.role === "user" ? input[0].content : undefined;
          const message = typeof content === "string" ? content :
            Array.isArray(content) && content.every((part: any) => ["text", "input_text"].includes(part.type) && typeof part.text === "string") ? content.map((part: any) => part.text).join("\n") : undefined;
          if (message !== undefined) value = { ...value, request: { message } };
        }
        return validateJob(value);
      });
      if (new Set(jobs.map(j => j.id)).size !== jobs.length) throw new Error("jobs.yaml: " + localize("任务 ID 重复", "duplicate job IDs"));
      this.jobs = jobs; this.version = hash; this.lastError = undefined;
    } catch (error) {
      this.lastError = jobError(error).message;
      // Parse a broken file again on the next read, so its error comes out in that reader's language.
      this.observed = "";
    }
  }
  snapshot() { this.refresh(); return { jobs: clone(this.jobs), version: this.version, lastError: this.lastError }; }
  get(id: string) { return this.snapshot().jobs.find(j => j.id === id); }
  save(job: Job, baseVersion: unknown, create: boolean) {
    const jobs = this.snapshot().jobs;
    if (create && jobs.some(j => j.id === job.id)) throw new JobConflictError(localize("任务 ID 已存在", "A job with this ID already exists"));
    if (!create && !jobs.some(j => j.id === job.id)) throw new JobConflictError(localize("任务已删除", "The job was deleted"));
    if (create && jobs.length >= 100) throw new JobValidationError(localize("最多允许 100 个任务", "At most 100 jobs are allowed"));
    this.write(create ? [...jobs, job] : jobs.map(j => j.id === job.id ? job : j), baseVersion);
  }
  delete(id: string, baseVersion: unknown) {
    const jobs = this.snapshot().jobs;
    if (!jobs.some(j => j.id === id)) throw new JobConflictError(localize("任务已删除", "The job was deleted"));
    this.write(jobs.filter(j => j.id !== id), baseVersion);
  }
  private write(jobs: Job[], baseVersion: unknown) {
    this.refresh();
    if (this.lastError) throw new JobConflictError(localize(`请先修复 jobs.yaml：${this.lastError}`, `Fix jobs.yaml first: ${this.lastError}`));
    if (baseVersion !== this.version) throw new JobConflictError(localize("任务配置已变化，请刷新后再保存", "The job config changed; refresh before saving"));
    const raw = existsSync(this.path) ? readFileSync(this.path, "utf8") : stringify({ version: 1, jobs: [] });
    const doc = parseDocument(raw); doc.set("jobs", jobs);
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, doc.toString(), "utf8"); renameSync(temp, this.path); }
    finally { if (existsSync(temp)) unlinkSync(temp); }
    this.observed = ""; this.refresh();
  }
}
