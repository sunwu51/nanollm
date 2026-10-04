// @ts-nocheck
import "dotenv/config";
import { JobModelCatalog } from "./src/jobs/job-model-catalog.js";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { Hono } from "hono";
import type { Context } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { randomUUID } from "node:crypto";
import type { ModelConfig, ServerConfig } from "./src/core/config.js";
import { buildAuthCookieValue, extractBearerToken, isAuthorizedToken, readAuthCookie } from "./src/core/auth.js";
import { getPublicModelNames, parseConfigText, resolveFallbackModels, resolveModel, resolveModelForRequest } from "./src/core/config.js";
import { ConfigManager } from "./src/core/config-manager.js";
import { applyClaudeSubscriptionHeaders, getUpstreamURL } from "./src/proxy/proxy.js";
import { forwardRequest, forwardStreamRequest, passthroughAlphaSearchRequest, passthroughRawRequest, passthroughRequest, passthroughStreamRequest, type OpenAIImageOperation } from "./src/proxy/proxy.js";
import { FallbackFailureTracker, sortFallbackGroupMembers } from "./src/proxy/fallback.js";
import { SqliteStatusStore, StatusStore, type StatusStoreLike } from "./src/storage/status.js";
import { renderStatusPage } from "./src/pages/status-page.js";
import { SqliteUsageStore, UsageStore, addLocalDays, formatLocalDay, getUsageYears, parseLocalDay, type UsageStoreLike } from "./src/storage/usage.js";
import { renderRecordPage } from "./src/pages/record-page.js";
import { renderAdminConfigPage } from "./src/pages/admin-config-page.js";
import { buildModelTestRequest, DEFAULT_MODEL_TEST_MESSAGE, extractModelTestReply } from "./src/proxy/model-test.js";
import { fetchUpstreamModels } from "./src/proxy/upstream-models.js";
import { getHTTPLogLevel, shouldEmitLog } from "./src/core/http-log.js";
import { buildJsonResponse, buildNonStreamResponse } from "./src/core/response-compression.js";
import {
  normalizeOpenAIChatRequest,
  normalizeOpenAIResponsesRequest,
  normalizeAnthropicRequest,
} from "./src/converters/requests.js";
import {
  denormalizeToOpenAIChatResponse,
  denormalizeToOpenAIResponsesResponse,
  denormalizeToAnthropicResponse,
} from "./src/converters/responses.js";
import { createSSEConverter, createUsageCollector, formatDone, SSEParser } from "./src/converters/streams.js";
import { createRequestId, getRequestId, runWithRequestId, setClientIp, setClientRequestHeaders, withRequestId } from "./src/core/request-context.js";
import { cacheResponseItems, resolveItemReferences, shouldCacheResponseItems } from "./src/proxy/response-cache.js";
import {
  appendRecordedAttemptResponseBody,
  appendRecordedClientResponseBody,
  beginRecordedRequest,
  configureRecording,
  finalizeRecordedRequest,
  flushRecording,
  getRecordedImage,
  getRecordedRequest,
  getRecordSummary,
  startRecording,
  type RecordEntry,
  setRecordedClientResponseBody,
  setRecordedClientResponseMeta,
  setRecordedRequestError,
  useSqliteRecordStore,
} from "./src/storage/record.js";
import type { StreamFormat } from "./src/converters/streams.js";
import type { NormalizedRequest, NormalizedResponse } from "./src/converters/shared.js";
import { UnsupportedContentError } from "./src/converters/shared.js";
import { shouldIgnoreStreamReadError } from "./src/core/stream-errors.js";
import { handleServerStartupError } from "./src/core/startup-error.js";
import { installGracefulShutdown } from "./src/core/shutdown.js";
import { JobConfigStore } from "./src/jobs/jobs.js";
import { MemoryJobRunStore, SqliteJobRunStore } from "./src/jobs/job-run-store.js";
import { JobScheduler } from "./src/jobs/job-scheduler.js";
import { createModelRequestExecutor } from "./src/jobs/job-executor.js";
import { createJobRoutes } from "./src/jobs/job-routes.js";
import { renderJobsPage } from "./src/jobs/jobs-page.js";
import { openSqliteStorage, waitForClientWrites } from "./src/storage/sqlite.js";
import { buildAdminConfigForm, buildAdminConfigFormFromEffectiveConfig, buildYamlTextFromAdminForm, type AdminConfigForm } from "./src/pages/admin-config-form.js";
import { extractErrorCauses, formatErrorWithCauses } from "./src/core/error-details.js";
import { bootstrapSubscriptionProviders, configureSubscriptionStorage, fetchSubscriptionModels, fetchSubscriptionUsage, getCachedSubscriptionCredential, pollDeviceLogin, resetSubscriptionUsage, startDeviceLogin } from "./src/subscriptions/openai-subscription.js";
import { bootstrapClaudeSubscriptionProviders, completeClaudeLogin, configureClaudeSubscriptionStorage, fetchClaudeSubscriptionModels, fetchClaudeSubscriptionUsage, getCachedClaudeSubscriptionCredential, startClaudeLogin } from "./src/subscriptions/claude-subscription.js";

// ─── Config ─────────────────────────────────────────────────────────────────

function resolveConfigPath(argv: string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      const value = argv[index + 1];
      if (!value) throw new Error("Missing value for --config");
      return resolve(process.cwd(), value);
    }
    if (arg.startsWith("--config=")) {
      const value = arg.slice("--config=".length);
      if (!value) throw new Error("Missing value for --config");
      return resolve(process.cwd(), value);
    }
  }

  if (process.env.CONFIG_PATH) {
    return resolve(process.cwd(), process.env.CONFIG_PATH);
  }

  const cwdConfigPath = resolve(process.cwd(), "config.yaml");
  if (existsSync(cwdConfigPath)) {
    return cwdConfigPath;
  }

  throw new Error(
    "Missing config file. Pass --config /path/to/config.yaml, set CONFIG_PATH, or place config.yaml in the current directory.",
  );
}

type StorageMode = "memory" | "sqlite";

function resolveStorageMode(argv: string[]): StorageMode {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    let value: string | undefined;
    if (arg === "--storage") {
      value = argv[index + 1];
      if (!value) throw new Error("Missing value for --storage");
    } else if (arg.startsWith("--storage=")) {
      value = arg.slice("--storage=".length);
      if (!value) throw new Error("Missing value for --storage");
    }
    if (value !== undefined) {
      if (value === "memory" || value === "sqlite") return value;
      throw new Error(`Invalid --storage value '${value}'. Expected 'memory' or 'sqlite'.`);
    }
  }
  return "memory";
}

const startupArgs = process.argv.slice(2);
const configPath = resolveConfigPath(startupArgs);
configureSubscriptionStorage(configPath);
configureClaudeSubscriptionStorage(configPath);
const storageMode = resolveStorageMode(startupArgs);
const sqlitePath = join(homedir(), ".nanollm", "nanollm.sqlite3");
const sqliteStorage = storageMode === "sqlite" ? await openSqliteStorage(sqlitePath) : undefined;
const configManager = new ConfigManager(configPath);
const startupSnapshot = configManager.getActiveSnapshot();
bootstrapSubscriptionProviders(startupSnapshot.effectiveConfig.providers.filter((provider) => provider.provider === "openai-subscription"));
bootstrapClaudeSubscriptionProviders(startupSnapshot.effectiveConfig.providers);
if (sqliteStorage) {
  useSqliteRecordStore(sqliteStorage.client);
}
await startRecording({ maxSize: startupSnapshot.effectiveConfig.record.max_size });
configManager.onUpdate(({ snapshot }, source) => {
  bootstrapSubscriptionProviders(snapshot.effectiveConfig.providers.filter((provider) => provider.provider === "openai-subscription"));
  bootstrapClaudeSubscriptionProviders(snapshot.effectiveConfig.providers);
  void configureRecording({ maxSize: snapshot.effectiveConfig.record.max_size });
  if (source !== "startup") {
    console.log(
      `[CONFIG APPLY] source=${source} models=${snapshot.effectiveConfig.models.length} fallback_groups=${Object.keys(snapshot.effectiveConfig.fallback).length} record_max_size=${snapshot.effectiveConfig.record.max_size}`,
    );
  }
});
const app = new Hono();
const AUTH_COOKIE_NAME = "nanollm_auth";
const apiCors = cors({
  origin: "*",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
});

