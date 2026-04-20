// @ts-nocheck
import "dotenv/config";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import type { ModelConfig } from "./src/config.js";
import { getPublicModelNames, loadConfig, resolveFallbackModels, resolveModel } from "./src/config.js";
import { getUpstreamURL } from "./src/proxy.js";
import { forwardRequest, forwardStreamRequest, passthroughRequest, passthroughStreamRequest } from "./src/proxy.js";
import { sortFallbackGroupMembers } from "./src/fallback.js";
import { StatusStore } from "./src/status.js";
import { renderStatusPage } from "./src/status-page.js";
import { renderRecordPage } from "./src/record-page.js";
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
  getRecordedRequest,
  getRecordSummary,
  setRecordedClientResponseBody,
  setRecordedClientResponseMeta,
  setRecordedRequestError,
  startRecording,
  stopRecording,
} from "./src/record.js";
import type { StreamFormat } from "./src/converters/streams.js";
import type { NormalizedRequest, NormalizedResponse } from "./src/converters/shared.js";

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

const configPath = resolveConfigPath(process.argv.slice(2));
const config = loadConfig(configPath);
const app = new Hono();

app.use("*", async (c, next) => {
  const requestId = createRequestId();
  const started = Date.now();

  await runWithRequestId(requestId, async () => {
    console.log(withRequestId(`[HTTP START] method=${c.req.method} path=${c.req.path}`));

    try {
      await next();
      const responseType = c.res.headers.get("content-type") ?? "";
      if (responseType.includes("text/event-stream")) {
        console.log(withRequestId(`[HTTP STREAM START] method=${c.req.method} path=${c.req.path} status=${c.res.status} duration=${Date.now() - started}ms`));
      } else {
        console.log(withRequestId(`[HTTP END] method=${c.req.method} path=${c.req.path} status=${c.res.status} duration=${Date.now() - started}ms`));
      }
    } catch (error) {
      console.error(orange(withRequestId(`[HTTP ERROR] method=${c.req.method} path=${c.req.path} duration=${Date.now() - started}ms`)), error);
      throw error;
    }
  });
});

