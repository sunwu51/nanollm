// @ts-nocheck
import type { ModelConfig } from "./config.js";
import { SSEParser, type StreamFormat } from "./converters/streams.js";
import type { NormalizedRequest, NormalizedResponse, NormalizedUsage } from "./converters/shared.js";
import {
  denormalizeToOpenAIChatRequest,
  denormalizeToOpenAIResponsesRequest,
  denormalizeToAnthropicRequest,
} from "./converters/requests.js";
import {
  normalizeOpenAIChatResponse,
  normalizeOpenAIResponsesResponse,
  normalizeAnthropicResponse,
} from "./converters/responses.js";
import { normalizeUsage } from "./converters/shared.js";
import {
  ensureRecordedAttempt,
  setRecordedAttemptError,
  setRecordedAttemptResponseBody,
  setRecordedAttemptResponseMeta,
} from "./record.js";
import { runInNewContext } from "node:vm";
import { Agent, ProxyAgent, fetch as undiciFetch } from "undici";
import { extractErrorCauses } from "./error-details.js";
import { getCachedSubscriptionCredential, ensureSubscriptionCredential, SUBSCRIPTION_URL } from "./openai-subscription.js";

export interface UpstreamRequestOptions {
  userAgent?: string;
  attemptIndex?: number;
  modelName?: string;
  recordedRequestBody?: unknown;
}

export interface UpstreamTiming {
  startedAt: number;
  responseStartedAt: number;
  ttfbMs: number;
}

export type OpenAIImageOperation = "generations" | "edits";

// ─── Upstream URL ───────────────────────────────────────────────────────────

export function getUpstreamURL(config: ModelConfig): string {
  return getUpstreamURLForPath(config);
}

