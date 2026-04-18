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
import { createSSEConverter, formatDone, SSEParser } from "./src/converters/streams.js";
import { createRequestId, runWithRequestId, withRequestId } from "./src/request-context.js";
import { cacheResponseItems, resolveItemReferences } from "./src/response-cache.js";
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
type UpstreamOptions = { userAgent?: string };

const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const modelFailures = new Map<string, number[]>();
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
      const { body, headers } = await passthroughStreamRequest(modelConfig, rawBody, upstreamOptions);
      return { kind: "stream" as const, body, headers, upstreamFormat: modelConfig.provider };
    }

    const json = await passthroughRequest(modelConfig, rawBody, upstreamOptions);
    return { kind: "json" as const, json };
  }

  const normalize = getNormalizer(incomingFormat);
  const denormalize = getDenormalizer(incomingFormat);
  const normalized = normalize(rawBody);

  if (stream) {
    const result = await forwardStreamRequest(modelConfig, normalized, upstreamOptions);
    return { kind: "stream" as const, ...result };
  }

  const normalizedResponse = await forwardRequest(modelConfig, normalized, upstreamOptions);
  return { kind: "json" as const, json: denormalize(normalizedResponse) };
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

// ─── Route Factory ──────────────────────────────────────────────────────────

function createRoute(incomingFormat: StreamFormat) {
  return async (c) => {
    const userAgent = c.req.header("user-agent");
    const upstreamOptions = { userAgent };
    const rawBody = await c.req.json();
    const modelName = extractModel(rawBody);

    if (!modelName) {
      return c.json({ error: "Missing 'model' in request body" }, 400);
    }

    const requestedModel = resolveModel(config, modelName);
    const requestedFallbackGroup = config.fallback[modelName];
    if (!requestedModel && !requestedFallbackGroup) {
      return c.json(
        { error: `Model '${modelName}' not found in config`, available: getPublicModelNames(config) },
        404,
      );
    }

    const stream = isStreamRequest(rawBody);

    // Resolve item_reference for Responses API requests
    if (incomingFormat === "openai-responses" && Array.isArray(rawBody.input)) {
      rawBody.input = resolveItemReferences(rawBody.input);
    }

    const candidateModels = getCandidateModels(modelName);
    let lastError: (Error & { status?: number; upstream?: string; cause?: unknown }) | undefined;

    try {
      for (const modelConfig of candidateModels) {
        console.log(
          withRequestId(
            `[REQUEST] model=${modelName} path=${c.req.path} target=${getUpstreamURL(modelConfig)} candidate=${modelConfig.name}`,
          ),
        );

        try {
          const result = await executeModelRequest(modelConfig, incomingFormat, rawBody, stream, upstreamOptions);

          if (result.kind === "stream") {
            const { body, upstreamFormat } = result;

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

            const readable = buildStreamReadable(body, incomingFormat, upstreamFormat, c.req.path);

            return new Response(readable, { headers: responseHeaders });
          }

          cacheResponseItems((result.json as any)?.output);
          return c.json(result.json);
        } catch (error) {
          const err = error as Error & { status?: number; upstream?: string; cause?: unknown };
          recordModelFailure(modelConfig.name);
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
      return c.json(
        { error: lastError.message || "Request failed", ...(lastError.upstream ? { upstream: tryParseJSON(lastError.upstream) } : {}) },
        status,
      );
    }

    return c.json({ error: "Request failed" }, 500);
  };
}

function buildStreamReadable(
  body: ReadableStream<Uint8Array>,
  incomingFormat: StreamFormat,
  upstreamFormat: StreamFormat,
  path: string,
): ReadableStream<Uint8Array> {
  if (incomingFormat === "openai-responses") {
    return buildPipeStreamAndCache(body, path, upstreamFormat !== incomingFormat ? createSSEConverter(upstreamFormat, incomingFormat) : undefined);
  }

  if (upstreamFormat === incomingFormat) {
    return buildPipeStreamAndCache(body, path);
  }

  // Convert stream format
  const converter = createSSEConverter(upstreamFormat, incomingFormat);
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
              controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
            }
            console.log(withRequestId(`[HTTP STREAM END] path=${path} duration=${Date.now() - started}ms`));
            controller.close();
            return;
          }

          for (const chunk of converter.push(decoder.decode(value, { stream: true }))) {
            controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
          }
        }
      } catch (error) {
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
  converter?: ReturnType<typeof createSSEConverter>,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const collector = new SSEParser();
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
                collectItems(typeof chunk === "string" ? chunk : decoder.decode(chunk));
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
            console.log(withRequestId(`[HTTP STREAM END] path=${path} duration=${Date.now() - started}ms`));
            controller.close();
            return;
          }

          const text = decoder.decode(value, { stream: true });
          if (converter) {
            for (const chunk of converter.push(text)) {
              collectItems(typeof chunk === "string" ? chunk : decoder.decode(chunk));
              controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
            }
          } else {
            collectItems(text);
            controller.enqueue(value);
          }
        }
      } catch (error) {
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
      chat: "POST /v1/chat/completions",
      responses: "POST /v1/responses",
      messages: "POST /v1/messages",
    },
  });
});

app.get("/health", (c) => c.json({ ok: true }));

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
