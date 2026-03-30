// @ts-nocheck
import "dotenv/config";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import type { ModelConfig } from "./src/config.js";
import { loadConfig, resolveFallbackModels, resolveModel } from "./src/config.js";
import { getUpstreamURL } from "./src/proxy.js";
import { forwardRequest, forwardStreamRequest, passthroughRequest, passthroughStreamRequest } from "./src/proxy.js";
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
const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", req.get("access-control-request-headers") ?? "Content-Type,Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: "10mb" }));

// ─── Helpers ────────────────────────────────────────────────────────────────

type Normalizer = (body: unknown) => NormalizedRequest;
type Denormalizer = (normalized: NormalizedResponse) => unknown;
type UpstreamOptions = { userAgent?: string };

const FAILURE_WINDOW_MS = 3 * 60 * 1000;
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

function extractModel(body: unknown, format: StreamFormat): string | undefined {
  const b = body as Record<string, unknown>;
  return (b.model as string) ?? undefined;
}

function isStreamRequest(body: unknown, format: StreamFormat): boolean {
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
  const candidateNames = resolveFallbackModels(config, primaryModel);
  const fallbackOrder = new Map(candidateNames.map((name, index) => [name, index]));
  const now = Date.now();

  return candidateNames
    .map((name) => resolveModel(config, name))
    .filter((model): model is ModelConfig => Boolean(model))
    .sort((left, right) => {
      if (left.name === primaryModel) return -1;
      if (right.name === primaryModel) return 1;

      const failureDelta = getModelFailureCount(left.name, now) - getModelFailureCount(right.name, now);
      if (failureDelta !== 0) return failureDelta;

      return (fallbackOrder.get(left.name) ?? Number.MAX_SAFE_INTEGER) - (fallbackOrder.get(right.name) ?? Number.MAX_SAFE_INTEGER);
    });
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

function applyUpstreamResponseHeaders(res: express.Response, headers: Headers) {
  for (const [key, value] of headers.entries()) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    res.setHeader(key, value);
  }
}

// ─── Route Factory ──────────────────────────────────────────────────────────

