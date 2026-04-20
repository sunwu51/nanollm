// @ts-nocheck
import type { ModelConfig } from "./config.js";
import type { StreamFormat } from "./converters/streams.js";
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
import { ProxyAgent, fetch as undiciFetch } from "undici";

export interface UpstreamRequestOptions {
  userAgent?: string;
  attemptIndex?: number;
  modelName?: string;
}

export interface UpstreamTiming {
  startedAt: number;
  responseStartedAt: number;
  ttfbMs: number;
}

// ─── Upstream URL ───────────────────────────────────────────────────────────

export function getUpstreamURL(config: ModelConfig): string {
  const base = config.base_url.replace(/\/+$/, "");
  switch (config.provider) {
    case "openai-chat":
      return `${base}/chat/completions`;
    case "openai-responses":
      return `${base}/responses`;
    case "anthropic":
      return `${base}/messages`;
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

// ─── Auth Headers ───────────────────────────────────────────────────────────

function getAuthHeaders(config: ModelConfig): Record<string, string> {
  switch (config.provider) {
    case "openai-chat":
    case "openai-responses":
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

function denormalizeRequest(provider: StreamFormat, normalized: NormalizedRequest): unknown {
  switch (provider) {
    case "openai-chat":
      return denormalizeToOpenAIChatRequest(normalized);
    case "openai-responses":
      return denormalizeToOpenAIResponsesRequest(normalized);
    case "anthropic":
      return denormalizeToAnthropicRequest(normalized);
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

async function upstreamFetch(
  config: ModelConfig,
  body: string,
  stream: boolean,
  options?: UpstreamRequestOptions,
): Promise<{ response: Response; timing: UpstreamTiming }> {
  const url = getUpstreamURL(config);
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const timeoutMs = config.ttfb_timeout;
  const abortController = timeoutMs !== undefined ? new AbortController() : undefined;
  let timeoutHandle: NodeJS.Timeout | undefined;
  const startedAt = Date.now();

  const fetchOptions: RequestInit = {
    method: "POST",
    headers: getForwardHeaders(config, options),
    body,
    ...(abortController ? { signal: abortController.signal } : {}),
  };
  ensureRecordedAttempt({
    index: options?.attemptIndex ?? 0,
    provider: config.provider,
    modelName: options?.modelName ?? config.name,
    url,
    requestHeaders: fetchOptions.headers as Record<string, string>,
    requestBody: body,
  });

  if (proxyUrl) {
    fetchOptions.dispatcher = new ProxyAgent(proxyUrl);
  }

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

  return { response: res, timing };
}

// ─── Passthrough (same format, no conversion) ───────────────────────────────

export async function passthroughRequest(
  config: ModelConfig,
  rawBody: Record<string, unknown>,
  options?: UpstreamRequestOptions,
): Promise<{ json: unknown; timing: UpstreamTiming; usage?: NormalizedUsage }> {
  const body = applyModelBodyOverrides(config, { ...rawBody, model: config.model, stream: false });
  const { response, timing } = await upstreamFetch(config, JSON.stringify(body), false, options);
  const text = await response.text();
  setRecordedAttemptResponseBody({ index: options?.attemptIndex ?? 0, body: text });
  const json = JSON.parse(text);
  const usage = normalizeUsage((json as Record<string, unknown>)?.usage as Record<string, unknown> | undefined);
  return { json, timing, usage };
}

export async function passthroughStreamRequest(
  config: ModelConfig,
  rawBody: Record<string, unknown>,
  options?: UpstreamRequestOptions,
): Promise<{ body: ReadableStream<Uint8Array>; headers: Headers; timing: UpstreamTiming }> {
  const body = applyModelBodyOverrides(config, { ...rawBody, model: config.model, stream: true });
  const { response, timing } = await upstreamFetch(config, JSON.stringify(body), true, options);
  if (!response.body) throw new Error("Upstream returned no streaming body");
  return { body: response.body, headers: response.headers, timing };
}

// ─── Forward with conversion (different format) ────────────────────────────

export async function forwardRequest(
  config: ModelConfig,
  normalized: NormalizedRequest,
  options?: UpstreamRequestOptions,
): Promise<{ normalizedResponse: NormalizedResponse; timing: UpstreamTiming; usage?: NormalizedUsage }> {
  normalized.stream = false;
  normalized.model = config.model;

  const body = applyModelBodyOverrides(config, applyOpenAIDefaults(config.provider, denormalizeRequest(config.provider, normalized)));
  const { response, timing } = await upstreamFetch(config, JSON.stringify(body), false, options);
  const text = await response.text();
  setRecordedAttemptResponseBody({ index: options?.attemptIndex ?? 0, body: text });
  const json = JSON.parse(text);
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

  const body = applyModelBodyOverrides(config, applyOpenAIDefaults(config.provider, denormalizeRequest(config.provider, normalized)));
  const { response, timing } = await upstreamFetch(config, JSON.stringify(body), true, options);
  if (!response.body) throw new Error("Upstream returned no streaming body");
  return { body: response.body, upstreamFormat: config.provider, timing };
}
