// @ts-nocheck
import type { ModelConfig } from "./config.js";
import type { StreamFormat } from "./converters/streams.js";
import type { NormalizedRequest, NormalizedResponse } from "./converters/shared.js";
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
import { ProxyAgent, fetch as undiciFetch } from "undici";

interface UpstreamRequestOptions {
  userAgent?: string;
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

async function upstreamFetch(config: ModelConfig, body: string, stream: boolean, options?: UpstreamRequestOptions): Promise<Response> {
  const url = getUpstreamURL(config);
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const timeoutMs = config.ttfb_timeout;
  const abortController = timeoutMs !== undefined ? new AbortController() : undefined;
  let timeoutHandle: NodeJS.Timeout | undefined;

  const fetchOptions: RequestInit = {
    method: "POST",
    headers: getForwardHeaders(config, options),
    body,
    ...(abortController ? { signal: abortController.signal } : {}),
  };

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
      const err = new Error(`Upstream TTFB timeout after ${timeoutMs}ms`) as Error & { cause?: unknown };
      err.cause = error;
      throw err;
    }
    throw error;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Upstream ${res.status}: ${text}`) as Error & { status: number; upstream: string };
    err.status = res.status;
    err.upstream = text;
    throw err;
  }

  return res;
}

// ─── Passthrough (same format, no conversion) ───────────────────────────────

export async function passthroughRequest(
  config: ModelConfig,
  rawBody: Record<string, unknown>,
  options?: UpstreamRequestOptions,
): Promise<unknown> {
  const body = applyModelBodyOverrides(config, { ...rawBody, model: config.model, stream: false });
  const res = await upstreamFetch(config, JSON.stringify(body), false, options);
  return res.json();
}

export async function passthroughStreamRequest(
  config: ModelConfig,
  rawBody: Record<string, unknown>,
  options?: UpstreamRequestOptions,
): Promise<{ body: ReadableStream<Uint8Array>; headers: Headers }> {
  const body = applyModelBodyOverrides(config, { ...rawBody, model: config.model, stream: true });
  const res = await upstreamFetch(config, JSON.stringify(body), true, options);
  if (!res.body) throw new Error("Upstream returned no streaming body");
  return { body: res.body, headers: res.headers };
}

// ─── Forward with conversion (different format) ────────────────────────────

export async function forwardRequest(
  config: ModelConfig,
  normalized: NormalizedRequest,
  options?: UpstreamRequestOptions,
): Promise<NormalizedResponse> {
  normalized.stream = false;
  normalized.model = config.model;

  const body = applyModelBodyOverrides(config, applyOpenAIDefaults(config.provider, denormalizeRequest(config.provider, normalized)));
  const res = await upstreamFetch(config, JSON.stringify(body), false, options);
  const json = await res.json();
  return normalizeUpstreamResponse(config.provider, json);
}

export async function forwardStreamRequest(
  config: ModelConfig,
  normalized: NormalizedRequest,
  options?: UpstreamRequestOptions,
): Promise<{ body: ReadableStream<Uint8Array>; upstreamFormat: StreamFormat }> {
  normalized.stream = true;
  normalized.model = config.model;

  const body = applyModelBodyOverrides(config, applyOpenAIDefaults(config.provider, denormalizeRequest(config.provider, normalized)));
  const res = await upstreamFetch(config, JSON.stringify(body), true, options);
  if (!res.body) throw new Error("Upstream returned no streaming body");
  return { body: res.body, upstreamFormat: config.provider };
}