app.use("*", async (c, next) => {
  if (shutdown.isShuttingDown()) {
    c.header("Connection", "close");
    return c.json({ error: "Server is shutting down" }, 503);
  }
  return next();
});

app.use("*", async (c, next) => {
  const requestId = getRequestId() ?? createRequestId();
  const started = Date.now();
  const logLevel = getHTTPLogLevel(c.req.path);
  const emitLog = (message: string) => {
    if (!shouldEmitLog(logLevel)) return;
    console.log(message);
  };

  await runWithRequestId(requestId, async () => {
    setClientRequestHeaders(c.req.raw.headers);
    setClientIp(c.req.raw.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || c.req.raw.headers.get("x-real-ip")?.trim() || c.req.raw.headers.get("cf-connecting-ip")?.trim() || undefined);
    emitLog(withRequestId(`[HTTP START] method=${c.req.method} path=${c.req.path}`));

    try {
      await next();
      const responseType = c.res.headers.get("content-type") ?? "";
      if (responseType.includes("text/event-stream")) {
        emitLog(withRequestId(`[HTTP STREAM START] method=${c.req.method} path=${c.req.path} status=${c.res.status} duration=${Date.now() - started}ms`));
      } else {
        emitLog(withRequestId(`[HTTP END] method=${c.req.method} path=${c.req.path} status=${c.res.status} duration=${Date.now() - started}ms`));
      }
    } catch (error) {
      console.error(orange(withRequestId(`[HTTP ERROR] method=${c.req.method} path=${c.req.path} duration=${Date.now() - started}ms`)), error);
      throw error;
    }
  });
});

app.use("*", async (c, next) => {
  if (c.req.path.startsWith("/admin/") || c.req.path === "/jobs" || c.req.path.startsWith("/jobs/")) {
    return next();
  }
  return apiCors(c, next);
});

app.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return next();
  }
  if (c.req.path === "/health") {
    return next();
  }

  const authToken = configManager.getActiveSnapshot().effectiveConfig.auth?.token;
  if (!authToken) {
    return next();
  }

  const headerToken = extractBearerToken(c.req.header("authorization"));
  const queryToken = c.req.query("token") || undefined;
  const cookieToken = readAuthCookie(c.req.header("cookie"), AUTH_COOKIE_NAME);
  if (
    isAuthorizedToken(authToken, headerToken) ||
    isAuthorizedToken(authToken, queryToken) ||
    isAuthorizedToken(authToken, cookieToken)
  ) {
    persistAuthCookie(c, authToken);
    return next();
  }

  return unauthorizedResponse(c);
});

// ─── Helpers ────────────────────────────────────────────────────────────────

type Normalizer = (body: unknown) => NormalizedRequest;
type Denormalizer = (normalized: NormalizedResponse) => unknown;
type UpstreamOptions = { userAgent?: string; attemptIndex?: number; modelName?: string };
const fallbackFailureTracker = new FallbackFailureTracker();
const statusStore: StatusStoreLike = sqliteStorage ? new SqliteStatusStore(sqliteStorage.client) : new StatusStore();
const usageStore: UsageStoreLike = sqliteStorage ? new SqliteUsageStore(sqliteStorage.client) : new UsageStore();
const jobsPath = join(dirname(configPath), "jobs.yaml");
const jobConfigStore = new JobConfigStore(jobsPath);
const jobRunStore = sqliteStorage ? new SqliteJobRunStore(sqliteStorage.client, jobsPath) : new MemoryJobRunStore();
const jobModelCatalog = new JobModelCatalog(() => configManager.getActiveSnapshot().effectiveConfig);
// Scheduled jobs call the gateway's own /v1 routes in-process, so they are recorded and counted in
// status/usage exactly like client requests. The job's catalog-resolved model is pinned to the
// request id for getCandidateModels, so the call uses the connection snapshotted when the run started.
const jobRequestModels = new Map<string, ModelConfig>();
const jobRequestExecutor = createModelRequestExecutor(async (model, request) => {
  const config = configManager.getActiveSnapshot().effectiveConfig;
  const requestId = getRequestId() ?? createRequestId();
  const headers = new Headers({ "content-type": "application/json" });
  if (!model.subscription_provider && !model.claude_subscription_provider) headers.set("user-agent", "nanollm-scheduled-job");
  if (config.auth?.token) headers.set("authorization", `Bearer ${config.auth.token}`);
  jobRequestModels.set(requestId, model);
  try {
    return await app.fetch(new Request(`http://127.0.0.1:${config.port}${request.path}`, { method: "POST", headers, body: JSON.stringify(request.body) }));
  } finally {
    jobRequestModels.delete(requestId);
  }
});
const jobScheduler = new JobScheduler(jobConfigStore, jobRunStore,
  () => configManager.getActiveSnapshot().effectiveConfig.models,
  // The whole execution, including reading the stream, stays in the request context so the record is finalized under this id.
  [{ ...jobRequestExecutor, execute: (job, model, signal, context) => runWithRequestId(context?.requestId ?? createRequestId(), () => jobRequestExecutor.execute(job, model, signal)) }],
  Date.now, 2, name => jobModelCatalog.resolve(name));
await jobScheduler.initialize();
const ORANGE = "\x1b[38;5;214m";
const RESET = "\x1b[0m";

function writeConfigAtomic(path: string, text: string) {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, text, "utf-8");
  renameSync(tempPath, path);
}

function unauthorizedResponse(c: Context) {
  c.header("WWW-Authenticate", "Bearer");
  return c.json({ error: "Unauthorized" }, 401);
}

function persistAuthCookie(c: Context, token: string) {
  c.header(
    "Set-Cookie",
    `${AUTH_COOKIE_NAME}=${buildAuthCookieValue(token)}; Path=/; HttpOnly; SameSite=Lax`,
  );
}

function getNormalizer(format: StreamFormat): Normalizer {
  switch (format) {
    case "openai-chat":
      return normalizeOpenAIChatRequest;
    case "openai-responses":
      return normalizeOpenAIResponsesRequest;
    case "anthropic":
      return normalizeAnthropicRequest;
    case "openai-image":
      throw new Error("openai-image does not support protocol conversion");
  }
}

function getDenormalizer(format: StreamFormat): Denormalizer {
  switch (format) {
    case "openai-chat":
      return denormalizeToOpenAIChatResponse;
    case "openai-responses":
      return denormalizeToOpenAIResponsesResponse;
    case "anthropic":
      return denormalizeToAnthropicResponse;
    case "openai-image":
      throw new Error("openai-image does not support protocol conversion");
  }
}

function extractModel(body: unknown): string | undefined {
  const b = body as Record<string, unknown>;
  return (b.model as string) ?? undefined;
}

