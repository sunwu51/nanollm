// @ts-nocheck
import "dotenv/config";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { randomUUID } from "node:crypto";
import type { ModelConfig, ServerConfig } from "./src/config.js";
import { getPublicModelNames, parseConfigText, parseSourceConfigDocument, resolveFallbackModels, resolveModel, resolveModelForRequest } from "./src/config.js";
import { ConfigManager } from "./src/config-manager.js";
import { getUpstreamURL } from "./src/proxy.js";
import { forwardRequest, forwardStreamRequest, passthroughRequest, passthroughStreamRequest } from "./src/proxy.js";
import { sortFallbackGroupMembers } from "./src/fallback.js";
import { SqliteStatusStore, StatusStore, type StatusStoreLike } from "./src/status.js";
import { renderStatusPage } from "./src/status-page.js";
import { renderRecordPage } from "./src/record-page.js";
import { renderAdminConfigPage } from "./src/admin-config-page.js";
import { getHTTPLogLevel, shouldEmitLog } from "./src/http-log.js";
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
import { createRequestId, getRequestId, runWithRequestId, withRequestId } from "./src/request-context.js";
import { cacheResponseItems, resolveItemReferences } from "./src/response-cache.js";
import {
  appendRecordedAttemptResponseBody,
  appendRecordedClientResponseBody,
  beginRecordedRequest,
  configureRecording,
  finalizeRecordedRequest,
  flushRecording,
  getRecordedRequest,
  getRecordSummary,
  startRecording,
  setRecordedClientResponseBody,
  setRecordedClientResponseMeta,
  setRecordedRequestError,
  useSqliteRecordStore,
} from "./src/record.js";
import type { StreamFormat } from "./src/converters/streams.js";
import type { NormalizedRequest, NormalizedResponse } from "./src/converters/shared.js";
import { shouldIgnoreStreamReadError } from "./src/stream-errors.js";
import { handleServerStartupError } from "./src/startup-error.js";
import { stringify as stringifyYAML } from "yaml";

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

async function openSqliteDatabase(dbPath: string) {
  mkdirSync(dirname(dbPath), { recursive: true });
  try {
    const sqlite = await import("node:sqlite");
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
    `);
    return db;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to initialize SQLite storage. Use --storage memory or run nanollm with a Node.js version that supports node:sqlite. Cause: ${message}`);
  }
}

const startupArgs = process.argv.slice(2);
const configPath = resolveConfigPath(startupArgs);
const storageMode = resolveStorageMode(startupArgs);
const sqlitePath = join(homedir(), ".nanollm", "nanollm.sqlite3");
const sqliteDb = storageMode === "sqlite" ? await openSqliteDatabase(sqlitePath) : undefined;
const configManager = new ConfigManager(configPath);
const startupSnapshot = configManager.getActiveSnapshot();
if (sqliteDb) {
  useSqliteRecordStore(sqliteDb);
}
startRecording({ maxSize: startupSnapshot.effectiveConfig.record.max_size });
configManager.onUpdate(({ snapshot }, source) => {
  configureRecording({ maxSize: snapshot.effectiveConfig.record.max_size });
  if (source !== "startup") {
    console.log(
      `[CONFIG APPLY] source=${source} models=${snapshot.effectiveConfig.models.length} fallback_groups=${Object.keys(snapshot.effectiveConfig.fallback).length} record_max_size=${snapshot.effectiveConfig.record.max_size}`,
    );
  }
});
const app = new Hono();
const apiCors = cors({
  origin: "*",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
});

app.use("*", async (c, next) => {
  const requestId = createRequestId();
  const started = Date.now();
  const logLevel = getHTTPLogLevel(c.req.path);
  const emitLog = (message: string) => {
    if (!shouldEmitLog(logLevel)) return;
    console.log(message);
  };

  await runWithRequestId(requestId, async () => {
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
  if (c.req.path.startsWith("/admin/")) {
    return next();
  }
  return apiCors(c, next);
});

// ─── Helpers ────────────────────────────────────────────────────────────────

type Normalizer = (body: unknown) => NormalizedRequest;
type Denormalizer = (normalized: NormalizedResponse) => unknown;
type UpstreamOptions = { userAgent?: string; attemptIndex?: number; modelName?: string };
type AdminModelDraft = {
  name: string;
  provider: string;
  base_url: string;
  api_key: string;
  model: string;
  extras?: Record<string, unknown>;
};
type AdminFallbackDraft = {
  name: string;
  members: string[];
};
type AdminConfigForm = {
  rootExtras?: Record<string, unknown>;
  serverExtras?: Record<string, unknown>;
  recordExtras?: Record<string, unknown>;
  server: {
    port: string;
    ttfb_timeout: string;
  };
  record: {
    max_size: string;
  };
  models: AdminModelDraft[];
  fallbackGroups: AdminFallbackDraft[];
};

const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const modelFailures = new Map<string, number[]>();
const statusStore: StatusStoreLike = sqliteDb ? new SqliteStatusStore(sqliteDb) : new StatusStore();
const ORANGE = "\x1b[38;5;214m";
const RESET = "\x1b[0m";

function writeConfigAtomic(path: string, text: string) {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, text, "utf-8");
  renameSync(tempPath, path);
}

function toInputString(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function toPositiveIntegerOrUndefined(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`'${fieldName}' must be a positive integer`);
  }
  return normalized;
}

function toPlainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function buildAdminConfigForm(rawText: string): AdminConfigForm {
  const sourceConfig = parseSourceConfigDocument(rawText) as Record<string, unknown>;
  const { server, record, models, fallback, ...rootExtras } = sourceConfig;
  const serverObject = toPlainObject(server);
  const recordObject = toPlainObject(record);
  const { port, ttfb_timeout, ...serverExtras } = serverObject;
  const { max_size, ...recordExtras } = recordObject;

  return {
    rootExtras,
    serverExtras,
    recordExtras,
    server: {
      port: toInputString(port),
      ttfb_timeout: toInputString(ttfb_timeout),
    },
    record: {
      max_size: toInputString(max_size),
    },
    models: Array.isArray(models)
      ? models.map((entry) => {
          const modelObject = toPlainObject(entry);
          const { name, provider, base_url, api_key, model, ...extras } = modelObject;
          return {
            name: toInputString(name),
            provider: toInputString(provider),
            base_url: toInputString(base_url),
            api_key: toInputString(api_key),
            model: toInputString(model),
            extras,
          };
        })
      : [],
    fallbackGroups:
      fallback && typeof fallback === "object" && !Array.isArray(fallback)
        ? Object.entries(fallback as Record<string, unknown>).map(([name, members]) => ({
            name,
            members: Array.isArray(members) ? members.map((member) => toInputString(member)).filter(Boolean) : [],
          }))
        : [],
  };
}

function buildAdminConfigFormFromEffectiveConfig(config: ServerConfig): AdminConfigForm {
  return {
    rootExtras: {},
    serverExtras: {},
    recordExtras: {},
    server: {
      port: toInputString(config.port),
      ttfb_timeout: toInputString(config.ttfb_timeout),
    },
    record: {
      max_size: toInputString(config.record.max_size),
    },
    models: config.models.map((model) => ({
      name: model.name,
      provider: model.provider,
      base_url: model.base_url,
      api_key: model.api_key,
      model: model.model,
      extras: {},
    })),
    fallbackGroups: Object.entries(config.fallback).map(([name, members]) => ({
      name,
      members,
    })),
  };
}

function buildYamlTextFromAdminForm(form: AdminConfigForm, options?: { preservedPort?: unknown }): string {
  const root = toPlainObject(form.rootExtras);
  const serverExtras = toPlainObject(form.serverExtras);
  const recordExtras = toPlainObject(form.recordExtras);
  const preservedPort = toPositiveIntegerOrUndefined(options?.preservedPort, "server.port");
  const serverTTFBTimeout = toPositiveIntegerOrUndefined(form.server?.ttfb_timeout, "server.ttfb_timeout");
  const recordMaxSize = toPositiveIntegerOrUndefined(form.record?.max_size, "record.max_size");

  const models = Array.isArray(form.models)
    ? form.models.map((entry) => ({
        ...toPlainObject(entry.extras),
        name: entry.name ?? "",
        provider: entry.provider ?? "",
        base_url: entry.base_url ?? "",
        api_key: entry.api_key ?? "",
        model: entry.model ?? "",
      }))
    : [];

  const fallbackGroups = Object.fromEntries(
    (Array.isArray(form.fallbackGroups) ? form.fallbackGroups : [])
      .filter((group) => group && typeof group.name === "string" && group.name.trim())
      .map((group) => [
        group.name.trim(),
        (Array.isArray(group.members) ? group.members : []).map((member) => String(member).trim()).filter(Boolean),
      ]),
  );

  const document: Record<string, unknown> = { ...root };

  if (Object.keys(serverExtras).length > 0 || preservedPort !== undefined || serverTTFBTimeout !== undefined) {
    document.server = {
      ...serverExtras,
      ...(preservedPort !== undefined ? { port: preservedPort } : {}),
      ...(serverTTFBTimeout !== undefined ? { ttfb_timeout: serverTTFBTimeout } : {}),
    };
  }

  if (Object.keys(recordExtras).length > 0 || recordMaxSize !== undefined) {
    document.record = {
      ...recordExtras,
      ...(recordMaxSize !== undefined ? { max_size: recordMaxSize } : {}),
    };
  }

  document.models = models;
  if (Object.keys(fallbackGroups).length > 0) {
    document.fallback = fallbackGroups;
  } else if ("fallback" in document) {
    delete document.fallback;
  }

  return stringifyYAML(document, {
    lineWidth: 0,
    defaultStringType: "PLAIN",
  });
}