export function getUpstreamURLForPath(config: ModelConfig, imageOperation?: OpenAIImageOperation): string {
  if (config.subscription_provider) return `${SUBSCRIPTION_URL}/responses`;
  const base = config.base_url.replace(/\/+$/, "");
  switch (config.provider) {
    case "openai-chat":
      return `${base}/chat/completions`;
    case "openai-responses":
      return `${base}/responses`;
    case "openai-image":
      return `${base}/images/${imageOperation ?? "generations"}`;
    case "anthropic":
      return `${base}/messages`;
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

// ─── Auth Headers ───────────────────────────────────────────────────────────

function getAuthHeaders(config: ModelConfig): Record<string, string> {
  if (config.subscription_provider) {
    const credential = getCachedSubscriptionCredential(config.subscription_provider);
    if (!credential) throw new Error(`OpenAI subscription provider '${config.subscription_provider}' is not authenticated`);
    return {
      Authorization: `Bearer ${credential.accessToken}`,
      ...(credential.accountId ? { "ChatGPT-Account-Id": credential.accountId } : {}),
      originator: "codex_cli_rs",
    };
  }
  switch (config.provider) {
    case "openai-chat":
    case "openai-responses":
    case "openai-image":
      return { Authorization: `Bearer ${config.api_key}` };
    case "anthropic":
      return {
        "x-api-key": config.api_key,
        "anthropic-version": "2023-06-01",
      };
    default:
      return {};
  }
}

// ─── Denormalize Request ────────────────────────────────────────────────────

function denormalizeRequest(config: ModelConfig, normalized: NormalizedRequest): unknown {
  switch (config.provider) {
    case "openai-chat":
      return denormalizeToOpenAIChatRequest(normalized);
    case "openai-responses":
      return denormalizeToOpenAIResponsesRequest(normalized);
    case "anthropic":
      return denormalizeToAnthropicRequest(normalized, { ignoreInvalidHistory: config.ignore_invalid_history ?? true });
  }
}

/** For non-passthrough OpenAI requests, disable server-side storage to prevent item_reference usage. */
function applyOpenAIDefaults(provider: StreamFormat, body: unknown): unknown {
  if (provider === "openai-chat" || provider === "openai-responses") {
    (body as Record<string, unknown>).store = false;
  }
  return body;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(target: unknown, source: unknown): unknown {
  if (!isPlainObject(target) || !isPlainObject(source)) return source;

  const result: Record<string, unknown> = { ...target };
  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = result[key];
    result[key] = isPlainObject(targetValue) && isPlainObject(sourceValue) ? deepMerge(targetValue, sourceValue) : sourceValue;
  }
  return result;
}

function applyModelBodyOverrides(config: ModelConfig, body: unknown): unknown {
  if (!config.body) return body;
  return deepMerge(body, config.body);
}

function applyModelBodyExpression(config: ModelConfig, body: unknown): unknown {
  if (!config.bodyExpression) return body;

  let result: unknown;
  try {
    result = runInNewContext(`(${config.bodyExpression})`, {
      body,
      console,
      Date,
      JSON,
      Math,
      structuredClone,
    }, {
      filename: `bodyExpression:${config.name}`,
      timeout: 1000,
    });
  } catch (error) {
    throw new Error(`Model '${config.name}' bodyExpression failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (result === undefined) {
    throw new Error(`Model '${config.name}' bodyExpression returned undefined`);
  }
  if (result && typeof (result as { then?: unknown }).then === "function") {
    throw new Error(`Model '${config.name}' bodyExpression must return synchronously`);
  }
  return result;
}

function applyModelBodyTransforms(config: ModelConfig, body: unknown): unknown {
  return applyModelBodyExpression(config, applyModelBodyOverrides(config, body));
}

function toReadonlyHeaderRecord(headers: Headers): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(headers.entries()));
}

function applyModelResponseExpression(config: ModelConfig, response: unknown, headers: Headers): unknown {
  if (!config.responseExpression) return response;

  let result: unknown;
  try {
    result = runInNewContext(`(${config.responseExpression})`, {
      response,
      headers: toReadonlyHeaderRecord(headers),
      console,
      Date,
      JSON,
      Math,
      structuredClone,
    }, {
      filename: `responseExpression:${config.name}`,
      timeout: 1000,
    });
  } catch (error) {
    const message = isPlainObject(error) && typeof error.message === "string" ? error.message : String(error);
    throw new Error(`Model '${config.name}' responseExpression failed: ${message}`);
  }

  if (result === undefined) throw new Error(`Model '${config.name}' responseExpression returned undefined`);
  if (result && typeof (result as { then?: unknown }).then === "function") {
    throw new Error(`Model '${config.name}' responseExpression must return synchronously`);
  }
  return structuredClone(result);
}

function extractStreamModel(provider: StreamFormat, event: unknown): string | undefined {
  if (!isPlainObject(event)) return undefined;
  if (provider === "openai-chat") return typeof event.model === "string" ? event.model : undefined;
  if (provider === "openai-responses" && event.type === "response.created" && isPlainObject(event.response)) {
    return typeof event.response.model === "string" ? event.response.model : undefined;
  }
  if (provider === "anthropic" && event.type === "message_start" && isPlainObject(event.message)) {
    return typeof event.message.model === "string" ? event.message.model : undefined;
  }
  return undefined;
}

const OPENAI_RESPONSES_UNSTORED_ITEM_ID_TYPES = new Set(["message", "reasoning", "function_call", "custom_tool_call"]);

function stripOpenAIResponsesUnstoredItemIds(config: ModelConfig, body: unknown): unknown {
  if (config.provider !== "openai-responses" || !isPlainObject(body) || body.store !== false || !Array.isArray(body.input)) return body;

  let changed = false;
  const input = body.input.map((item) => {
    if (!isPlainObject(item) || typeof item.type !== "string" || !OPENAI_RESPONSES_UNSTORED_ITEM_ID_TYPES.has(item.type) || !("id" in item)) return item;
    changed = true;
    const withoutId = { ...item };
    delete withoutId.id;
    return withoutId;
  });
  return changed ? { ...body, input } : body;
}

function preparePassthroughBody(config: ModelConfig, rawBody: Record<string, unknown>, stream: boolean): unknown {
  return stripOpenAIResponsesUnstoredItemIds(
    config,
    applyModelBodyTransforms(config, { ...rawBody, model: config.model, stream }),
  );
}

function isJsonContentType(headers: Headers): boolean {
  const contentType = headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("application/json") || contentType.includes("+json");
}

function isMultipartContentType(headers: Headers): boolean {
  return headers.get("content-type")?.toLowerCase().includes("multipart/form-data") ?? false;
}

function prepareRawJsonBody(config: ModelConfig, body: BodyInit): { body: BodyInit; recordedRequestBody: unknown } | undefined {
  if (typeof body !== "string" && !(body instanceof Uint8Array)) return undefined;

  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  let rawBody: unknown;
  try {
    rawBody = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (!isPlainObject(rawBody)) return undefined;
  const transformedBody = applyModelBodyTransforms(config, { ...rawBody, model: config.model });
  return {
    body: JSON.stringify(transformedBody),
    recordedRequestBody: transformedBody,
  };
}

function replaceRecordedRequestModel(recordedRequestBody: unknown, model: string): unknown {
  return isPlainObject(recordedRequestBody) ? { ...recordedRequestBody, model } : recordedRequestBody;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getMultipartBoundary(headers: Headers): string | undefined {
  const contentType = headers.get("content-type") ?? "";
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  return match?.[1] ?? match?.[2]?.trim();
}

function prepareRawMultipartBody(config: ModelConfig, body: BodyInit, incomingHeaders: Headers, recordedRequestBody: unknown): { body: BodyInit; recordedRequestBody: unknown } | undefined {
  if (typeof body !== "string" && !(body instanceof Uint8Array)) return undefined;
  const boundary = getMultipartBoundary(incomingHeaders);
  if (!boundary) return undefined;

  const text = typeof body === "string" ? body : Buffer.from(body).toString("latin1");
  const boundaryPattern = escapeRegExp(`--${boundary}`);
  const modelPartPattern = new RegExp(
    `((?:^|\\r\\n)${boundaryPattern}\\r\\n(?:[^\\r\\n]+\\r\\n)*Content-Disposition: form-data; name="model"[^\\r\\n]*\\r\\n(?:[^\\r\\n]+\\r\\n)*\\r\\n)([\\s\\S]*?)(\\r\\n${boundaryPattern})`,
  );
  if (!modelPartPattern.test(text)) return undefined;
  const replaced = text.replace(modelPartPattern, `$1${config.model}$3`);
  return {
    body: typeof body === "string" ? replaced : Buffer.from(replaced, "latin1"),
    recordedRequestBody: replaceRecordedRequestModel(recordedRequestBody, config.model),
  };
}

async function prepareRawBody(
  config: ModelConfig,
  body: BodyInit,
  incomingHeaders: Headers,
  recordedRequestBody: unknown,
): Promise<{ body: BodyInit; recordedRequestBody: unknown } | undefined> {
  if (isJsonContentType(incomingHeaders)) {
    return prepareRawJsonBody(config, body);
  }
  if (isMultipartContentType(incomingHeaders)) {
    return prepareRawMultipartBody(config, body, incomingHeaders, recordedRequestBody);
  }
  return undefined;
}

// ─── Normalize Response ─────────────────────────────────────────────────────

function normalizeUpstreamResponse(provider: StreamFormat, body: unknown): NormalizedResponse {
  switch (provider) {
    case "openai-chat":
      return normalizeOpenAIChatResponse(body as any);
    case "openai-responses":
      return normalizeOpenAIResponsesResponse(body as any);
    case "anthropic":
      return normalizeAnthropicResponse(body as any);
  }
}

// ─── Shared fetch ───────────────────────────────────────────────────────────

function getForwardHeaders(config: ModelConfig, options?: UpstreamRequestOptions): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...getAuthHeaders(config),
    ...(options?.userAgent ? { "User-Agent": options.userAgent } : {}),
    ...(config.headers ?? {}),
  };
}

export function resolveProxyUrl(config: ModelConfig): string | undefined {
  return config.proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
}

const upstreamAgents = {
  http1: new Agent({ allowH2: false }),
  http2: new Agent({ allowH2: true }),
};

export function createUpstreamDispatcher(config: ModelConfig, proxyUrl = resolveProxyUrl(config)) {
  const allowH2 = config.allow_h2 ?? false;
  if (!proxyUrl) return allowH2 ? upstreamAgents.http2 : upstreamAgents.http1;

  return new ProxyAgent({
    uri: proxyUrl,
    allowH2,
    requestTls: { allowH2 },
  });
}

async function upstreamFetch(
  config: ModelConfig,
  body: string,
  stream: boolean,
  options?: UpstreamRequestOptions,
): Promise<{ response: Response; timing: UpstreamTiming }> {
  if (config.subscription_provider) await ensureSubscriptionCredential(config.subscription_provider);
  return upstreamFetchToUrl(
    config,
    getUpstreamURL(config),
    body,
    stream,
    getForwardHeaders(config, options),
    options,
    options?.recordedRequestBody ?? body,
  );
}

async function upstreamFetchToUrl(
  config: ModelConfig,
  url: string,
  body: BodyInit,
  stream: boolean,
  headers: HeadersInit,
  options?: UpstreamRequestOptions,
  recordedRequestBody: unknown = typeof body === "string" ? body : "[binary body]",
): Promise<{ response: Response; timing: UpstreamTiming }> {
  const proxyUrl = resolveProxyUrl(config);
  const timeoutMs = config.ttfb_timeout;
  const abortController = timeoutMs !== undefined ? new AbortController() : undefined;
  let timeoutHandle: NodeJS.Timeout | undefined;
  const startedAt = Date.now();

  const fetchOptions: RequestInit = {
    method: "POST",
    headers,
    body,
    ...(abortController ? { signal: abortController.signal } : {}),
  };
  ensureRecordedAttempt({
    index: options?.attemptIndex ?? 0,
    provider: config.provider,
    modelName: options?.modelName ?? config.name,
    url,
    requestHeaders: fetchOptions.headers as Record<string, string>,
    requestBody: recordedRequestBody,
  });

  fetchOptions.dispatcher = createUpstreamDispatcher(config, proxyUrl);

  if (abortController && timeoutMs !== undefined) {
    timeoutHandle = setTimeout(() => {
      abortController.abort(new Error(`Upstream TTFB timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  }

  let res: Response;
  try {
    res = await undiciFetch(url, fetchOptions);
  } catch (error) {
    if (abortController?.signal.aborted && error === abortController.signal.reason) {
      setRecordedAttemptError({
        index: options?.attemptIndex ?? 0,
        message: `Upstream TTFB timeout after ${timeoutMs}ms`,
      });
      const err = new Error(`Upstream TTFB timeout after ${timeoutMs}ms`) as Error & { cause?: unknown };
      err.cause = error;
      throw err;
    }
    setRecordedAttemptError({
      index: options?.attemptIndex ?? 0,
      message: error instanceof Error ? error.message : String(error),
      causes: extractErrorCauses(error),
    });
    throw error;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  const responseStartedAt = Date.now();
  const timing: UpstreamTiming = {
    startedAt,
    responseStartedAt,
    ttfbMs: responseStartedAt - startedAt,
  };
  setRecordedAttemptResponseMeta({
    index: options?.attemptIndex ?? 0,
    status: res.status,
    headers: res.headers,
  });

  if (!res.ok) {
    const text = await res.text();
    setRecordedAttemptResponseBody({ index: options?.attemptIndex ?? 0, body: text });
    setRecordedAttemptError({
      index: options?.attemptIndex ?? 0,
      message: `Upstream ${res.status}: ${text}`,
      status: res.status,
      upstream: text,
    });
    const err = new Error(`Upstream ${res.status}: ${text}`) as Error & { status: number; upstream: string };
    err.status = res.status;
    err.upstream = text;
    throw err;
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    const text = await res.text();
    setRecordedAttemptResponseBody({ index: options?.attemptIndex ?? 0, body: text });
    setRecordedAttemptError({
      index: options?.attemptIndex ?? 0,
      message: "Upstream returned HTML response (possible error page)",
      status: 200,
      upstream: text,
    });
    const err = new Error("Upstream returned HTML response (possible error page)") as Error & { status: number; upstream: string };
    err.status = 200;
    err.upstream = text;
    throw err;
  }
  // Codex occasionally omits Content-Type while still returning a valid SSE
  // stream. Let the body validator inspect that response; reject only an
  // explicitly non-SSE content type.
  if (stream && contentType.trim() && !contentType.includes("text/event-stream")) {
    const text = await res.text();
    setRecordedAttemptResponseBody({ index: options?.attemptIndex ?? 0, body: text });
    setRecordedAttemptError({
      index: options?.attemptIndex ?? 0,
      message: `Upstream returned non-SSE Content-Type for stream request: ${contentType}`,
      status: 200,
      upstream: text,
    });
    const err = new Error(`Upstream returned non-SSE Content-Type for stream request: ${contentType}`) as Error & { status: number; upstream: string };
    err.status = 200;
    err.upstream = text;
    throw err;
  }

  return { response: res, timing };
}

// ─── Stream content validation ──────────────────────────────────────────────

const MAX_VALIDATION_BUFFER_BYTES = 64 * 1024;

function reconstructStream(
  bufferedChunks: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      if (index < bufferedChunks.length) {
        controller.enqueue(bufferedChunks[index++]);
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

async function validateStreamContent(
  body: ReadableStream<Uint8Array>,
  options: { attemptIndex: number; config: ModelConfig; headers: Headers },
): Promise<ReadableStream<Uint8Array>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const sseParser = new SSEParser();
  const bufferedChunks: Uint8Array[] = [];
  let totalBytes = 0;
  let expressionApplied = !options.config.responseExpression;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        const flushed = sseParser.flush();
        if (!expressionApplied) {
          for (const event of flushed) {
            let parsed: unknown;
            try { parsed = JSON.parse(event.data); } catch { continue; }
            const model = extractStreamModel(options.config.provider, parsed);
            if (model === undefined) continue;
            applyModelResponseExpression(options.config, parsed, options.headers);
            expressionApplied = true;
            break;
          }
        }
        if (flushed.length > 0 && expressionApplied) {
          return reconstructStream(bufferedChunks, reader);
        }
        const bufferedText = bufferedChunks.map(c => decoder.decode(c, { stream: true })).join("") + decoder.decode();
        const message = !expressionApplied
          ? "Upstream SSE stream ended before responseExpression could find a model-bearing start event"
          : "Upstream SSE stream ended with no real content (ping-only or empty)";
        setRecordedAttemptResponseBody({ index: options.attemptIndex, body: bufferedText });
        setRecordedAttemptError({
          index: options.attemptIndex,
          message,
          status: 200,
          upstream: bufferedText,
        });
        const err = new Error(message) as Error & { status: number; upstream: string };
        err.status = 200;
        err.upstream = bufferedText;
        throw err;
      }

      bufferedChunks.push(value);
      totalBytes += value.byteLength;

      const text = decoder.decode(value, { stream: true });
      const events = sseParser.push(text);

      if (!expressionApplied) {
        for (const event of events) {
          let parsed: unknown;
          try { parsed = JSON.parse(event.data); } catch { continue; }
          const model = extractStreamModel(options.config.provider, parsed);
          if (model === undefined) continue;
          applyModelResponseExpression(options.config, parsed, options.headers);
          expressionApplied = true;
          break;
        }
      }

      if (expressionApplied && (events.length > 0 || sseParser.hasBufferedRealData())) {
        return reconstructStream(bufferedChunks, reader);
      }

      if (totalBytes >= MAX_VALIDATION_BUFFER_BYTES) {
        const bufferedText = bufferedChunks.map(c => new TextDecoder().decode(c, { stream: true })).join("") + new TextDecoder().decode();
        setRecordedAttemptResponseBody({ index: options.attemptIndex, body: bufferedText });
        const message = !expressionApplied
          ? `Upstream SSE stream exceeded ${MAX_VALIDATION_BUFFER_BYTES} bytes before responseExpression could find a model-bearing start event`
          : `Upstream SSE stream exceeded ${MAX_VALIDATION_BUFFER_BYTES} bytes with no real content`;
        setRecordedAttemptError({
          index: options.attemptIndex,
          message,
          status: 200,
          upstream: bufferedText,
        });
        const err = new Error(message) as Error & { status: number; upstream: string };
        err.status = 200;
        err.upstream = bufferedText;
        reader.cancel().catch(() => {});
        throw err;
      }
    }
  } catch (error) {
    reader.cancel(error).catch(() => {});
    if (error instanceof Error && "upstream" in error) throw error;
    throw error;
  }
}

function getRawForwardHeaders(
  config: ModelConfig,
  incomingHeaders: Headers,
  options?: UpstreamRequestOptions,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const skipped = new Set([
    "authorization",
    "cookie",
    "host",
    "content-length",
    "connection",
    "accept-encoding",
  ]);
  for (const [key, value] of incomingHeaders.entries()) {
    if (skipped.has(key.toLowerCase())) continue;
    headers[key] = value;
  }
  return {
    ...headers,
    ...getAuthHeaders(config),
    ...(options?.userAgent ? { "User-Agent": options.userAgent } : {}),
    ...(config.headers ?? {}),
  };
}

export async function passthroughRawRequest(
  config: ModelConfig,
  body: BodyInit,
  incomingHeaders: Headers,
  options?: UpstreamRequestOptions & { imageOperation?: OpenAIImageOperation; recordedRequestBody?: unknown },
): Promise<{ body: unknown; responseText: string; headers: Headers; status: number; timing: UpstreamTiming }> {
  if (config.subscription_provider) await ensureSubscriptionCredential(config.subscription_provider);
  const url = getUpstreamURLForPath(config, options?.imageOperation);
  const headers = getRawForwardHeaders(config, incomingHeaders, options);
  const preparedBody = await prepareRawBody(config, body, incomingHeaders, options?.recordedRequestBody);
  const upstreamBody = preparedBody?.body ?? body;
  const recordedRequestBody = preparedBody?.recordedRequestBody ?? options?.recordedRequestBody;
  const { response, timing } = await upstreamFetchToUrl(
    config,
    url,
    upstreamBody,
    false,
    headers,
    options,
    recordedRequestBody,
  );
  let responseText = await response.text();
  setRecordedAttemptResponseBody({ index: options?.attemptIndex ?? 0, body: responseText });
  let responseBody: unknown = responseText;
  try {
    responseBody = JSON.parse(responseText);
  } catch {}
  if (isJsonContentType(response.headers)) {
    responseBody = applyModelResponseExpression(config, responseBody, response.headers);
    responseText = JSON.stringify(responseBody);
  }
  return {
    body: responseBody,
    responseText,
    headers: response.headers,
    status: response.status,
    timing,
  };
}

// ─── Passthrough (same format, no conversion) ───────────────────────────────

export async function passthroughRequest(
  config: ModelConfig,
  rawBody: Record<string, unknown>,
  options?: UpstreamRequestOptions,
): Promise<{ json: unknown; timing: UpstreamTiming; usage?: NormalizedUsage }> {
  const body = preparePassthroughBody(config, rawBody, false);
  const { response, timing } = await upstreamFetch(config, JSON.stringify(body), false, { ...options, recordedRequestBody: body });
  const text = await response.text();
  setRecordedAttemptResponseBody({ index: options?.attemptIndex ?? 0, body: text });
  const parsed = JSON.parse(text);
  const json = isJsonContentType(response.headers) ? applyModelResponseExpression(config, parsed, response.headers) : parsed;
  const usage = normalizeUsage((json as Record<string, unknown>)?.usage as Record<string, unknown> | undefined);
  return { json, timing, usage };
}

export async function passthroughStreamRequest(
  config: ModelConfig,
  rawBody: Record<string, unknown>,
  options?: UpstreamRequestOptions,
): Promise<{ body: ReadableStream<Uint8Array>; headers: Headers; timing: UpstreamTiming }> {
  const body = preparePassthroughBody(config, rawBody, true);
  const { response, timing } = await upstreamFetch(config, JSON.stringify(body), true, { ...options, recordedRequestBody: body });
  if (!response.body) throw new Error("Upstream returned no streaming body");
  const validatedBody = await validateStreamContent(response.body, { attemptIndex: options?.attemptIndex ?? 0, config, headers: response.headers });
  return { body: validatedBody, headers: response.headers, timing };
}

// ─── Forward with conversion (different format) ────────────────────────────

export async function forwardRequest(
  config: ModelConfig,
  normalized: NormalizedRequest,
  options?: UpstreamRequestOptions,
): Promise<{ normalizedResponse: NormalizedResponse; timing: UpstreamTiming; usage?: NormalizedUsage }> {
  normalized.stream = false;
  normalized.model = config.model;
  normalized.image = config.image ?? true;

  const body = applyModelBodyTransforms(config, applyOpenAIDefaults(config.provider, denormalizeRequest(config, normalized)));
  const { response, timing } = await upstreamFetch(config, JSON.stringify(body), false, { ...options, recordedRequestBody: body });
  const text = await response.text();
  setRecordedAttemptResponseBody({ index: options?.attemptIndex ?? 0, body: text });
  const parsed = JSON.parse(text);
  const json = isJsonContentType(response.headers) ? applyModelResponseExpression(config, parsed, response.headers) : parsed;
  const normalizedResponse = normalizeUpstreamResponse(config.provider, json);
  return { normalizedResponse, timing, usage: normalizedResponse.usage };
}

export async function forwardStreamRequest(
  config: ModelConfig,
  normalized: NormalizedRequest,
  options?: UpstreamRequestOptions,
): Promise<{ body: ReadableStream<Uint8Array>; upstreamFormat: StreamFormat; timing: UpstreamTiming }> {
  normalized.stream = true;
  normalized.model = config.model;
  normalized.image = config.image ?? true;

  const body = applyModelBodyTransforms(config, applyOpenAIDefaults(config.provider, denormalizeRequest(config, normalized)));
  const { response, timing } = await upstreamFetch(config, JSON.stringify(body), true, { ...options, recordedRequestBody: body });
  if (!response.body) throw new Error("Upstream returned no streaming body");
  const validatedBody = await validateStreamContent(response.body, { attemptIndex: options?.attemptIndex ?? 0, config, headers: response.headers });
  return { body: validatedBody, upstreamFormat: config.provider, timing };
}