function isStreamRequest(body: unknown): boolean {
  const b = body as Record<string, unknown>;
  return b.stream === true;
}

async function readImageRequestBody(c: Context) {
  const contentType = c.req.header("content-type") ?? "";
  const request = c.req.raw.clone();
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (contentType.toLowerCase().includes("multipart/form-data")) {
    const formData = await c.req.raw.clone().formData();
    const recorded: Record<string, unknown> = {};
    for (const [key, value] of formData.entries()) {
      const item = typeof File !== "undefined" && value instanceof File
        ? { type: "file", name: value.name, mediaType: value.type, size: value.size }
        : value;
      const current = recorded[key];
      if (current === undefined) {
        recorded[key] = item;
      } else if (Array.isArray(current)) {
        current.push(item);
      } else {
        recorded[key] = [current, item];
      }
    }
    return { bytes, recordedBody: recorded };
  }

  const text = new TextDecoder().decode(bytes);
  if (contentType.toLowerCase().includes("application/json")) {
    try {
      return { bytes, recordedBody: JSON.parse(text) };
    } catch {}
  }
  return { bytes, recordedBody: text };
}

function orange(message: string): string {
  return `${ORANGE}${message}${RESET}`;
}

function getCandidateModels(config: ServerConfig, primaryModel: string): ModelConfig[] {
  const pinned = jobRequestModels.get(getRequestId() ?? "");
  if (pinned?.name === primaryModel) return [pinned];
  const now = Date.now();
  const isFallbackGroup = primaryModel in config.fallback;
  if (isFallbackGroup) {
    return sortFallbackGroupMembers(resolveFallbackModels(config, primaryModel), (name) => fallbackFailureTracker.getFailureCount(name, now))
      .map((name) => resolveModel(config, name))
      .filter((model): model is ModelConfig => Boolean(model));
  }

  const match = resolveModelForRequest(config, primaryModel);
  return match ? [match.model] : [];
}

function recordModelAttempt(modelName: string, timestamp: number) {
  statusStore.recordAttempt(modelName, timestamp);
  usageStore.recordAttempt(modelName, timestamp);
}

function recordModelSuccess(
  modelName: string,
  durationMs: number,
  ttfbMs?: number,
  usage?: import("./src/converters/shared.js").NormalizedUsage,
  timestamp = Date.now(),
  streamDurationMs?: number,
) {
  statusStore.recordSuccess(modelName, durationMs, ttfbMs, usage, timestamp, streamDurationMs);
  usageStore.recordSuccess(modelName, durationMs, usage, timestamp);
}

function recordModelFailure(modelName: string, durationMs?: number, timestamp = Date.now()) {
  statusStore.recordFailure(modelName, durationMs, timestamp);
  usageStore.recordFailure(modelName, durationMs, timestamp);
}

async function executeModelRequest(
  modelConfig: ModelConfig,
  incomingFormat: StreamFormat,
  rawBody: Record<string, unknown>,
  stream: boolean,
  upstreamOptions: UpstreamOptions,
) {
  const sameFormat = incomingFormat === modelConfig.provider;

  if (sameFormat) {
    if (stream) {
      const { body, headers, timing } = await passthroughStreamRequest(modelConfig, rawBody, upstreamOptions);
      return { kind: "stream" as const, body, headers, upstreamFormat: modelConfig.provider, timing };
    }

    const { json, timing, usage } = await passthroughRequest(modelConfig, rawBody, upstreamOptions);
    return { kind: "json" as const, json, timing, usage };
  }

  const normalize = getNormalizer(incomingFormat);
  const denormalize = getDenormalizer(incomingFormat);
  const normalized = normalize(rawBody);

  if (stream) {
    const result = await forwardStreamRequest(modelConfig, normalized, upstreamOptions);
    return { kind: "stream" as const, ...result };
  }

  const { normalizedResponse, timing, usage } = await forwardRequest(modelConfig, normalized, upstreamOptions);
  return { kind: "json" as const, json: denormalize(normalizedResponse), timing, usage };
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
]);

function tryParseJSON(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const REPLAY_ALLOWED_PATHS = new Set(["/v1/chat/completions", "/v1/responses", "/v1/messages"]);
const REPLAY_PASSTHROUGH_HEADERS = new Set(["content-type", "user-agent"]);
const REPLAY_HEADER_OVERRIDES = new Set([
  "authorization",
  "cookie",
  "host",
  "content-length",
  "connection",
  "accept-encoding",
  "x-api-key",
  "x-nanollm-replay-of",
]);

function buildReplayHeaders(record: RecordEntry, authToken?: string): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(record.clientRequest.headers ?? {})) {
    const normalized = key.toLowerCase();
    if (REPLAY_HEADER_OVERRIDES.has(normalized) || !REPLAY_PASSTHROUGH_HEADERS.has(normalized)) continue;
    if (value === "[REDACTED]") continue;
    headers.set(key, value);
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  headers.set("x-nanollm-replay-of", record.requestId);
  if (authToken) {
    headers.set("authorization", `Bearer ${authToken}`);
  }
  return headers;
}

