import type { NormalizedUsage } from "./converters/shared.js";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const RETENTION_MS = 6 * 60 * 60 * 1000;
const MAX_BUCKETS = RETENTION_MS / FIVE_MINUTES_MS;

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