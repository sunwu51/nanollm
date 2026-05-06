import type { NormalizedUsage } from "./converters/shared.js";
import type { DatabaseSync } from "node:sqlite";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const RETENTION_MS = 6 * 60 * 60 * 1000;
const MAX_BUCKETS = RETENTION_MS / FIVE_MINUTES_MS;
const SQLITE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface RequestMetrics {
  totalRequests: number;
  successRequests: number;
  totalTtfbMs: number;
  ttfbSamples: number;
  totalDurationMs: number;
  durationSamples: number;
  totalStreamMs: number;
  streamSamples: number;
  nonCacheInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
}

export interface StatusCell extends RequestMetrics {
  bucketStart: number;
  successRate: number;
  avgTtfbMs: number | null;
  avgDurationMs: number | null;
  avgTokenSpeed: number | null;
}

type BucketMap = Map<number, RequestMetrics>;

export interface StatusStoreLike {
  recordAttempt(modelName: string, timestamp?: number): void;
  recordSuccess(
    modelName: string,
    durationMs: number,
    ttfbMs?: number,
    usage?: NormalizedUsage,
    timestamp?: number,
    streamDurationMs?: number,
  ): void;
  recordFailure(modelName: string, durationMs?: number, timestamp?: number): void;
  listBuckets(now?: number): number[];
  getModelSeries(modelName: string, now?: number): StatusCell[];
}

function createEmptyMetrics(): RequestMetrics {
  return {
    totalRequests: 0,
    successRequests: 0,
    totalTtfbMs: 0,
    ttfbSamples: 0,
    totalDurationMs: 0,
    durationSamples: 0,
    totalStreamMs: 0,
    streamSamples: 0,
    nonCacheInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
  };
}

function floorToFiveMinutes(timestamp: number): number {
  return Math.floor(timestamp / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
}

function pruneBuckets(buckets: BucketMap, now: number) {
  const minBucketStart = floorToFiveMinutes(now - RETENTION_MS);
  for (const bucketStart of buckets.keys()) {
    if (bucketStart < minBucketStart) {
      buckets.delete(bucketStart);
    }
  }

  if (buckets.size <= MAX_BUCKETS) return;
  const sorted = [...buckets.keys()].sort((a, b) => a - b);
  while (sorted.length > MAX_BUCKETS) {
    const oldest = sorted.shift();
    if (oldest !== undefined) buckets.delete(oldest);
  }
}

export class StatusStore {
  private readonly modelBuckets = new Map<string, BucketMap>();

  private getBucket(modelName: string, timestamp: number): RequestMetrics {
    const bucketStart = floorToFiveMinutes(timestamp);
    const buckets = this.modelBuckets.get(modelName) ?? new Map<number, RequestMetrics>();
    this.modelBuckets.set(modelName, buckets);
    pruneBuckets(buckets, timestamp);

    let metrics = buckets.get(bucketStart);
    if (!metrics) {
      metrics = createEmptyMetrics();
      buckets.set(bucketStart, metrics);
    }
    return metrics;
  }

  private addUsage(metrics: RequestMetrics, usage?: NormalizedUsage) {
    if (!usage) return;
    metrics.nonCacheInputTokens += usage.nonCacheInputTokens ?? 0;
    metrics.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
    metrics.outputTokens += usage.outputTokens ?? 0;
  }

  recordAttempt(modelName: string, timestamp = Date.now()) {
    this.getBucket(modelName, timestamp).totalRequests += 1;
  }

  recordSuccess(
    modelName: string,
    durationMs: number,
    ttfbMs?: number,
    usage?: NormalizedUsage,
    timestamp = Date.now(),
    streamDurationMs?: number,
  ) {
    const metrics = this.getBucket(modelName, timestamp);
    metrics.successRequests += 1;
    metrics.totalDurationMs += durationMs;
    metrics.durationSamples += 1;
    this.addUsage(metrics, usage);
    if (typeof ttfbMs === "number" && Number.isFinite(ttfbMs)) {
      metrics.totalTtfbMs += ttfbMs;
      metrics.ttfbSamples += 1;
    }
    if (typeof streamDurationMs === "number" && Number.isFinite(streamDurationMs) && streamDurationMs > 0) {
      metrics.totalStreamMs += streamDurationMs;
      metrics.streamSamples += 1;
    }
  }

  recordFailure(modelName: string, durationMs?: number, timestamp = Date.now()) {
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) return;
    const metrics = this.getBucket(modelName, timestamp);
    metrics.totalDurationMs += durationMs;
    metrics.durationSamples += 1;
  }

  listBuckets(now = Date.now()): number[] {
    const currentBucket = floorToFiveMinutes(now);
    const buckets: number[] = [];
    for (let index = MAX_BUCKETS - 1; index >= 0; index -= 1) {
      buckets.push(currentBucket - index * FIVE_MINUTES_MS);
    }
    return buckets;
  }

  getModelSeries(modelName: string, now = Date.now()): StatusCell[] {
    const buckets = this.modelBuckets.get(modelName);
    if (buckets) pruneBuckets(buckets, now);

    return this.listBuckets(now).map((bucketStart) => {
      const metrics = buckets?.get(bucketStart) ?? createEmptyMetrics();
      const successRate = metrics.totalRequests === 0 ? 0 : (metrics.successRequests / metrics.totalRequests) * 100;
      let avgTokenSpeed: number | null = null;
      if (metrics.totalStreamMs > 0 && metrics.outputTokens > 0) {
        avgTokenSpeed = metrics.outputTokens / (metrics.totalStreamMs / 1000);
      }
      return {
        bucketStart,
        ...metrics,
        successRate,
        avgTtfbMs: metrics.ttfbSamples > 0 ? metrics.totalTtfbMs / metrics.ttfbSamples : null,
        avgDurationMs: metrics.durationSamples > 0 ? metrics.totalDurationMs / metrics.durationSamples : null,
        avgTokenSpeed,
      };
    });
  }
}

