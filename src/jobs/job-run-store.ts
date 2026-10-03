import type { JobRun, JobReview } from "./jobs.js";
import { clone, JobConflictError, JobValidationError } from "./jobs.js";
import { enqueueClientWrite, waitForClientWrites, type SqliteClient } from "../storage/sqlite.js";

export type JobRunSummary = Omit<JobRun, "job_snapshot" | "results"> & { job_name: string; results: Array<Pick<JobRun["results"][number], "model_name" | "status" | "review" | "error" | "started_at" | "finished_at">> };
export function summarizeRun(run: JobRun): JobRunSummary {
  const { job_snapshot, results, ...base } = run;
  return { ...base, job_name: job_snapshot.name, results: results.map(({ model_name, status, review, error, started_at, finished_at }) => ({ model_name, status, review, error, started_at, finished_at })) };
}
export interface JobRunStore {
  initialize(): Promise<void>;
  get(id: string): Promise<JobRun | undefined>;
  list(jobId?: string): Promise<JobRunSummary[]>;
  save(run: JobRun, maxRuns: number): Promise<void>;
  prune(jobId: string, maxRuns: number): Promise<void>;
  deleteJob(jobId: string): Promise<void>;
  review(id: string, modelName: string, status: unknown, note: unknown): Promise<void>;
  flush(): Promise<void>;
}
function updateReview(run: JobRun | undefined, modelName: string, status: unknown, note: unknown): JobRun {
  if (!run) throw new JobValidationError("执行记录不存在或已被清理");
  if (run.status === "running") throw new JobConflictError("请等待本次执行结束再审核");
  if (!["unreviewed", "normal", "suspect"].includes(String(status)) || typeof note !== "string" || note.length > 2000) throw new JobValidationError("审核状态无效或备注超过 2000 字符");
  const result = run.results.find(r => r.model_name === modelName);
  if (!result) throw new JobValidationError("模型结果不存在");
  result.review = { status: status as JobReview["status"], note, reviewed_at: Date.now() };
  run.updated_at = Date.now(); return run;
}

export class MemoryJobRunStore implements JobRunStore {
  private runs = new Map<string, JobRun>();
  constructor(private maxBytes = 64 * 1024 * 1024) {}
  async initialize() {}
  async get(id: string) { const run = this.runs.get(id); return run ? clone(run) : undefined; }
  async list(jobId?: string) { return [...this.runs.values()].filter(r => !jobId || r.job_id === jobId).sort((a, b) => b.started_at - a.started_at || b.id.localeCompare(a.id)).map(r => clone(summarizeRun(r))); }
  async save(run: JobRun, maxRuns: number) { this.runs.set(run.id, clone(run)); await this.prune(run.job_id, maxRuns); }
  async prune(jobId: string, maxRuns: number) {
    const finished = [...this.runs.values()].filter(r => r.job_id === jobId && r.status !== "running").sort((a, b) => b.started_at - a.started_at || b.id.localeCompare(a.id));
    for (const run of finished.slice(maxRuns)) this.runs.delete(run.id);
    this.enforceBudget();
  }
  private enforceBudget() {
    // A count limit alone cannot bound memory when many jobs return large outputs.
    let bytes = [...this.runs.values()].reduce((sum, r) => sum + Buffer.byteLength(JSON.stringify(r)), 0);
    for (const run of [...this.runs.values()].filter(r => r.status !== "running").sort((a, b) => a.started_at - b.started_at)) {
      if (bytes <= this.maxBytes) break;
      bytes -= Buffer.byteLength(JSON.stringify(run)); this.runs.delete(run.id);
    }
  }
  async deleteJob(jobId: string) { for (const [id, run] of this.runs) if (run.job_id === jobId) this.runs.delete(id); }
  async review(id: string, modelName: string, status: unknown, note: unknown) { const existing = this.runs.get(id); const run = updateReview(existing ? clone(existing) : undefined, modelName, status, note); this.runs.set(id, run); this.enforceBudget(); }
  async flush() {}
}