async function replayRecordedRequest(record: RecordEntry, config: ServerConfig) {
  const path = record.clientRequest.path;
  if (!REPLAY_ALLOWED_PATHS.has(path)) {
    return {
      ok: false as const,
      status: 400,
      body: { error: `Replay is not supported for path '${path}'` },
    };
  }
  if (record.clientRequest.status === "in_progress") {
    return {
      ok: false as const,
      status: 409,
      body: { error: "Cannot replay an in-progress request" },
    };
  }

  const replayRequestId = createRequestId();
  const headers = buildReplayHeaders(record, config.auth?.token);
  const response = await runWithRequestId(replayRequestId, async () => app.fetch(new Request(`http://127.0.0.1:${config.port}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(record.clientRequest.body ?? {}),
  })));
  const text = await response.text();
  const body = text ? tryParseJSON(text) : null;

  return {
    ok: response.ok,
    status: response.status,
    body,
    requestId: replayRequestId,
  };
}

const MODEL_TEST_RAW_LIMIT = 20000;

async function testConfiguredModel(name: string, message: string, config: ServerConfig) {
  const model = resolveModel(config, name);
  if (!model) {
    return { ok: false as const, status: 404, error: `模型 '${name}' 不在当前生效的配置中，请先保存配置。` };
  }
  if (model.provider === "openai-image") {
    return { ok: false as const, status: 400, error: "openai-image 模型不支持消息测试。" };
  }

  const { path, body } = buildModelTestRequest(model.provider, model.name, message);
  const headers = new Headers({ "content-type": "application/json" });
  if (!model.subscription_provider && !model.claude_subscription_provider) {
    headers.set("user-agent", "nanollm-admin-model-test");
  }
  if (config.auth?.token) headers.set("authorization", `Bearer ${config.auth.token}`);

  const requestId = createRequestId();
  const started = Date.now();
  const response = await runWithRequestId(requestId, async () => app.fetch(new Request(`http://127.0.0.1:${config.port}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })));
  const raw = await response.text();
  const durationMs = Date.now() - started;
  const isStream = (response.headers.get("content-type") ?? "").includes("text/event-stream");
  const reply = response.ok && isStream ? extractModelTestReply(model.provider, raw) : "";
  const errorBody = response.ok ? undefined : (raw ? tryParseJSON(raw) : null);

  return {
    ok: response.ok,
    status: response.status,
    requestId,
    provider: model.provider,
    upstreamModel: model.model,
    durationMs,
    reply,
    error: response.ok ? undefined : (errorBody?.error?.message ?? errorBody?.error ?? `HTTP ${response.status}`),
    raw: raw.length > MODEL_TEST_RAW_LIMIT ? raw.slice(0, MODEL_TEST_RAW_LIMIT) + "\n...(truncated)" : raw,
  };
}

async function buildStatusPayload(config: ServerConfig, c?: Context) {
  const availableWindows = [1, 3, 6];
  const now = Date.now();
  const modelNames = await statusStore.listModelNames(now);
  return {
    availableWindows,
    defaultWindowHours: 1,
    refreshedAt: now,
    bucketStarts: statusStore.listBuckets(),
    models: await Promise.all(modelNames.map(async (modelName) => ({
      name: modelName,
      series: await statusStore.getModelSeries(modelName, now),
    }))),
    fallbackGroups: Object.entries(config.fallback).map(([name, members]) => ({
      name,
      members: sortFallbackGroupMembers(members, (memberName) => fallbackFailureTracker.getFailureCount(memberName, now)),
    })),
    usage: await buildUsagePayload(c, config, { basePath: "/status", now }),
  };
}

function toUsageYear(value: unknown, now = Date.now()): number {
  const currentYear = new Date(now).getFullYear();
  const year = typeof value === "string" && /^\d{4}$/.test(value) ? Number(value) : currentYear;
  if (!Number.isInteger(year) || year < 2000 || year > currentYear + 1) return currentYear;
  return year;
}

function buildUsageRange(year: number, now = Date.now()) {
  const currentYear = new Date(now).getFullYear();
  const start = `${year}-01-01`;
  const end = year === currentYear ? formatLocalDay(now) : `${year}-12-31`;
  return { start, end };
}

function normalizeUsageRangeMode(value: unknown): "7d" | "30d" | "year" {
  return value === "7d" || value === "30d" ? value : "year";
}

function buildRecentUsageRange(days: number, now = Date.now()) {
  const end = formatLocalDay(now);
  const start = addLocalDays(end, -(days - 1));
  return { start, end };
}

function normalizeUsageDayRange(rawStart: unknown, rawEnd: unknown, year: number, rangeMode: "7d" | "30d" | "year", now = Date.now()) {
  if (rangeMode === "7d") return buildRecentUsageRange(7, now);
  if (rangeMode === "30d") return buildRecentUsageRange(30, now);
  const defaultRange = buildUsageRange(year, now);
  const start = typeof rawStart === "string" && parseLocalDay(rawStart) ? rawStart : defaultRange.start;
  const end = typeof rawEnd === "string" && parseLocalDay(rawEnd) ? rawEnd : defaultRange.end;
  return start <= end ? { start, end } : defaultRange;
}

async function buildUsagePayload(c: Context | undefined, config: ServerConfig, options?: { basePath?: string; now?: number }) {
  const now = options?.now ?? Date.now();
  const selectedRange = normalizeUsageRangeMode(c?.req.query("range"));
  const selectedYear = selectedRange === "year" ? toUsageYear(c?.req.query("year"), now) : null;
  const queryYear = selectedYear ?? new Date(now).getFullYear();
  const range = normalizeUsageDayRange(c?.req.query("start"), c?.req.query("end"), queryYear, selectedRange, now);
  const modelQuery = c?.req.query("model") || undefined;
  const configuredModels = new Map(config.models.map((model) => [model.name, model]));
  const historicalModelNames = await usageStore.listModelNames(range);
  const modelNames = [...new Set([...config.models.map((model) => model.name), ...historicalModelNames])].sort();
  const selectedModel = modelQuery && modelNames.includes(modelQuery) ? modelQuery : undefined;
  const usageModelNames = selectedModel ? [selectedModel] : modelNames;
  const modelUsage = await Promise.all(usageModelNames.map(async (modelName) => {
    const days = await usageStore.listDays({ ...range, modelName });
    const metrics = days.reduce((total, day) => ({
      day: range.end,
      totalRequests: total.totalRequests + day.totalRequests,
      successRequests: total.successRequests + day.successRequests,
      failureRequests: total.failureRequests + day.failureRequests,
      totalDurationMs: total.totalDurationMs + day.totalDurationMs,
      durationSamples: total.durationSamples + day.durationSamples,
      nonCacheInputTokens: total.nonCacheInputTokens + day.nonCacheInputTokens,
      cacheWriteInputTokens: total.cacheWriteInputTokens + day.cacheWriteInputTokens,
      cacheReadInputTokens: total.cacheReadInputTokens + day.cacheReadInputTokens,
      outputTokens: total.outputTokens + day.outputTokens,
      totalTokens: total.totalTokens + day.totalTokens,
    }));
    return { name: modelName, upstreamModel: configuredModels.get(modelName)?.model ?? modelName, metrics };
  }));

  return {
    refreshedAt: now,
    ...range,
    selectedYear,
    selectedRange,
    availableYears: getUsageYears(now),
    selectedModel: selectedModel ?? null,
    models: modelNames,
    modelUsage,
    basePath: options?.basePath,
    days: await usageStore.listDays({ ...range, modelName: selectedModel }),
  };
}

async function buildRecordQueryPayload(requestIdOrPrefix: string) {
  const [record, summary] = await Promise.all([
    getRecordedRequest(requestIdOrPrefix),
    getRecordSummary(),
  ]);
  return {
    summary,
    ...(record ? { record } : {}),
  };
}

function buildConfigAdminPayload() {
  const snapshot = configManager.getActiveSnapshot();
  let form: AdminConfigForm;
  try {
    form = buildAdminConfigForm(snapshot.rawText);
  } catch {
    form = buildAdminConfigFormFromEffectiveConfig(snapshot.effectiveConfig);
  }
  return {
    ...snapshot,
    configPath,
    form,
  };
}

// ─── Route Factory ──────────────────────────────────────────────────────────

function createRoute(incomingFormat: StreamFormat) {
  return async (c) => {
    const snapshot = configManager.getActiveSnapshot();
    const config = snapshot.effectiveConfig;
    const userAgent = c.req.header("user-agent");
    const upstreamOptions = { userAgent };
    const rawBody = await c.req.json();
    const modelName = extractModel(rawBody);
    const stream = isStreamRequest(rawBody);
    const requestId = getRequestId();
    if (requestId) {
      beginRecordedRequest({
        requestId,
        path: c.req.path,
        headers: c.req.raw.headers,
        body: rawBody,
        stream,
      });
    }

    if (!modelName) {
      const response = c.json({ error: "Missing 'model' in request body" }, 400);
      setRecordedRequestError({ message: "Missing 'model' in request body" });
      setRecordedClientResponseMeta({ status: response.status, headers: response.headers });
      setRecordedClientResponseBody({ body: { error: "Missing 'model' in request body" } });
      finalizeRecordedRequest({});
      return response;
    }

    const candidateModels = getCandidateModels(config, modelName);
    if (candidateModels.length === 0) {
      const errorBody = { error: `Model '${modelName}' not found in config`, available: getPublicModelNames(config) };
      const response = c.json(errorBody, 404);
      setRecordedRequestError({ message: errorBody.error });
      setRecordedClientResponseMeta({ status: response.status, headers: response.headers });
      setRecordedClientResponseBody({ body: errorBody });
      finalizeRecordedRequest({});
      return response;
    }

    // Resolve item_reference for Responses API requests
    if (incomingFormat === "openai-responses" && Array.isArray(rawBody.input)) {
      rawBody.input = resolveItemReferences(rawBody.input);
    }

    let lastError: (Error & { status?: number; upstream?: string; cause?: unknown }) | undefined;

    try {
      for (const [candidateIndex, modelConfig] of candidateModels.entries()) {
        const requestStartedAt = Date.now();
        recordModelAttempt(modelConfig.name, requestStartedAt);
        console.log(
          withRequestId(
            `[REQUEST] model=${modelName} path=${c.req.path} target=${getUpstreamURL(modelConfig)} candidate=${modelConfig.name}`,
          ),
        );

        try {
          const result = await executeModelRequest(modelConfig, incomingFormat, rawBody, stream, {
            ...upstreamOptions,
            attemptIndex: candidateIndex + 1,
            modelName: modelConfig.name,
          });

          if (result.kind === "stream") {
            const { body, upstreamFormat, timing } = result;

            const responseHeaders: Record<string, string> = {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              "X-Accel-Buffering": "no",
            };

            if (upstreamFormat === incomingFormat && "headers" in result) {
              for (const [key, value] of result.headers.entries()) {
                if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
                  responseHeaders[key] = value;
                }
              }
            }

            const readable = buildStreamReadable(
              body,
              incomingFormat,
              upstreamFormat,
              c.req.path,
              modelConfig.name,
              timing,
              candidateIndex + 1,
              rawBody.store !== false,
            );

            const response = new Response(readable, { headers: responseHeaders });
            setRecordedClientResponseMeta({ status: response.status, headers: response.headers });
            return response;
          }

          recordModelSuccess(modelConfig.name, Date.now() - requestStartedAt, result.timing.ttfbMs, result.usage, requestStartedAt);
          if (shouldCacheResponseItems(incomingFormat, rawBody.store)) {
            cacheResponseItems((result.json as any)?.output);
          }
          const response = buildJsonResponse(c.req.raw.headers, result.json);
          setRecordedClientResponseMeta({ status: response.status, headers: response.headers });
          setRecordedClientResponseBody({ body: result.json });
          finalizeRecordedRequest({});
          return response;
        } catch (error) {
          const err = error as Error & { status?: number; upstream?: string; cause?: unknown };
          // Content the converter refuses (e.g. files across protocols) is the request's fault, not the model's:
          // don't demote the model in its fallback group, but still let a same-protocol candidate try.
          if (!(error instanceof UnsupportedContentError)) fallbackFailureTracker.recordFailure(modelConfig.name, requestStartedAt);
          recordModelFailure(modelConfig.name, Date.now() - requestStartedAt, requestStartedAt);
          lastError = err;
          console.warn(
            orange(
              withRequestId(
                `[MODEL FAILED] requested=${modelName} candidate=${modelConfig.name} path=${c.req.path} target=${getUpstreamURL(modelConfig)} message=${formatErrorWithCauses(err)}`,
              ),
            ),
          );
          if (modelConfig.name !== candidateModels.at(-1)?.name) {
            console.warn(orange(withRequestId(`[FALLBACK] ${modelConfig.name} failed, trying next candidate`)));
          }
        }
      }
    } catch (error) {
      lastError = error as Error & { status?: number; upstream?: string; cause?: unknown };
    }

    if (lastError) {
      console.error(orange(withRequestId(`[proxy error] ${lastError.message}`)), lastError.cause ?? "");
      const status = lastError.status || 500;
      const causes = extractErrorCauses(lastError);
      setRecordedRequestError({ message: lastError.message || "Request failed", causes });
      const errorBody = {
        error: lastError.message || "Request failed",
        ...(causes.length ? { causes } : {}),
        ...(lastError.upstream ? { upstream: tryParseJSON(lastError.upstream) } : {}),
      };
      const response = c.json(errorBody, status);
      setRecordedClientResponseMeta({ status: response.status, headers: response.headers });
      setRecordedClientResponseBody({ body: errorBody });
      finalizeRecordedRequest({});
      return response;
    }

    setRecordedRequestError({ message: "Request failed" });
    const response = c.json({ error: "Request failed" }, 500);
    setRecordedClientResponseMeta({ status: response.status, headers: response.headers });
    setRecordedClientResponseBody({ body: { error: "Request failed" } });
    finalizeRecordedRequest({});
    return response;
  };
}

function createAlphaSearchRoute() {
  return async (c) => {
    const config = configManager.getActiveSnapshot().effectiveConfig;
    const rawBody = await c.req.json();
    const modelName = extractModel(rawBody);
    if (!modelName) return c.json({ error: "Missing 'model' in request body" }, 400);
    const candidateModels = getCandidateModels(config, modelName);
    if (candidateModels.length === 0) return c.json({ error: `Model '${modelName}' not found in config`, available: getPublicModelNames(config) }, 404);
    const requestId = getRequestId();
    const stream = isStreamRequest(rawBody);
    if (requestId) beginRecordedRequest({ requestId, path: c.req.path, headers: c.req.raw.headers, body: rawBody, stream });
    let lastError;
    for (const [candidateIndex, modelConfig] of candidateModels.entries()) {
      const started = Date.now();
      recordModelAttempt(modelConfig.name, started);
      try {
        const result = await passthroughAlphaSearchRequest(modelConfig, rawBody, { userAgent: c.req.header("user-agent"), attemptIndex: candidateIndex + 1, modelName: modelConfig.name });
        if (result.status >= 400) {
          const error = Object.assign(new Error(`Upstream ${result.status}: ${result.responseText}`), { status: result.status, upstream: result.responseText });
          throw error;
        }
        recordModelSuccess(modelConfig.name, Date.now() - started, result.timing.ttfbMs);
        const headers = new Headers(result.headers);
        headers.delete("content-encoding");
        headers.delete("content-length");
        const response = new Response(result.responseText, { status: result.status, headers });
        if (requestId) { setRecordedClientResponseMeta({ status: response.status, headers: response.headers }); setRecordedClientResponseBody({ body: result.body }); finalizeRecordedRequest({}); }
        return response;
      } catch (error) {
        recordModelFailure(modelConfig.name, Date.now() - started, started);
        lastError = error;
      }
    }
    const err = lastError as Error & { status?: number; upstream?: string };
    const status = err?.status || 500;
    const body = { error: err?.message || "Request failed", ...(err?.upstream ? { upstream: tryParseJSON(err.upstream) } : {}) };
    if (requestId) { setRecordedRequestError({ message: body.error }); setRecordedClientResponseMeta({ status, headers: new Headers({ "content-type": "application/json" }) }); setRecordedClientResponseBody({ body }); finalizeRecordedRequest({}); }
    return c.json(body, status);
  };
}

function createImageRoute(imageOperation: OpenAIImageOperation) {
  return async (c: Context) => {
    const snapshot = configManager.getActiveSnapshot();
    const config = snapshot.effectiveConfig;
    const userAgent = c.req.header("user-agent");
    const upstreamOptions = { userAgent };
    const { bytes, recordedBody } = await readImageRequestBody(c);
    const modelName = extractModel(recordedBody);
    const requestId = getRequestId();
    if (requestId) {
      beginRecordedRequest({
        requestId,
        path: c.req.path,
        headers: c.req.raw.headers,
        body: recordedBody,
        stream: false,
      });
    }

    if (!modelName) {
      const response = c.json({ error: "Missing 'model' in request body" }, 400);
      setRecordedRequestError({ message: "Missing 'model' in request body" });
      setRecordedClientResponseMeta({ status: response.status, headers: response.headers });
      setRecordedClientResponseBody({ body: { error: "Missing 'model' in request body" } });
      finalizeRecordedRequest({});
      return response;
    }

    const candidateModels = getCandidateModels(config, modelName);
    if (candidateModels.length === 0) {
      const errorBody = { error: `Model '${modelName}' not found in config`, available: getPublicModelNames(config) };
      const response = c.json(errorBody, 404);
      setRecordedRequestError({ message: errorBody.error });
      setRecordedClientResponseMeta({ status: response.status, headers: response.headers });
      setRecordedClientResponseBody({ body: errorBody });
      finalizeRecordedRequest({});
      return response;
    }

    let lastError: (Error & { status?: number; upstream?: string; cause?: unknown }) | undefined;

    try {
      for (const [candidateIndex, modelConfig] of candidateModels.entries()) {
        const requestStartedAt = Date.now();
        recordModelAttempt(modelConfig.name, requestStartedAt);
        console.log(
          withRequestId(
            `[REQUEST] model=${modelName} path=${c.req.path} target=${getUpstreamURL(modelConfig)} candidate=${modelConfig.name}`,
          ),
        );

        try {
          if (modelConfig.provider !== "openai-image") {
            throw Object.assign(new Error(`Model '${modelConfig.name}' provider '${modelConfig.provider}' cannot handle image requests`), {
              status: 400,
            });
          }

          const result = await passthroughRawRequest(
            modelConfig,
            bytes,
            c.req.raw.headers,
            {
              ...upstreamOptions,
              attemptIndex: candidateIndex + 1,
              modelName: modelConfig.name,
              imageOperation,
              recordedRequestBody: recordedBody,
            },
          );
          recordModelSuccess(modelConfig.name, Date.now() - requestStartedAt, result.timing.ttfbMs, undefined, requestStartedAt);

          const responseHeaders: Record<string, string> = {};
          for (const [key, value] of result.headers.entries()) {
            if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
              responseHeaders[key] = value;
            }
          }
          const response = buildNonStreamResponse(c.req.raw.headers, result.responseText, { status: result.status, headers: responseHeaders });
          setRecordedClientResponseMeta({ status: response.status, headers: response.headers });
          setRecordedClientResponseBody({ body: result.body });
          finalizeRecordedRequest({});
          return response;
        } catch (error) {
          const err = error as Error & { status?: number; upstream?: string; cause?: unknown };
          fallbackFailureTracker.recordFailure(modelConfig.name, requestStartedAt);
          recordModelFailure(modelConfig.name, Date.now() - requestStartedAt, requestStartedAt);
          lastError = err;
          console.warn(
            orange(
              withRequestId(
                `[MODEL FAILED] requested=${modelName} candidate=${modelConfig.name} path=${c.req.path} target=${getUpstreamURL(modelConfig)} message=${formatErrorWithCauses(err)}`,
              ),
            ),
          );
        }
      }

      if (lastError) {
        const causes = extractErrorCauses(lastError);
        setRecordedRequestError({ message: lastError.message, causes });
        const status = lastError.status && lastError.status >= 400 && lastError.status < 600 ? lastError.status : 502;
        const errorBody = {
          error: lastError.message,
          ...(causes.length ? { causes } : {}),
          ...(lastError.upstream ? { upstream: lastError.upstream } : {}),
        };
        const response = c.json(errorBody, status);
        setRecordedClientResponseMeta({ status: response.status, headers: response.headers });
        setRecordedClientResponseBody({ body: errorBody });
        finalizeRecordedRequest({});
        return response;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRecordedRequestError({ message });
      const response = c.json({ error: message }, 500);
      setRecordedClientResponseMeta({ status: response.status, headers: response.headers });
      setRecordedClientResponseBody({ body: { error: message } });
      finalizeRecordedRequest({});
      return response;
    }

    setRecordedRequestError({ message: "Request failed" });
    const response = c.json({ error: "Request failed" }, 500);
    setRecordedClientResponseMeta({ status: response.status, headers: response.headers });
    setRecordedClientResponseBody({ body: { error: "Request failed" } });
    finalizeRecordedRequest({});
    return response;
  };
}

function buildStreamReadable(
  body: ReadableStream<Uint8Array>,
  incomingFormat: StreamFormat,
  upstreamFormat: StreamFormat,
  path: string,
  modelName: string,
  timing: { startedAt: number; ttfbMs: number },
  attemptIndex: number,
  storeResponseItems: boolean,
): ReadableStream<Uint8Array> {
  return buildManagedStream(
    body,
    path,
    modelName,
    timing,
    upstreamFormat,
    attemptIndex,
    {
      converter: upstreamFormat !== incomingFormat ? createSSEConverter(upstreamFormat, incomingFormat) : undefined,
      cacheResponseItems: shouldCacheResponseItems(incomingFormat, storeResponseItems),
    },
  );
}

/**
 * Manages every upstream SSE stream through one lifecycle: optional protocol
 * conversion, usage collection, recording, cancellation, and Responses item caching.
 */
function buildManagedStream(
  body: ReadableStream<Uint8Array>,
  path: string,
  modelName: string,
  timing: { startedAt: number; ttfbMs: number },
  streamFormat: StreamFormat,
  attemptIndex: number,
  options: {
    converter?: ReturnType<typeof createSSEConverter>;
    cacheResponseItems: boolean;
  },
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const itemCollector = options.cacheResponseItems ? new SSEParser() : undefined;
  const usageCollector = createUsageCollector(streamFormat);
  const outputItems: unknown[] = [];
  const encoder = new TextEncoder();
  const started = Date.now();
  let cancelled = false;
  let finished = false;
  let successRecorded = false;
  let recordFinalized = false;
  const cachedRequestId = getRequestId();
  let cancelPromise: Promise<void> | undefined;

  function collectItems(sseText: string) {
    if (!itemCollector) return;
    for (const { data } of itemCollector.push(sseText)) {
      try {
        const event = JSON.parse(data);
        if (event.type === "response.output_item.done" && event.item) {
          outputItems.push(event.item);
        }
      } catch {}
    }
  }

  function settleSuccess(usage?: import("./src/converters/shared.js").NormalizedUsage) {
    if (successRecorded) return;
    successRecorded = true;
    const totalDuration = Date.now() - timing.startedAt; const streamDuration = totalDuration - timing.ttfbMs; recordModelSuccess(modelName, totalDuration, timing.ttfbMs, usage, timing.startedAt, streamDuration);
  }

  function finalizeRecord() {
    if (recordFinalized) return;
    recordFinalized = true;
    finalizeRecordedRequest({});
  }

  function closeAfterTerminalEvent(controller: ReadableStreamDefaultController<Uint8Array>): boolean {
    if (!usageCollector.hasCompleted()) return false;
    finished = true;
    if (options.cacheResponseItems) cacheResponseItems(outputItems);
    settleSuccess(usageCollector.getLatestUsage());
    finalizeRecord();
    console.log(withRequestId(`[HTTP STREAM END] path=${path} duration=${Date.now() - started}ms (terminal event)`));
    controller.close();
    void reader.cancel("terminal SSE event received").catch((error) => {
      console.warn(withRequestId(`[HTTP STREAM CANCEL ERROR] path=${path} duration=${Date.now() - started}ms`, cachedRequestId), error);
    });
    return true;
  }

  return new ReadableStream({
    async pull(controller) {
      if (finished) return;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            finished = true;
            if (cancelled) return;
            if (options.converter) {
              for (const chunk of options.converter.flush()) {
                const outboundText = typeof chunk === "string" ? chunk : decoder.decode(chunk);
                collectItems(outboundText);
                appendRecordedClientResponseBody({ chunk: outboundText });
                controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
              }
            }
            if (itemCollector) {
              for (const { data } of itemCollector.flush()) {
                try {
                  const event = JSON.parse(data);
                  if (event.type === "response.output_item.done" && event.item) {
                    outputItems.push(event.item);
                  }
                } catch {}
              }
            }
            if (options.cacheResponseItems) cacheResponseItems(outputItems);
            if (usageCollector.hasFailed()) {
              throw new Error("Upstream stream reported an error");
            }
            const usage = usageCollector.finish();
            settleSuccess(usage);
            finalizeRecord();
            console.log(withRequestId(`[HTTP STREAM END] path=${path} duration=${Date.now() - started}ms`));
            controller.close();
            return;
          }

          const text = decoder.decode(value, { stream: true });
          appendRecordedAttemptResponseBody({ index: attemptIndex, chunk: text });
          usageCollector.push(text);
          if (options.converter) {
            for (const chunk of options.converter.push(text)) {
              if (cancelled) return;
              const outboundText = typeof chunk === "string" ? chunk : decoder.decode(chunk);
              collectItems(outboundText);
              appendRecordedClientResponseBody({ chunk: outboundText });
              controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
            }
          } else {
            if (cancelled) return;
            collectItems(text);
            appendRecordedClientResponseBody({ chunk: text });
            controller.enqueue(value);
          }
          if (closeAfterTerminalEvent(controller)) return;
        }
      } catch (error) {
        finished = true;
        const completed = usageCollector.hasCompleted();
        if (shouldIgnoreStreamReadError(error, { cancelled, completed })) {
          if (completed) {
            settleSuccess(usageCollector.getLatestUsage());
            finalizeRecord();
            console.log(withRequestId(`[HTTP STREAM END] path=${path} duration=${Date.now() - started}ms (reader released after completion)`));
            try {
              controller.close();
            } catch {}
          }
          return;
        }
        recordModelFailure(modelName, Date.now() - timing.startedAt, timing.startedAt);
        finalizeRecord();
        console.error(orange(withRequestId(`[HTTP STREAM ERROR] path=${path} duration=${Date.now() - started}ms`)), error);
        controller.error(error);
      }
    },
    cancel(reason) {
      if (cancelled || finished) return cancelPromise;
      cancelled = true;
      if (usageCollector.hasCompleted()) {
        settleSuccess(usageCollector.getLatestUsage());
        finalizeRecord();
        console.log(withRequestId(`[HTTP STREAM END] path=${path} duration=${Date.now() - started}ms (client closed after completion)`, cachedRequestId));
      } else {
        finalizeRecord();
        console.warn(withRequestId(`[HTTP STREAM CANCEL] path=${path} duration=${Date.now() - started}ms`, cachedRequestId));
      }
      cancelPromise = reader.cancel(reason).catch((error) => {
        console.warn(withRequestId(`[HTTP STREAM CANCEL ERROR] path=${path} duration=${Date.now() - started}ms`, cachedRequestId), error);
      });
      return cancelPromise;
    },
  });
}

