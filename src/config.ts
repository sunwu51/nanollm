import { readFileSync } from "node:fs";
import { parse as parseYAML } from "yaml";
import type { StreamFormat } from "./converters/streams.js";

export const DEFAULT_RECORD_MAX_SIZE = 10;
export const DEFAULT_TTFB_TIMEOUT = 5000;

export interface ModelConfig {
  name: string;
  provider: StreamFormat;
  base_url: string;
  api_key: string;
  model: string;
  image?: boolean;
  ttfb_timeout?: number;
  proxy?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface ServerConfig {
  port: number;
  ttfb_timeout?: number;
  models: ModelConfig[];
  fallback: Record<string, string[]>;
  record: {
    max_size: number;
  };
}

export interface ParsedConfigDocument {
  server?: { port?: number; ttfb_timeout?: number };
  record?: { max_size?: number };
  models?: ModelConfig[];
  fallback?: Record<string, string[]>;
}

export interface MaterializeConfigOptions {
  port?: number;
  ttfb_timeout?: number;
  recordMaxSize?: number;
}

export interface ResolvedModelMatch {
  model: ModelConfig;
  captured: string;
  wildcard: boolean;
}

export function getPublicModelNames(config: ServerConfig): string[] {
  return [...Object.keys(config.fallback), ...config.models.map((model) => model.name)];
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] ?? "");
}

function resolveDeep(obj: unknown): unknown {
  if (typeof obj === "string") return resolveEnvVars(obj);
  if (Array.isArray(obj)) return obj.map(resolveDeep);
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = resolveDeep(v);
    }
    return result;
  }
  return obj;
}

function parseJSONLikeValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function normalizeTimeout(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;

  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`'${fieldName}' must be a positive number`);
  }
  return timeout;
}

function normalizePositiveInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;

  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`'${fieldName}' must be a positive integer`);
  }
  return normalized;
}

function normalizeProxyUrl(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;

  const proxy = String(value).trim();
  if (!proxy) return undefined;

  let url: URL;
  try {
    url = new URL(proxy);
  } catch {
    throw new Error(`'${fieldName}' must be a valid URL`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`'${fieldName}' must use http:// or https://`);
  }

  return proxy;
}

function normalizeModelConfig(model: ModelConfig, defaultTTFBTimeout?: number): ModelConfig {
  const headers =
    model.headers && typeof model.headers === "object"
      ? Object.fromEntries(Object.entries(model.headers).map(([key, value]) => [key, String(value)]))
      : undefined;
  const body =
    model.body && typeof model.body === "object"
      ? Object.fromEntries(Object.entries(model.body).map(([key, value]) => [key, parseJSONLikeValue(value)]))
      : undefined;
  const ttfb_timeout = normalizeTimeout(model.ttfb_timeout, `models.${model.name || "<unknown>"}.ttfb_timeout`) ?? defaultTTFBTimeout;
  const image = model.image === undefined ? true : !!model.image;
  const proxy = normalizeProxyUrl(model.proxy, `models.${model.name || "<unknown>"}.proxy`);

  return {
    ...model,
    image,
    proxy,
    ...(ttfb_timeout !== undefined ? { ttfb_timeout } : {}),
    ...(headers ? { headers } : {}),
    ...(body ? { body } : {}),
  };
}

function getWildcardPrefix(name: string): string | undefined {
  if (!name.endsWith("*")) return undefined;
  return name.slice(0, -1);
}

function assertValidModelNamePattern(name: string) {
  const firstWildcard = name.indexOf("*");
  if (firstWildcard !== -1 && firstWildcard !== name.length - 1) {
    throw new Error(`Model '${name}' has invalid wildcard name. '*' must appear only once and at the end`);
  }
}

function parseDocument(rawText: string, options?: { resolveEnv?: boolean }): ParsedConfigDocument {
  const parsed = parseYAML(rawText);
  return (options?.resolveEnv ?? true ? resolveDeep(parsed) : parsed) as ParsedConfigDocument;
}

export function parseConfigDocument(rawText: string): ParsedConfigDocument {
  return parseDocument(rawText, { resolveEnv: true });
}