export function getHealthTone(successRate: number, totalRequests: number): "empty" | "green" | "lightgreen" | "orange" | "red" {
  if (totalRequests === 0) return "empty";
  if (successRate >= 100) return "green";
  if (successRate >= 80) return "lightgreen";
  if (successRate >= 50) return "orange";
  return "red";
}

export function formatBucketLabel(bucketStart: number): string {
  const date = new Date(bucketStart);
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

type StatusRow = RequestMetrics & { bucket_start: number };

function rowToMetrics(row: Record<string, unknown>): RequestMetrics {
  return {
    totalRequests: Number(row.total_requests ?? 0),
    successRequests: Number(row.success_requests ?? 0),
    totalTtfbMs: Number(row.total_ttfb_ms ?? 0),
    ttfbSamples: Number(row.ttfb_samples ?? 0),
    totalDurationMs: Number(row.total_duration_ms ?? 0),
    durationSamples: Number(row.duration_samples ?? 0),
    totalStreamMs: Number(row.total_stream_ms ?? 0),
    streamSamples: Number(row.stream_samples ?? 0),
    nonCacheInputTokens: Number(row.non_cache_input_tokens ?? 0),
    cacheReadInputTokens: Number(row.cache_read_input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
  };
}

function buildStatusCell(bucketStart: number, metrics: RequestMetrics): StatusCell {
  const successRate = metrics.totalRequests === 0 ? 0 : (metrics.successRequests / metrics.totalRequests) * 100;
  let avgTokenSpeed: number | null = null;
  if (metrics.totalStreamMs > 0 && metrics.outputTokens > 0) {
    avgTokenSpeed = metrics.outputTokens / (metrics.totalStreamMs / 1000);
  }
  return {
    bucketStart,
    ...metrics,
    successRate,
    avgTtfbMs: metrics.ttfbSamples > 0 ? metrics.totalTtfbMs / metrics.ttfbSamples : null,
    avgDurationMs: metrics.durationSamples > 0 ? metrics.totalDurationMs / metrics.durationSamples : null,
    avgTokenSpeed,
  };
}

export class SqliteStatusStore implements StatusStoreLike {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS status_buckets (
        model_name TEXT NOT NULL,
        bucket_start INTEGER NOT NULL,
        total_requests INTEGER NOT NULL DEFAULT 0,
        success_requests INTEGER NOT NULL DEFAULT 0,
        total_ttfb_ms REAL NOT NULL DEFAULT 0,
        ttfb_samples INTEGER NOT NULL DEFAULT 0,
        total_duration_ms REAL NOT NULL DEFAULT 0,
        duration_samples INTEGER NOT NULL DEFAULT 0,
        total_stream_ms REAL NOT NULL DEFAULT 0,
        stream_samples INTEGER NOT NULL DEFAULT 0,
        non_cache_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (model_name, bucket_start)
      );
      CREATE INDEX IF NOT EXISTS idx_status_buckets_bucket_start ON status_buckets(bucket_start);
    `);
    this.pruneOldBuckets();
  }

  private pruneOldBuckets(now = Date.now()) {
    const minBucketStart = floorToFiveMinutes(now - SQLITE_RETENTION_MS);
    this.db.prepare("DELETE FROM status_buckets WHERE bucket_start < ?").run(minBucketStart);
  }

  private addMetrics(modelName: string, timestamp: number, delta: Partial<RequestMetrics>) {
    const bucketStart = floorToFiveMinutes(timestamp);
    this.db.prepare(`
      INSERT INTO status_buckets (
        model_name,
        bucket_start,
        total_requests,
        success_requests,
        total_ttfb_ms,
        ttfb_samples,
        total_duration_ms,
        duration_samples,
        total_stream_ms,
        stream_samples,
        non_cache_input_tokens,
        cache_read_input_tokens,
        output_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(model_name, bucket_start) DO UPDATE SET
        total_requests = total_requests + excluded.total_requests,
        success_requests = success_requests + excluded.success_requests,
        total_ttfb_ms = total_ttfb_ms + excluded.total_ttfb_ms,
        ttfb_samples = ttfb_samples + excluded.ttfb_samples,
        total_duration_ms = total_duration_ms + excluded.total_duration_ms,
        duration_samples = duration_samples + excluded.duration_samples,
        total_stream_ms = total_stream_ms + excluded.total_stream_ms,
        stream_samples = stream_samples + excluded.stream_samples,
        non_cache_input_tokens = non_cache_input_tokens + excluded.non_cache_input_tokens,
        cache_read_input_tokens = cache_read_input_tokens + excluded.cache_read_input_tokens,
        output_tokens = output_tokens + excluded.output_tokens
    `).run(
      modelName,
      bucketStart,
      delta.totalRequests ?? 0,
      delta.successRequests ?? 0,
      delta.totalTtfbMs ?? 0,
      delta.ttfbSamples ?? 0,
      delta.totalDurationMs ?? 0,
      delta.durationSamples ?? 0,
      delta.totalStreamMs ?? 0,
      delta.streamSamples ?? 0,
      delta.nonCacheInputTokens ?? 0,
      delta.cacheReadInputTokens ?? 0,
      delta.outputTokens ?? 0,
    );
    this.pruneOldBuckets(timestamp);
  }

  recordAttempt(modelName: string, timestamp = Date.now()) {
    this.addMetrics(modelName, timestamp, { totalRequests: 1 });
  }

  recordSuccess(
    modelName: string,
    durationMs: number,
    ttfbMs?: number,
    usage?: NormalizedUsage,
    timestamp = Date.now(),
    streamDurationMs?: number,
  ) {
    this.addMetrics(modelName, timestamp, {
      successRequests: 1,
      totalDurationMs: durationMs,
      durationSamples: 1,
      nonCacheInputTokens: usage?.nonCacheInputTokens ?? 0,
      cacheReadInputTokens: usage?.cacheReadInputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      ...(typeof ttfbMs === "number" && Number.isFinite(ttfbMs) ? { totalTtfbMs: ttfbMs, ttfbSamples: 1 } : {}),
      ...(typeof streamDurationMs === "number" && Number.isFinite(streamDurationMs) && streamDurationMs > 0
        ? { totalStreamMs: streamDurationMs, streamSamples: 1 }
        : {}),
    });
  }

  recordFailure(modelName: string, durationMs?: number, timestamp = Date.now()) {
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) return;
    this.addMetrics(modelName, timestamp, { totalDurationMs: durationMs, durationSamples: 1 });
  }

  listBuckets(now = Date.now()): number[] {
    const currentBucket = floorToFiveMinutes(now);
    const buckets: number[] = [];
    for (let index = MAX_BUCKETS - 1; index >= 0; index -= 1) {
      buckets.push(currentBucket - index * FIVE_MINUTES_MS);
    }
    return buckets;
  }

  getModelSeries(modelName: string, now = Date.now()): StatusCell[] {
    const bucketStarts = this.listBuckets(now);
    const firstBucket = bucketStarts[0] ?? floorToFiveMinutes(now);
    const rows = this.db.prepare(`
      SELECT *
      FROM status_buckets
      WHERE model_name = ? AND bucket_start >= ? AND bucket_start <= ?
    `).all(modelName, firstBucket, bucketStarts.at(-1) ?? firstBucket) as Record<string, unknown>[];
    const byBucket = new Map<number, RequestMetrics>();
    for (const row of rows) {
      byBucket.set(Number(row.bucket_start), rowToMetrics(row));
    }
    return bucketStarts.map((bucketStart) => buildStatusCell(bucketStart, byBucket.get(bucketStart) ?? createEmptyMetrics()));
  }

  hasBucket(modelName: string, bucketStart: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM status_buckets WHERE model_name = ? AND bucket_start = ?").get(modelName, bucketStart);
  }
}