function createRoute(incomingFormat: StreamFormat) {
  return async (req: express.Request, res: express.Response) => {
    const requestId = createRequestId();
    return runWithRequestId(requestId, async () => {
      const upstreamOptions = { userAgent: req.get("user-agent") ?? undefined };
      const modelName = extractModel(req.body, incomingFormat);
      if (!modelName) {
        return res.status(400).json({ error: "Missing 'model' in request body" });
      }

      const requestedModel = resolveModel(config, modelName);
      if (!requestedModel) {
        return res.status(404).json({
          error: `Model '${modelName}' not found in config`,
          available: config.models.map((m) => m.name),
        });
      }
      const stream = isStreamRequest(req.body, incomingFormat);

      // Resolve item_reference for Responses API requests
      if (incomingFormat === "openai-responses" && Array.isArray(req.body.input)) {
        req.body.input = resolveItemReferences(req.body.input);
      }

      const candidateModels = getCandidateModels(modelName);
      let lastError: (Error & { status?: number; upstream?: string; cause?: unknown }) | undefined;

      try {
        for (const modelConfig of candidateModels) {
          console.log(
            withRequestId(
              `[REQUEST] model=${modelName} path=${req.path} target=${getUpstreamURL(modelConfig)} candidate=${modelConfig.name}`,
            ),
          );

          try {
            const result = await executeModelRequest(modelConfig, incomingFormat, req.body, stream, upstreamOptions);

            if (result.kind === "stream") {
              const { body, upstreamFormat } = result;

              if (upstreamFormat === incomingFormat && "headers" in result) {
                applyUpstreamResponseHeaders(res, result.headers);
              }

              res.setHeader("Content-Type", res.getHeader("Content-Type") ?? "text/event-stream");
              res.setHeader("Cache-Control", res.getHeader("Cache-Control") ?? "no-cache");
              res.setHeader("Connection", "keep-alive");
              res.setHeader("X-Accel-Buffering", "no");
              res.flushHeaders();
              res.socket?.setNoDelay(true);

              if (incomingFormat === "openai-responses") {
                await pipeStreamAndCache(body, res, upstreamFormat !== incomingFormat ? createSSEConverter(upstreamFormat, incomingFormat) : undefined);
              } else if (upstreamFormat === incomingFormat) {
                await pipeStreamAndCache(body, res);
              } else {
                const converter = createSSEConverter(upstreamFormat, incomingFormat);
                const reader = body.getReader();
                const decoder = new TextDecoder();
                try {
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    for (const chunk of converter.push(decoder.decode(value, { stream: true }))) {
                      writeStreamChunk(res, chunk);
                    }
                  }
                  for (const chunk of converter.flush()) {
                    writeStreamChunk(res, chunk);
                  }
                } finally {
                  reader.releaseLock();
                  res.end();
                }
              }
              return;
            }

            cacheResponseItems((result.json as any)?.output);
            res.json(result.json);
            return;
          } catch (error) {
            const err = error as Error & { status?: number; upstream?: string; cause?: unknown };
            recordModelFailure(modelConfig.name);
            lastError = err;
            console.warn(
              orange(
                withRequestId(
                  `[MODEL FAILED] requested=${modelName} candidate=${modelConfig.name} path=${req.path} target=${getUpstreamURL(modelConfig)} message=${err.message}`,
                ),
              ),
            );
            if (res.headersSent) {
              console.error(orange(withRequestId(`[stream error] ${err.message}`)), err.cause ?? "");
              if (!res.writableEnded) res.end();
              return;
            }
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
        return res.status(status).json({
          error: lastError.message || "Request failed",
          ...(lastError.upstream ? { upstream: tryParseJSON(lastError.upstream) } : {}),
        });
      }

      return res.status(500).json({ error: "Request failed" });
    });
  };
}

/**
 * Pipe upstream SSE stream to response.
 * Optionally convert format via SSEConverter.
 * Caches output items from response.output_item.done events for item_reference resolution.
 */
async function pipeStreamAndCache(
  body: ReadableStream<Uint8Array>,
  res: express.Response,
  converter?: ReturnType<typeof createSSEConverter>,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const collector = new SSEParser();
  const outputItems: unknown[] = [];

  function collectItems(sseText: string) {
    for (const { data } of collector.push(sseText)) {
      try {
        const event = JSON.parse(data);
        // if (converter) {
        //   console.log('[CONVERTED EVENT]', JSON.stringify(event));
        // }
        if (event.type === "response.output_item.done" && event.item) {
          outputItems.push(event.item);
        }
      } catch {}
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });

      if (converter) {
        // console.log('[UPSTREAM CHUNK]', text);
        for (const chunk of converter.push(text)) {
          collectItems(chunk);
          writeStreamChunk(res, chunk);
        }
      } else {
        collectItems(text);
        writeStreamChunk(res, text);
      }
    }
    if (converter) {
      for (const chunk of converter.flush()) {
        collectItems(chunk);
        writeStreamChunk(res, chunk);
      }
    }
    // Flush SSE parser for any remaining buffered events
    for (const { data } of collector.flush()) {
      try {
        const event = JSON.parse(data);
        if (event.type === "response.output_item.done" && event.item) {
          outputItems.push(event.item);
        }
      } catch {}
    }
  } finally {
    reader.releaseLock();
    cacheResponseItems(outputItems);
    res.end();
  }
}

function tryParseJSON(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function writeStreamChunk(res: express.Response, chunk: string | Uint8Array) {
  res.write(chunk);
  res.flush?.();
}

// ─── Routes ─────────────────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    message: "nanollm gateway",
    models: config.models.map((m) => ({ name: m.name, provider: m.provider, model: m.model })),
    endpoints: {
      health: "GET /health",
      chat: "POST /v1/chat/completions",
      responses: "POST /v1/responses",
      messages: "POST /v1/messages",
    },
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: config.models.map((m) => ({
      id: m.name,
      object: "model",
      owned_by: m.provider,
    })),
  });
});

app.post("/v1/chat/completions", createRoute("openai-chat"));
app.post("/v1/responses", createRoute("openai-responses"));
app.post("/v1/messages", createRoute("anthropic"));

// ─── Start ──────────────────────────────────────────────────────────────────

const server = app.listen(config.port);

server.once("listening", () => {
  console.log(`nanollm gateway listening on http://localhost:${config.port}`);
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