function getNormalizer(format: StreamFormat): Normalizer {
  switch (format) {
    case "openai-chat":
      return normalizeOpenAIChatRequest;
    case "openai-responses":
      return normalizeOpenAIResponsesRequest;
    case "anthropic":
      return normalizeAnthropicRequest;
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

function pruneModelFailures(name: string, now = Date.now()): number[] {
  const recent = (modelFailures.get(name) ?? []).filter((timestamp) => now - timestamp <= FAILURE_WINDOW_MS);
  modelFailures.set(name, recent);
  return recent;
}

function recordModelFailure(name: string, now = Date.now()) {
  const failures = pruneModelFailures(name, now);
  failures.push(now);
  modelFailures.set(name, failures);
}

function getModelFailureCount(name: string, now = Date.now()): number {
  return pruneModelFailures(name, now).length;
}

function orange(message: string): string {
  return `${ORANGE}${message}${RESET}`;
}

function getCandidateModels(config: ServerConfig, primaryModel: string): ModelConfig[] {
  const now = Date.now();
  const isFallbackGroup = primaryModel in config.fallback;
  if (isFallbackGroup) {
    return sortFallbackGroupMembers(resolveFallbackModels(config, primaryModel), (name) => getModelFailureCount(name, now))
      .map((name) => resolveModel(config, name))
      .filter((model): model is ModelConfig => Boolean(model));
  }

  const match = resolveModelForRequest(config, primaryModel);
  return match ? [match.model] : [];
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
]);

function tryParseJSON(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function buildStatusPayload(config: ServerConfig) {
  const availableWindows = [1, 3, 6];
  return {
    availableWindows,
    defaultWindowHours: 1,
    refreshedAt: Date.now(),
    bucketStarts: statusStore.listBuckets(),
    models: config.models.map((model) => ({
      name: model.name,
      series: statusStore.getModelSeries(model.name),
    })),
  };
}

function buildRecordQueryPayload(requestIdOrPrefix: string) {
  const record = getRecordedRequest(requestIdOrPrefix);
  return {
    summary: getRecordSummary(),
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
        statusStore.recordAttempt(modelConfig.name, requestStartedAt);
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
            );

            const response = new Response(readable, { headers: responseHeaders });
            setRecordedClientResponseMeta({ status: response.status, headers: response.headers });
            return response;
          }

          statusStore.recordSuccess(modelConfig.name, Date.now() - requestStartedAt, result.timing.ttfbMs, result.usage, requestStartedAt);
          cacheResponseItems((result.json as any)?.output);
          const response = c.json(result.json);
          setRecordedClientResponseMeta({ status: response.status, headers: response.headers });
          setRecordedClientResponseBody({ body: result.json });
          finalizeRecordedRequest({});
          return response;
        } catch (error) {
          const err = error as Error & { status?: number; upstream?: string; cause?: unknown };
          recordModelFailure(modelConfig.name);
          statusStore.recordFailure(modelConfig.name, Date.now() - requestStartedAt, requestStartedAt);
          lastError = err;
          console.warn(
            orange(
              withRequestId(
                `[MODEL FAILED] requested=${modelName} candidate=${modelConfig.name} path=${c.req.path} target=${getUpstreamURL(modelConfig)} message=${err.message}`,
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
      setRecordedRequestError({ message: lastError.message || "Request failed" });
      const errorBody = {
        error: lastError.message || "Request failed",
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

function buildStreamReadable(
  body: ReadableStream<Uint8Array>,
  incomingFormat: StreamFormat,
  upstreamFormat: StreamFormat,
  path: string,
  modelName: string,
  timing: { startedAt: number; ttfbMs: number },
  attemptIndex: number,
): ReadableStream<Uint8Array> {
  if (incomingFormat === "openai-responses") {
    return buildPipeStreamAndCache(
      body,
      path,
      modelName,
      timing,
      upstreamFormat,
      attemptIndex,
      upstreamFormat !== incomingFormat ? createSSEConverter(upstreamFormat, incomingFormat) : undefined,
    );
  }

  if (upstreamFormat === incomingFormat) {
    return buildPipeStreamAndCache(body, path, modelName, timing, upstreamFormat, attemptIndex);
  }

  // Convert stream format
  const converter = createSSEConverter(upstreamFormat, incomingFormat);
  const usageCollector = createUsageCollector(upstreamFormat);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const started = Date.now();
  let cancelled = false;
  let finished = false;
  let successRecorded = false;
  let recordFinalized = false;
  const cachedRequestId = getRequestId();
  let cancelPromise: Promise<void> | undefined;

  function settleSuccess(usage?: import("./src/converters/shared.js").NormalizedUsage) {
    if (successRecorded) return;
    successRecorded = true;
    const totalDuration = Date.now() - timing.startedAt; const streamDuration = totalDuration - timing.ttfbMs; statusStore.recordSuccess(modelName, totalDuration, timing.ttfbMs, usage, timing.startedAt, streamDuration);
  }

  function finalizeRecord() {
    if (recordFinalized) return;
    recordFinalized = true;
    finalizeRecordedRequest({});
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
            for (const chunk of converter.flush()) {
              const outboundText = typeof chunk === "string" ? chunk : decoder.decode(chunk);
              appendRecordedClientResponseBody({ chunk: outboundText });
              controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
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
          for (const chunk of converter.push(text)) {
            if (cancelled) return;
            const outboundText = typeof chunk === "string" ? chunk : decoder.decode(chunk);
            appendRecordedClientResponseBody({ chunk: outboundText });
            controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
          }
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
        statusStore.recordFailure(modelName, Date.now() - timing.startedAt, timing.startedAt);
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

/**
 * Pipe upstream SSE stream, optionally converting format.
 * Caches output items from response.output_item.done events.
 */
function buildPipeStreamAndCache(
  body: ReadableStream<Uint8Array>,
  path: string,
  modelName: string,
  timing: { startedAt: number; ttfbMs: number },
  streamFormat: StreamFormat,
  attemptIndex: number,
  converter?: ReturnType<typeof createSSEConverter>,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const collector = new SSEParser();
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
    for (const { data } of collector.push(sseText)) {
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
    const totalDuration = Date.now() - timing.startedAt; const streamDuration = totalDuration - timing.ttfbMs; statusStore.recordSuccess(modelName, totalDuration, timing.ttfbMs, usage, timing.startedAt, streamDuration);
  }

  function finalizeRecord() {
    if (recordFinalized) return;
    recordFinalized = true;
    finalizeRecordedRequest({});
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
            if (converter) {
              for (const chunk of converter.flush()) {
                const outboundText = typeof chunk === "string" ? chunk : decoder.decode(chunk);
                collectItems(outboundText);
                appendRecordedClientResponseBody({ chunk: outboundText });
                controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
              }
            }
            for (const { data } of collector.flush()) {
              try {
                const event = JSON.parse(data);
                if (event.type === "response.output_item.done" && event.item) {
                  outputItems.push(event.item);
                }
              } catch {}
            }
            cacheResponseItems(outputItems);
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
          if (converter) {
            for (const chunk of converter.push(text)) {
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
        statusStore.recordFailure(modelName, Date.now() - timing.startedAt, timing.startedAt);
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
      messages: "POST /v1/messages",
    },
  });
});

app.get("/health", (c) => c.json({ ok: true }));

app.get("/status", (c) => c.html(renderStatusPage(buildStatusPayload(configManager.getActiveSnapshot().effectiveConfig))));
app.get("/status/data", (c) => c.json(buildStatusPayload(configManager.getActiveSnapshot().effectiveConfig)));
app.get("/record", (c) => c.html(renderRecordPage(getRecordSummary())));
app.get("/record/summary", (c) => c.json(getRecordSummary()));
app.get("/record/:requestId", (c) => {
  const requestId = c.req.param("requestId");
  const payload = buildRecordQueryPayload(requestId);
  if (!payload.record) {
    return c.json({ error: `Record '${requestId.slice(0, 6)}' not found`, summary: payload.summary }, 404);
  }
  return c.json(payload);
});

app.get("/admin", (c) => c.html(renderAdminConfigPage(buildConfigAdminPayload())));
app.get("/admin/config", (c) => c.redirect("/admin", 302));
app.get("/admin/config/data", (c) => c.json(buildConfigAdminPayload()));
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
app.post("/v1/messages", createRoute("anthropic"));

// ─── Start ──────────────────────────────────────────────────────────────────

const startupConfig = startupSnapshot.effectiveConfig;
const server = serve({ fetch: app.fetch, port: startupConfig.port }, (info) => {
  console.log(`nanollm gateway listening on http://localhost:${info.port}`);
  console.log(`Storage: ${storageMode}${sqliteDb ? ` (${sqlitePath})` : ""}`);
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
    dispose: () => configManager.dispose(),
  });
});

server.once("close", () => {
  configManager.dispose();
  flushRecording();
  sqliteDb?.close();
});

export { server };