// ─── Routes ─────────────────────────────────────────────────────────────────

app.get("/", (c) => {
  const config = configManager.getActiveSnapshot().effectiveConfig;
  return c.json({
    ok: true,
    message: "nanollm gateway",
    models: getPublicModelNames(config).map((name) => ({
      name,
      provider: config.fallback[name] ? "fallback-group" : resolveModel(config, name)?.provider,
      model: config.fallback[name] ? config.fallback[name] : resolveModel(config, name)?.model,
    })),
    endpoints: {
      health: "GET /health",
      record: "GET /record",
      recordSummary: "GET /record/summary",
      recordQuery: "GET /record/{requestId}",
      admin: "GET /admin",
      chat: "POST /v1/chat/completions",
      responses: "POST /v1/responses",
      alphaSearch: "POST /v1/alpha/search",
      messages: "POST /v1/messages",
      imageGenerations: "POST /v1/images/generations",
      imageEdits: "POST /v1/images/edits",
    },
  });
});

app.get("/health", (c) => c.json({ ok: true }));

app.get("/status", async (c) => c.html(renderStatusPage(await buildStatusPayload(configManager.getActiveSnapshot().effectiveConfig, c))));
app.get("/status/data", async (c) => c.json(await buildStatusPayload(configManager.getActiveSnapshot().effectiveConfig, c)));
app.get("/record", async (c) => c.html(renderRecordPage(await getRecordSummary())));
app.get("/record/summary", async (c) => c.json(await getRecordSummary()));
app.get("/record/:requestId", async (c) => {
  const requestId = c.req.param("requestId");
  const payload = await buildRecordQueryPayload(requestId);
  if (!payload.record) {
    return c.json({ error: `Record '${requestId.slice(0, 6)}' not found`, summary: payload.summary }, 404);
  }
  return c.json(payload);
});
app.get("/record/images/:hash", async (c) => {
  const hash = c.req.param("hash");
  if (!/^[a-f0-9]{64}$/i.test(hash)) {
    return c.json({ error: "Invalid image hash" }, 400);
  }
  const dataUrl = await getRecordedImage(hash);
  if (!dataUrl) {
    return c.json({ error: "Recorded image not found" }, 404);
  }
  const match = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(dataUrl);
  if (!match) {
    return c.json({ error: "Recorded image is invalid" }, 500);
  }
  return c.body(Buffer.from(match[2], "base64"), 200, {
    "Content-Type": match[1],
    "Content-Disposition": `inline; filename="recorded-image-${hash.slice(0, 12)}"`,
    "Cache-Control": "private, no-store",
  });
});
app.post("/record/:requestId/replay", async (c) => {
  const requestId = c.req.param("requestId");
  const record = await getRecordedRequest(requestId, { hydrateImages: true });
  if (!record) {
    return c.json({ error: `Record '${requestId.slice(0, 6)}' not found`, summary: await getRecordSummary() }, 404);
  }

  const result = await replayRecordedRequest(record, configManager.getActiveSnapshot().effectiveConfig);
  return c.json({
    ...result,
    replayOf: record.requestId,
    summary: await getRecordSummary(),
    note: "Sensitive client headers are not replayed; provider auth uses current config.",
  }, result.status);
});