export function parseSourceConfigDocument(rawText: string): ParsedConfigDocument {
  return parseDocument(rawText, { resolveEnv: false });
}

export function materializeConfig(document: ParsedConfigDocument, options?: MaterializeConfigOptions): ServerConfig {
  const defaultTTFBTimeout = options?.ttfb_timeout ?? normalizeTimeout(document.server?.ttfb_timeout, "server.ttfb_timeout") ?? DEFAULT_TTFB_TIMEOUT;
  const recordMaxSize = options?.recordMaxSize ?? (normalizePositiveInteger(document.record?.max_size, "record.max_size") ?? DEFAULT_RECORD_MAX_SIZE);
  const models = (document.models ?? []).map((model) => normalizeModelConfig(model, defaultTTFBTimeout));
  const fallback = document.fallback ?? {};

  for (const m of models) {
    if (!m.name) throw new Error("Model config missing 'name'");
    if (!m.provider) throw new Error(`Model '${m.name}' missing 'provider'`);
    if (!m.base_url) throw new Error(`Model '${m.name}' missing 'base_url'`);
    if (!m.model) throw new Error(`Model '${m.name}' missing 'model'`);
    if (!["openai-chat", "openai-responses", "anthropic"].includes(m.provider)) {
      throw new Error(`Model '${m.name}' has invalid provider '${m.provider}'. Must be openai-chat, openai-responses, or anthropic`);
    }
  }
  validateFallback(models, fallback);

  return {
    port: Number(process.env.PORT) || options?.port || (document.server?.port ?? 3000),
    ...(defaultTTFBTimeout !== undefined ? { ttfb_timeout: defaultTTFBTimeout } : {}),
    models,
    fallback,
    record: {
      max_size: recordMaxSize,
    },
  };
}

export function parseConfigText(rawText: string): ServerConfig {
  return materializeConfig(parseConfigDocument(rawText));
}

export function loadConfig(path: string): ServerConfig {
  return parseConfigText(readFileSync(path, "utf-8"));
}

export function resolveModel(config: ServerConfig, name: string): ModelConfig | undefined {
  return config.models.find((m) => m.name === name);
}

export function resolveModelForRequest(config: ServerConfig, name: string): ResolvedModelMatch | undefined {
  const exact = resolveModel(config, name);
  if (exact) return { model: exact, captured: "", wildcard: false };

  let best: { model: ModelConfig; prefix: string } | undefined;
  for (const model of config.models) {
    const prefix = getWildcardPrefix(model.name);
    if (prefix === undefined || !name.startsWith(prefix)) continue;
    if (!best || prefix.length > best.prefix.length) {
      best = { model, prefix };
    }
  }

  if (!best) return undefined;
  const captured = name.slice(best.prefix.length);
  return {
    model: {
      ...best.model,
      model: best.model.model.replaceAll("*", captured),
    },
    captured,
    wildcard: true,
  };
}

export function resolveFallbackModels(config: ServerConfig, name: string): string[] {
  if (name in config.fallback) return config.fallback[name];
  return [name];
}

function validateFallback(models: ModelConfig[], fallback: Record<string, string[]>) {
  const knownModels = new Set(models.map((model) => model.name));
  const duplicateNames = new Set<string>();

  for (const model of models) {
    assertValidModelNamePattern(model.name);
    if (duplicateNames.has(model.name)) {
      throw new Error(`Duplicate model name '${model.name}'`);
    }
    duplicateNames.add(model.name);
  }

  for (const [groupName, members] of Object.entries(fallback)) {
    if (!Array.isArray(members) || members.length === 0) {
      throw new Error(`Fallback group '${groupName}' must be a non-empty model array`);
    }
    if (duplicateNames.has(groupName)) {
      throw new Error(`Duplicate public model name '${groupName}'`);
    }
    duplicateNames.add(groupName);

    const seenMembers = new Set<string>();
    for (const member of members) {
      if (!knownModels.has(member)) {
        throw new Error(`Fallback group '${groupName}' references unknown model '${member}'`);
      }
      if (seenMembers.has(member)) {
        throw new Error(`Fallback group '${groupName}' contains duplicate model '${member}'`);
      }
      seenMembers.add(member);
    }
  }
}
