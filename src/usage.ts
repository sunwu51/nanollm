import type { DatabaseSync } from "node:sqlite";
import type { NormalizedUsage } from "./converters/shared.js";

export interface UsageDayMetrics {
  totalRequests: number;
  successRequests: number;
  failureRequests: number;
  totalDurationMs: number;
  durationSamples: number;
  nonCacheInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface UsageDayCell extends UsageDayMetrics {
  day: string;
}

export interface UsageQuery {
  start: string;
  end: string;
  modelName?: string;
}

export interface UsageStoreLike {
  recordAttempt(modelName: string, timestamp?: number): void;
  recordSuccess(modelName: string, durationMs: number, usage?: NormalizedUsage, timestamp?: number): void;
  recordFailure(modelName: string, durationMs?: number, timestamp?: number): void;
  listDays(query: UsageQuery): UsageDayCell[];
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatLocalDay(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function parseLocalDay(day: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const parsed = new Date(year, month - 1, date);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== date) return undefined;
  return parsed;
}

export function addLocalDays(day: string, amount: number): string {
  const date = parseLocalDay(day);
  if (!date) throw new Error(`Invalid day '${day}'`);
  date.setDate(date.getDate() + amount);
  return formatLocalDay(date.getTime());
}

export function enumerateLocalDays(start: string, end: string): string[] {
  const startDate = parseLocalDay(start);
  const endDate = parseLocalDay(end);
  if (!startDate || !endDate || startDate > endDate) return [];

  const days: string[] = [];
  for (let cursor = start; cursor <= end; cursor = addLocalDays(cursor, 1)) {
    days.push(cursor);
  }
  return days;
}

function createEmptyUsageMetrics(): UsageDayMetrics {
  return {
    totalRequests: 0,
    successRequests: 0,
    failureRequests: 0,
    totalDurationMs: 0,
    durationSamples: 0,
    nonCacheInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

function buildTokenDelta(usage?: NormalizedUsage) {
  const nonCacheInputTokens = usage?.nonCacheInputTokens ?? 0;
  const cacheReadInputTokens = usage?.cacheReadInputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const totalTokens = usage?.totalTokens ?? nonCacheInputTokens + cacheReadInputTokens + outputTokens;
  return {
    nonCacheInputTokens,
    cacheReadInputTokens,
    outputTokens,
    totalTokens,
  };
}

function rowToUsageDayCell(row: Record<string, unknown>): UsageDayCell {
  return {
    day: String(row.day),
    totalRequests: Number(row.total_requests ?? 0),
    successRequests: Number(row.success_requests ?? 0),
    failureRequests: Number(row.failure_requests ?? 0),
    totalDurationMs: Number(row.total_duration_ms ?? 0),
    durationSamples: Number(row.duration_samples ?? 0),
    nonCacheInputTokens: Number(row.non_cache_input_tokens ?? 0),
    cacheReadInputTokens: Number(row.cache_read_input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    totalTokens: Number(row.total_tokens ?? 0),
  };
}

function buildDenseDays(query: UsageQuery, sparse: Map<string, UsageDayMetrics>): UsageDayCell[] {
  return enumerateLocalDays(query.start, query.end).map((day) => ({
    day,
    ...(sparse.get(day) ?? createEmptyUsageMetrics()),
  }));
}

export class UsageStore implements UsageStoreLike {
  private readonly modelDays = new Map<string, Map<string, UsageDayMetrics>>();

  private getDayMetrics(modelName: string, timestamp: number): UsageDayMetrics {
    const day = formatLocalDay(timestamp);
    const days = this.modelDays.get(modelName) ?? new Map<string, UsageDayMetrics>();
    this.modelDays.set(modelName, days);
    const metrics = days.get(day) ?? createEmptyUsageMetrics();
    days.set(day, metrics);
    return metrics;
  }

  recordAttempt(modelName: string, timestamp = Date.now()) {
    this.getDayMetrics(modelName, timestamp).totalRequests += 1;
  }

  recordSuccess(modelName: string, durationMs: number, usage?: NormalizedUsage, timestamp = Date.now()) {
    const metrics = this.getDayMetrics(modelName, timestamp);
    const tokenDelta = buildTokenDelta(usage);
    metrics.successRequests += 1;
    metrics.totalDurationMs += durationMs;
    metrics.durationSamples += 1;
    metrics.nonCacheInputTokens += tokenDelta.nonCacheInputTokens;
    metrics.cacheReadInputTokens += tokenDelta.cacheReadInputTokens;
    metrics.outputTokens += tokenDelta.outputTokens;
    metrics.totalTokens += tokenDelta.totalTokens;
  }

  recordFailure(modelName: string, durationMs?: number, timestamp = Date.now()) {
    const metrics = this.getDayMetrics(modelName, timestamp);
    metrics.failureRequests += 1;
    if (typeof durationMs === "number" && Number.isFinite(durationMs)) {
      metrics.totalDurationMs += durationMs;
      metrics.durationSamples += 1;
    }
  }

  listDays(query: UsageQuery): UsageDayCell[] {
    const sparse = new Map<string, UsageDayMetrics>();
    const modelEntries = query.modelName
      ? [[query.modelName, this.modelDays.get(query.modelName) ?? new Map<string, UsageDayMetrics>()] as const]
      : [...this.modelDays.entries()];

    for (const [, days] of modelEntries) {
      for (const [day, metrics] of days.entries()) {
        if (day < query.start || day > query.end) continue;
        const target = sparse.get(day) ?? createEmptyUsageMetrics();
        target.totalRequests += metrics.totalRequests;
        target.successRequests += metrics.successRequests;
        target.failureRequests += metrics.failureRequests;
        target.totalDurationMs += metrics.totalDurationMs;
        target.durationSamples += metrics.durationSamples;
        target.nonCacheInputTokens += metrics.nonCacheInputTokens;
        target.cacheReadInputTokens += metrics.cacheReadInputTokens;
        target.outputTokens += metrics.outputTokens;
        target.totalTokens += metrics.totalTokens;
        sparse.set(day, target);
      }
    }

    return buildDenseDays(query, sparse);
  }
}

export class SqliteUsageStore implements UsageStoreLike {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_days (
        day TEXT NOT NULL,
        model_name TEXT NOT NULL,
        total_requests INTEGER NOT NULL DEFAULT 0,
        success_requests INTEGER NOT NULL DEFAULT 0,
        failure_requests INTEGER NOT NULL DEFAULT 0,
        total_duration_ms REAL NOT NULL DEFAULT 0,
        duration_samples INTEGER NOT NULL DEFAULT 0,
        non_cache_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, model_name)
      );
      CREATE INDEX IF NOT EXISTS idx_usage_days_day ON usage_days(day);
      CREATE INDEX IF NOT EXISTS idx_usage_days_model_day ON usage_days(model_name, day);
    `);
    this.backfillFromStatusBuckets();
  }

  private addMetrics(modelName: string, timestamp: number, delta: Partial<UsageDayMetrics>) {
    const day = formatLocalDay(timestamp);
    this.db.prepare(`
      INSERT INTO usage_days (
        day,
        model_name,
        total_requests,
        success_requests,
        failure_requests,
        total_duration_ms,
        duration_samples,
        non_cache_input_tokens,
        cache_read_input_tokens,
        output_tokens,
        total_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day, model_name) DO UPDATE SET
        total_requests = total_requests + excluded.total_requests,
        success_requests = success_requests + excluded.success_requests,
        failure_requests = failure_requests + excluded.failure_requests,
        total_duration_ms = total_duration_ms + excluded.total_duration_ms,
        duration_samples = duration_samples + excluded.duration_samples,
        non_cache_input_tokens = non_cache_input_tokens + excluded.non_cache_input_tokens,
        cache_read_input_tokens = cache_read_input_tokens + excluded.cache_read_input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        total_tokens = total_tokens + excluded.total_tokens
    `).run(
      day,
      modelName,
      delta.totalRequests ?? 0,
      delta.successRequests ?? 0,
      delta.failureRequests ?? 0,
      delta.totalDurationMs ?? 0,
      delta.durationSamples ?? 0,
      delta.nonCacheInputTokens ?? 0,
      delta.cacheReadInputTokens ?? 0,
      delta.outputTokens ?? 0,
      delta.totalTokens ?? 0,
    );
  }

  recordAttempt(modelName: string, timestamp = Date.now()) {
    this.addMetrics(modelName, timestamp, { totalRequests: 1 });
  }

  recordSuccess(modelName: string, durationMs: number, usage?: NormalizedUsage, timestamp = Date.now()) {
    this.addMetrics(modelName, timestamp, {
      successRequests: 1,
      totalDurationMs: durationMs,
      durationSamples: 1,
      ...buildTokenDelta(usage),
    });
  }

  recordFailure(modelName: string, durationMs?: number, timestamp = Date.now()) {
    this.addMetrics(modelName, timestamp, {
      failureRequests: 1,
      ...(typeof durationMs === "number" && Number.isFinite(durationMs)
        ? { totalDurationMs: durationMs, durationSamples: 1 }
        : {}),
    });
  }

  listDays(query: UsageQuery): UsageDayCell[] {
    const rows = query.modelName
      ? this.db.prepare(`
          SELECT
            day,
            SUM(total_requests) AS total_requests,
            SUM(success_requests) AS success_requests,
            SUM(failure_requests) AS failure_requests,
            SUM(total_duration_ms) AS total_duration_ms,
            SUM(duration_samples) AS duration_samples,
            SUM(non_cache_input_tokens) AS non_cache_input_tokens,
            SUM(cache_read_input_tokens) AS cache_read_input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(total_tokens) AS total_tokens
          FROM usage_days
          WHERE day >= ? AND day <= ? AND model_name = ?
          GROUP BY day
          ORDER BY day
        `).all(query.start, query.end, query.modelName) as Record<string, unknown>[]
      : this.db.prepare(`
          SELECT
            day,
            SUM(total_requests) AS total_requests,
            SUM(success_requests) AS success_requests,
            SUM(failure_requests) AS failure_requests,
            SUM(total_duration_ms) AS total_duration_ms,
            SUM(duration_samples) AS duration_samples,
            SUM(non_cache_input_tokens) AS non_cache_input_tokens,
            SUM(cache_read_input_tokens) AS cache_read_input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(total_tokens) AS total_tokens
          FROM usage_days
          WHERE day >= ? AND day <= ?
          GROUP BY day
          ORDER BY day
        `).all(query.start, query.end) as Record<string, unknown>[];

    const sparse = new Map<string, UsageDayMetrics>();
    for (const row of rows) {
      const cell = rowToUsageDayCell(row);
      const { day, ...metrics } = cell;
      sparse.set(day, metrics);
    }

    return buildDenseDays(query, sparse);
  }

  getModelDay(modelName: string, day: string): UsageDayCell | undefined {
    const row = this.db.prepare("SELECT * FROM usage_days WHERE model_name = ? AND day = ?").get(modelName, day) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToUsageDayCell(row) : undefined;
  }

  private backfillFromStatusBuckets() {
    const hasStatusBuckets = this.db.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = 'status_buckets'
    `).get();
    if (!hasStatusBuckets) return;

    const rows = this.db.prepare(`
      SELECT
        model_name,
        bucket_start,
        total_requests,
        success_requests,
        total_duration_ms,
        duration_samples,
        non_cache_input_tokens,
        cache_read_input_tokens,
        output_tokens
      FROM status_buckets
      ORDER BY bucket_start
    `).all() as Record<string, unknown>[];

    const byModelDay = new Map<string, UsageDayMetrics & { day: string; modelName: string }>();
    for (const row of rows) {
      const modelName = String(row.model_name ?? "");
      const bucketStart = Number(row.bucket_start);
      if (!modelName || !Number.isFinite(bucketStart)) continue;
      const day = formatLocalDay(bucketStart);
      const key = `${day}\u0000${modelName}`;
      const metrics = byModelDay.get(key) ?? { day, modelName, ...createEmptyUsageMetrics() };
      const totalRequests = Number(row.total_requests ?? 0);
      const successRequests = Number(row.success_requests ?? 0);
      const nonCacheInputTokens = Number(row.non_cache_input_tokens ?? 0);
      const cacheReadInputTokens = Number(row.cache_read_input_tokens ?? 0);
      const outputTokens = Number(row.output_tokens ?? 0);
      metrics.totalRequests += totalRequests;
      metrics.successRequests += successRequests;
      metrics.failureRequests += Math.max(0, totalRequests - successRequests);
      metrics.totalDurationMs += Number(row.total_duration_ms ?? 0);
      metrics.durationSamples += Number(row.duration_samples ?? 0);
      metrics.nonCacheInputTokens += nonCacheInputTokens;
      metrics.cacheReadInputTokens += cacheReadInputTokens;
      metrics.outputTokens += outputTokens;
      metrics.totalTokens += nonCacheInputTokens + cacheReadInputTokens + outputTokens;
      byModelDay.set(key, metrics);
    }

    const insert = this.db.prepare(`
      INSERT INTO usage_days (
        day,
        model_name,
        total_requests,
        success_requests,
        failure_requests,
        total_duration_ms,
        duration_samples,
        non_cache_input_tokens,
        cache_read_input_tokens,
        output_tokens,
        total_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day, model_name) DO NOTHING
    `);
    for (const metrics of byModelDay.values()) {
      insert.run(
        metrics.day,
        metrics.modelName,
        metrics.totalRequests,
        metrics.successRequests,
        metrics.failureRequests,
        metrics.totalDurationMs,
        metrics.durationSamples,
        metrics.nonCacheInputTokens,
        metrics.cacheReadInputTokens,
        metrics.outputTokens,
        metrics.totalTokens,
      );
    }
  }
}

export function getDefaultUsageRange(now = Date.now()) {
  const end = formatLocalDay(now);
  const start = addLocalDays(end, -364);
  return { start, end };
}

export function getUsageYears(now = Date.now(), yearsBack = 4): number[] {
  const currentYear = new Date(now).getFullYear();
  return Array.from({ length: yearsBack }, (_, index) => currentYear - index);
}