app.get("/admin", (c) => c.html(renderAdminConfigPage(buildConfigAdminPayload())));
app.get("/jobs", (c) => c.html(renderJobsPage()));
app.route("/jobs/api", createJobRoutes(jobScheduler,
  () => configManager.getActiveSnapshot().effectiveConfig.models, storageMode, jobModelCatalog));
app.post("/admin/providers/:name/device-login", async (c) => {
  try {
    const provider = configManager.getActiveSnapshot().effectiveConfig.providers.find((item) => item.name === c.req.param("name"));
    if (!provider || provider.provider !== "openai-subscription") {
      return c.json({ error: "OpenAI subscription provider not found; save the provider configuration first" }, 404);
    }
    return c.json(await startDeviceLogin(provider));
  }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
});
app.post("/admin/providers/:name/claude-login", (c) => {
  try {
    const provider = configManager.getActiveSnapshot().effectiveConfig.providers.find((item) => item.name === c.req.param("name"));
    if (!provider || provider.provider !== "claude-subscription") {
      return c.json({ error: "Claude subscription provider not found; save the provider configuration first" }, 404);
    }
    return c.json(startClaudeLogin(provider));
  }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
});
app.post("/admin/providers/:name/claude-login/:sessionId/complete", async (c) => {
  try {
    let body: { callback?: unknown } = {};
    try { body = await c.req.json(); } catch {}
    return c.json(await completeClaudeLogin(c.req.param("sessionId"), typeof body.callback === "string" ? body.callback : ""));
  }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
});
app.get("/admin/providers/:name/device-login/status", (c) => {
  const name = c.req.param("name");
  const provider = configManager.getActiveSnapshot().effectiveConfig.providers.find((item) => item.name === name);
  const credential = provider?.provider === "claude-subscription" ? getCachedClaudeSubscriptionCredential(name) : getCachedSubscriptionCredential(name);
  return c.json({ authenticated: Boolean(credential?.accessToken && credential.expiresAt > Date.now()), expiresAt: credential?.expiresAt ?? null });
});
app.get("/admin/providers/:name/usage", async (c) => {
  try {
    const name = c.req.param("name");
    const provider = configManager.getActiveSnapshot().effectiveConfig.providers.find((item) => item.name === name);
    if (provider?.provider === "claude-subscription") return c.json(await fetchClaudeSubscriptionUsage(name, provider.proxy));
    if (!provider || provider.provider !== "openai-subscription") {
      return c.json({ error: "Subscription provider not found" }, 404);
    }
    return c.json(await fetchSubscriptionUsage(name, provider.proxy));
  }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
});
app.post("/admin/providers/:name/usage/reset", async (c) => {
  try {
    const name = c.req.param("name");
    const provider = configManager.getActiveSnapshot().effectiveConfig.providers.find((item) => item.name === name);
    if (!provider || provider.provider !== "openai-subscription") return c.json({ error: "OpenAI subscription provider not found" }, 404);
    return c.json(await resetSubscriptionUsage(name, provider.proxy));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
app.post("/admin/providers/:name/device-login/:sessionId/poll", async (c) => {
  try { return c.json(await pollDeviceLogin(c.req.param("sessionId"))); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
});
app.get("/admin/config", (c) => {
  const token = c.req.query("token");
  const target = token ? `/admin?token=${encodeURIComponent(token)}` : "/admin";
  return c.redirect(target, 302);
});
app.get("/admin/config/data", (c) => c.json(buildConfigAdminPayload()));
app.post("/admin/models/:name/test", async (c) => {
  let body: { message?: unknown } = {};
  try { body = await c.req.json(); } catch {}
  const message = typeof body.message === "string" && body.message.trim() ? body.message : DEFAULT_MODEL_TEST_MESSAGE;
  try {
    const result = await testConfiguredModel(c.req.param("name"), message, configManager.getActiveSnapshot().effectiveConfig);
    return c.json(result, result.ok ? 200 : result.status);
  } catch (error) {
    return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
app.get("/admin/providers/:name/models", async (c) => {
  try {
    const name = c.req.param("name");
    const provider = configManager.getActiveSnapshot().effectiveConfig.providers.find((item) => item.name === name);
    if (provider?.provider === "claude-subscription") {
      const identityHeaders: Record<string, string> = {};
      applyClaudeSubscriptionHeaders(identityHeaders);
      return c.json({ ok: true, models: await fetchClaudeSubscriptionModels(name, provider.proxy, identityHeaders) });
    }
    if (provider?.provider === "openai-subscription") return c.json({ ok: true, models: await fetchSubscriptionModels(name, provider.proxy) });
    return c.json({ ok: false, error: "订阅供应商不在当前生效的配置中，请先保存配置。" }, 404);
  } catch (error) {
    return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
app.post("/admin/upstream-models", async (c) => {
  let body: Record<string, unknown> = {};
  try { body = await c.req.json(); } catch {}
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  try {
    const models = await fetchUpstreamModels({
      provider: text(body.provider),
      base_url: text(body.base_url),
      api_key: text(body.api_key),
      proxy: text(body.proxy),
    });
    return c.json({ ok: true, models });
  } catch (error) {
    return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
app.post("/admin/config/apply", async (c) => {
  let body: { config?: unknown; baseVersion?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body", currentSnapshot: buildConfigAdminPayload() }, 400);
  }

  if (!body.config || typeof body.config !== "object" || Array.isArray(body.config)) {
    return c.json({ error: "Field 'config' must be an object", currentSnapshot: buildConfigAdminPayload() }, 400);
  }
  if (!Number.isInteger(body.baseVersion)) {
    return c.json({ error: "Field 'baseVersion' must be an integer", currentSnapshot: buildConfigAdminPayload() }, 400);
  }

  const currentSnapshot = configManager.getActiveSnapshot();
  if (body.baseVersion !== currentSnapshot.version) {
    return c.json({ error: "Config version conflict", currentSnapshot: buildConfigAdminPayload() }, 409);
  }

  let yamlText: string;
  try {
    const currentForm = buildAdminConfigForm(currentSnapshot.rawText);
    yamlText = buildYamlTextFromAdminForm(body.config as AdminConfigForm, {
      preservedPort: currentForm.server.port,
    });
    parseConfigText(yamlText);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : String(error),
        currentSnapshot: buildConfigAdminPayload(),
      },
      400,
    );
  }

  try {
    writeConfigAtomic(configPath, yamlText);
    const result = configManager.applyText(yamlText, "ui");
    return c.json({
      ok: true,
      snapshot: buildConfigAdminPayload(),
      appliedFields: result.appliedFields,
      requiresRestartFields: result.requiresRestartFields,
    });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : String(error),
        currentSnapshot: buildConfigAdminPayload(),
      },
      500,
    );
  }
});

app.get("/v1/models", (c) => {
  const config = configManager.getActiveSnapshot().effectiveConfig;
  return c.json({
    object: "list",
    data: getPublicModelNames(config).map((name) => ({
      id: name,
      object: "model",
      owned_by: config.fallback[name] ? "fallback-group" : resolveModel(config, name)?.provider,
    })),
  });
});

app.post("/v1/chat/completions", createRoute("openai-chat"));
app.post("/v1/responses", createRoute("openai-responses"));
app.post("/v1/alpha/search", createAlphaSearchRoute());
app.post("/alpha/search", createAlphaSearchRoute());
app.post("/v1/messages", createRoute("anthropic"));
app.post("/v1/images/generations", createImageRoute("generations"));
app.post("/v1/images/edits", createImageRoute("edits"));

// ─── Start ──────────────────────────────────────────────────────────────────

const startupConfig = startupSnapshot.effectiveConfig;
const server = serve({ fetch: app.fetch, port: startupConfig.port }, (info) => {
  console.log(`nanollm gateway listening on http://localhost:${info.port}`);
  console.log(`Storage: ${storageMode}${sqliteStorage ? ` (${sqliteStorage.driver}: ${sqliteStorage.location})` : ""}`);
  console.log(`Models: ${startupConfig.models.map((m) => m.name).join(", ") || "(none)"}`);
  console.log(
    `Fallback groups: ${
      Object.entries(startupConfig.fallback)
        .map(([group, models]) => `${group}=[${models.join(", ")}]`)
        .join("; ") || "(none)"
    }`,
  );
});

server.once("error", (error: Error & { code?: string }) => {
  handleServerStartupError(error, {
    port: startupConfig.port,
    dispose: () => { configManager.dispose(); jobScheduler.stop(); },
  });
});

const shutdown = installGracefulShutdown({
  server,
  stopBackgroundWork: () => { configManager.dispose(); jobScheduler.stop(); },
  cleanup: async () => {
    await jobScheduler.flush();
    if (sqliteStorage) await waitForClientWrites(sqliteStorage.client);
    await flushRecording();
    if (sqliteStorage) {
      await waitForClientWrites(sqliteStorage.client);
      sqliteStorage.client.close();
    }
  },
});

jobScheduler.start();

export { server };