app.use(
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

// ─── Helpers ────────────────────────────────────────────────────────────────

type Normalizer = (body: unknown) => NormalizedRequest;
type Denormalizer = (normalized: NormalizedResponse) => unknown;
type UpstreamOptions = { userAgent?: string; attemptIndex?: number; modelName?: string };

const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const modelFailures = new Map<string, number[]>();
const statusStore = new StatusStore();
const ORANGE = "\x1b[38;5;214m";
const RESET = "\x1b[0m";

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

function getCandidateModels(primaryModel: string): ModelConfig[] {
  const now = Date.now();
  const isFallbackGroup = primaryModel in config.fallback;
  const candidateNames = isFallbackGroup
    ? sortFallbackGroupMembers(resolveFallbackModels(config, primaryModel), (name) => getModelFailureCount(name, now))
    : resolveFallbackModels(config, primaryModel);

  return candidateNames
    .map((name) => resolveModel(config, name))
    .filter((model): model is ModelConfig => Boolean(model));
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

function buildStatusPayload() {
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

// ─── Route Factory ──────────────────────────────────────────────────────────

function createRoute(incomingFormat: StreamFormat) {
  return async (c) => {
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
      return response;
    }

    const requestedModel = resolveModel(config, modelName);
    const requestedFallbackGroup = config.fallback[modelName];
    if (!requestedModel && !requestedFallbackGroup) {
      const errorBody = { error: `Model '${modelName}' not found in config`, available: getPublicModelNames(config) };
      const response = c.json(errorBody, 404);
      setRecordedRequestError({ message: errorBody.error });
      setRecordedClientResponseMeta({ status: response.status, headers: response.headers });
      setRecordedClientResponseBody({ body: errorBody });
      return response;
    }

    // Resolve item_reference for Responses API requests
    if (incomingFormat === "openai-responses" && Array.isArray(rawBody.input)) {
      rawBody.input = resolveItemReferences(rawBody.input);
    }

    const candidateModels = getCandidateModels(modelName);
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
      return response;
    }

    setRecordedRequestError({ message: "Request failed" });
    const response = c.json({ error: "Request failed" }, 500);
    setRecordedClientResponseMeta({ status: response.status, headers: response.headers });
    setRecordedClientResponseBody({ body: { error: "Request failed" } });
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

  return new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            for (const chunk of converter.flush()) {
              const outboundText = typeof chunk === "string" ? chunk : decoder.decode(chunk);
              appendRecordedClientResponseBody({ chunk: outboundText });
              controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
            }
            const usage = usageCollector.finish();
            statusStore.recordSuccess(modelName, Date.now() - timing.startedAt, timing.ttfbMs, usage, timing.startedAt);
            console.log(withRequestId(`[HTTP STREAM END] path=${path} duration=${Date.now() - started}ms`));
            controller.close();
            return;
          }

          const text = decoder.decode(value, { stream: true });
          appendRecordedAttemptResponseBody({ index: attemptIndex, chunk: text });
          usageCollector.push(text);
          for (const chunk of converter.push(text)) {
            const outboundText = typeof chunk === "string" ? chunk : decoder.decode(chunk);
            appendRecordedClientResponseBody({ chunk: outboundText });
            controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
          }
        }
      } catch (error) {
        statusStore.recordFailure(modelName, Date.now() - timing.startedAt, timing.startedAt);
        console.error(orange(withRequestId(`[HTTP STREAM ERROR] path=${path} duration=${Date.now() - started}ms`)), error);
        controller.error(error);
      }
    },
    cancel() {
      console.warn(withRequestId(`[HTTP STREAM CANCEL] path=${path} duration=${Date.now() - started}ms`));
      reader.releaseLock();
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

  return new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
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
            statusStore.recordSuccess(modelName, Date.now() - timing.startedAt, timing.ttfbMs, usage, timing.startedAt);
            console.log(withRequestId(`[HTTP STREAM END] path=${path} duration=${Date.now() - started}ms`));
            controller.close();
            return;
          }

          const text = decoder.decode(value, { stream: true });
          appendRecordedAttemptResponseBody({ index: attemptIndex, chunk: text });
          usageCollector.push(text);
          if (converter) {
            for (const chunk of converter.push(text)) {
              const outboundText = typeof chunk === "string" ? chunk : decoder.decode(chunk);
              collectItems(outboundText);
              appendRecordedClientResponseBody({ chunk: outboundText });
              controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
            }
          } else {
            collectItems(text);
            appendRecordedClientResponseBody({ chunk: text });
            controller.enqueue(value);
          }
        }
      } catch (error) {
        statusStore.recordFailure(modelName, Date.now() - timing.startedAt, timing.startedAt);
        console.error(orange(withRequestId(`[HTTP STREAM ERROR] path=${path} duration=${Date.now() - started}ms`)), error);
        controller.error(error);
      }
    },
    cancel() {
      console.warn(withRequestId(`[HTTP STREAM CANCEL] path=${path} duration=${Date.now() - started}ms`));
      reader.releaseLock();
    },
  });
}

// ─── Routes ─────────────────────────────────────────────────────────────────

app.get("/", (c) => {
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
      recordStart: "POST /record/start",
      recordStop: "POST /record/stop",
      chat: "POST /v1/chat/completions",
      responses: "POST /v1/responses",
      messages: "POST /v1/messages",
    },
  });
});

app.get("/health", (c) => c.json({ ok: true }));

app.get("/status", (c) => c.html(renderStatusPage(buildStatusPayload())));
app.get("/status/data", (c) => c.json(buildStatusPayload()));
app.get("/record", (c) => c.html(renderRecordPage(getRecordSummary())));
app.get("/record/summary", (c) => c.json(getRecordSummary()));
app.post("/record/start", (c) => c.json(startRecording()));
app.post("/record/stop", (c) => c.json(stopRecording()));
app.get("/record/:requestId", (c) => {
  const requestId = c.req.param("requestId");
  const payload = buildRecordQueryPayload(requestId);
  if (!payload.record) {
    return c.json({ error: `Record '${requestId.slice(0, 6)}' not found`, summary: payload.summary }, 404);
  }
  return c.json(payload);
});

app.get("/v1/models", (c) => {
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

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`nanollm gateway listening on http://localhost:${info.port}`);
  console.log(`Models: ${config.models.map((m) => m.name).join(", ") || "(none)"}`);
  console.log(
    `Fallback groups: ${
      Object.entries(config.fallback)
        .map(([group, models]) => `${group}=[${models.join(", ")}]`)
        .join("; ") || "(none)"
    }`,
  );
});

server.once("error", (error: Error & { code?: string }) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Failed to start nanollm: port ${config.port} is already in use.`);
    console.error("Use a different port in config.yaml, stop the other process, or set PORT.");
  } else {
    console.error("Failed to start nanollm:", error);
  }
  process.exitCode = 1;
});

export { server };