export class SqliteJobRunStore implements JobRunStore {
  constructor(private client: SqliteClient, private namespace: string) {}
  async initialize() {
    await enqueueClientWrite(this.client, async () => {
      await this.client.executeMultiple(`
        CREATE TABLE IF NOT EXISTS job_runs (
          id TEXT PRIMARY KEY, namespace TEXT NOT NULL, job_id TEXT NOT NULL,
          trigger TEXT NOT NULL, scheduled_at INTEGER, started_at INTEGER NOT NULL,
          finished_at INTEGER, status TEXT NOT NULL, snapshot_version INTEGER NOT NULL,
          job_snapshot_json TEXT NOT NULL, results_json TEXT NOT NULL,
          error_json TEXT, updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS job_runs_job_started ON job_runs(namespace, job_id, started_at DESC, id DESC);
      `);
      const running = await this.client.execute({ sql: "SELECT * FROM job_runs WHERE namespace = ? AND status = 'running'", args: [this.namespace] });
      for (const row of running.rows) {
        const run = this.decode(row); run.status = "interrupted"; run.finished_at = run.updated_at = Date.now();
        run.error = { message: "服务重启，本次执行已中断" };
        for (const result of run.results) if (["pending", "running"].includes(result.status)) {
          result.status = "interrupted"; result.finished_at = run.finished_at; result.error = run.error;
          for (const attempt of result.attempts) if (attempt.status === "running") { attempt.status = "interrupted"; attempt.finished_at = run.finished_at; attempt.error = run.error; }
        }
        await this.put(run);
        await this.pruneRows(run.job_id, run.job_snapshot.retention.max_runs);
      }
    });
  }
  private decode(row: any): JobRun {
    return { id: String(row.id), job_id: String(row.job_id), trigger: row.trigger,
      scheduled_at: row.scheduled_at == null ? null : Number(row.scheduled_at), started_at: Number(row.started_at),
      finished_at: row.finished_at == null ? null : Number(row.finished_at), status: row.status, snapshot_version: Number(row.snapshot_version) as 1,
      job_snapshot: JSON.parse(String(row.job_snapshot_json)), results: JSON.parse(String(row.results_json)),
      error: row.error_json ? JSON.parse(String(row.error_json)) : null, updated_at: Number(row.updated_at) };
  }
  async get(id: string) {
    await waitForClientWrites(this.client);
    const result = await this.client.execute({ sql: "SELECT * FROM job_runs WHERE namespace = ? AND id = ?", args: [this.namespace, id] });
    return result.rows[0] ? this.decode(result.rows[0]) : undefined;
  }
  async list(jobId?: string): Promise<JobRunSummary[]> {
    await waitForClientWrites(this.client);
    // Return summaries without transferring HTML/SVG payloads from the database.
    const result = await this.client.execute({ sql: `SELECT id, job_id, trigger, scheduled_at, started_at, finished_at, status, snapshot_version, error_json, updated_at,
      json_extract(job_snapshot_json, '$.name') AS job_name,
      (SELECT json_group_array(json_object('model_name',json_extract(value,'$.model_name'), 'status',json_extract(value,'$.status'),
        'review',json_extract(value,'$.review'), 'error',json_extract(value,'$.error'),
        'started_at',json_extract(value,'$.started_at'), 'finished_at',json_extract(value,'$.finished_at'))) FROM json_each(results_json)) AS summaries
      FROM job_runs WHERE namespace = ? ${jobId ? "AND job_id = ?" : ""} ORDER BY started_at DESC, id DESC`, args: jobId ? [this.namespace, jobId] : [this.namespace] });
    return result.rows.map((r: any) => ({ id: String(r.id), job_id: String(r.job_id), job_name: String(r.job_name), trigger: r.trigger,
      scheduled_at: r.scheduled_at == null ? null : Number(r.scheduled_at), started_at: Number(r.started_at), finished_at: r.finished_at == null ? null : Number(r.finished_at),
      status: r.status, snapshot_version: Number(r.snapshot_version) as 1, updated_at: Number(r.updated_at),
      error: r.error_json ? JSON.parse(String(r.error_json)) : null, results: JSON.parse(String(r.summaries)) }));
  }
  private async put(run: JobRun) {
    await this.client.execute({ sql: `INSERT INTO job_runs
      (id,namespace,job_id,trigger,scheduled_at,started_at,finished_at,status,snapshot_version,job_snapshot_json,results_json,error_json,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET finished_at=excluded.finished_at,status=excluded.status,
      results_json=excluded.results_json,error_json=excluded.error_json,updated_at=excluded.updated_at`,
      args: [run.id, this.namespace, run.job_id, run.trigger, run.scheduled_at, run.started_at, run.finished_at, run.status, run.snapshot_version,
        JSON.stringify(run.job_snapshot), JSON.stringify(run.results), run.error ? JSON.stringify(run.error) : null, run.updated_at] });
  }
  private async pruneRows(jobId: string, maxRuns: number) {
    await this.client.execute({ sql: `DELETE FROM job_runs WHERE namespace = ? AND job_id = ? AND status != 'running' AND id NOT IN
      (SELECT id FROM job_runs WHERE namespace = ? AND job_id = ? AND status != 'running' ORDER BY started_at DESC, id DESC LIMIT ?)`, args: [this.namespace, jobId, this.namespace, jobId, maxRuns] });
  }
  async save(run: JobRun, maxRuns: number) {
    const snapshot = clone(run);
    await enqueueClientWrite(this.client, async () => { await this.put(snapshot); await this.pruneRows(run.job_id, maxRuns); });
  }
  async prune(jobId: string, maxRuns: number) { await enqueueClientWrite(this.client, () => this.pruneRows(jobId, maxRuns)); }
  async deleteJob(jobId: string) { await enqueueClientWrite(this.client, async () => { await this.client.execute({ sql: "DELETE FROM job_runs WHERE namespace = ? AND job_id = ?", args: [this.namespace, jobId] }); }); }
  async review(id: string, modelName: string, status: unknown, note: unknown) {
    await enqueueClientWrite(this.client, async () => {
      const result = await this.client.execute({ sql: "SELECT * FROM job_runs WHERE namespace = ? AND id = ?", args: [this.namespace, id] });
      await this.put(updateReview(result.rows[0] ? this.decode(result.rows[0]) : undefined, modelName, status, note));
    });
  }
  async flush() { await waitForClientWrites(this.client); }
}
