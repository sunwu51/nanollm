import { readFileSync } from "node:fs";
import { parse as parseYAML } from "yaml";
import type { StreamFormat } from "./converters/streams.js";

export const DEFAULT_RECORD_MAX_SIZE = 10;
export const DEFAULT_TTFB_TIMEOUT = 5000;
export const DEFAULT_OPENAI_IMAGE_TTFB_TIMEOUT = 600000;

export interface ModelConfig {
  name: string;
  provider: StreamFormat;
  base_url: string;
  api_key: string;
  model: string;
  custom_provider?: string;
  subscription_provider?: string;
  image?: boolean;
  ttfb_timeout?: number;
  allow_h2?: boolean;
  proxy?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  bodyExpression?: string;
  responseExpression?: string;
  body_expression?: string;
  response_expression?: string;
  ignore_invalid_history?: boolean;
}

export interface CustomProviderConfig {
  name: string;
  provider: StreamFormat | "openai-subscription";
  base_url: string;
  api_key: string;
}

export interface ServerConfig {
  port: number;
  ttfb_timeout?: number;
  auth?: {
    token?: string;
  };
  models: ModelConfig[];
  providers: CustomProviderConfig[];
  fallback: Record<string, string[]>;
  record: {
    max_size: number;
  };
}

export interface ParsedConfigDocument {
  server?: { port?: number; ttfb_timeout?: number; auth?: { token?: string } };
  record?: { max_size?: number };
  models?: Array<Partial<ModelConfig> & Pick<ModelConfig, "name" | "model">>;
  providers?: CustomProviderConfig[];
  fallback?: Record<string, string[]>;
}

export interface MaterializeConfigOptions {
  port?: number;
  ttfb_timeout?: number;
  recordMaxSize?: number;
  authToken?: string;
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

function normalizeOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  return normalized ? normalized : undefined;
}

function normalizeBoolean(value: unknown, fieldName: string, defaultValue: boolean): boolean {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  throw new Error(`'${fieldName}' must be a boolean`);
}

function normalizeExpressionAlias(model: ModelConfig, snakeKey: "body_expression" | "response_expression", camelKey: "bodyExpression" | "responseExpression"): string | undefined {
  const snakeValue = model[snakeKey];
  const camelValue = model[camelKey];
  if (snakeValue !== undefined && camelValue !== undefined) {
    throw new Error(`Model '${model.name || "<unknown>"}' cannot configure both '${snakeKey}' and '${camelKey}'`);
  }
  const value = snakeValue ?? camelValue;
  return value === undefined || value === null || value === "" ? undefined : String(value);
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
  const bodyExpression = normalizeExpressionAlias(model, "body_expression", "bodyExpression");
  const responseExpression = normalizeExpressionAlias(model, "response_expression", "responseExpression");
  const modelTTFBTimeout = normalizeTimeout(model.ttfb_timeout, `models.${model.name || "<unknown>"}.ttfb_timeout`);
  const ttfb_timeout = modelTTFBTimeout ?? (model.provider === "openai-image" ? DEFAULT_OPENAI_IMAGE_TTFB_TIMEOUT : defaultTTFBTimeout);
  const image = model.image === undefined ? true : !!model.image;
  const allow_h2 = normalizeBoolean(model.allow_h2, `models.${model.name || "<unknown>"}.allow_h2`, false);
  const ignore_invalid_history = normalizeBoolean(model.ignore_invalid_history, `models.${model.name || "<unknown>"}.ignore_invalid_history`, true);
  const proxy = normalizeProxyUrl(model.proxy, `models.${model.name || "<unknown>"}.proxy`);

  const normalized = {
    ...model,
    image,
    allow_h2,
    ignore_invalid_history,
    proxy,
    ...(ttfb_timeout !== undefined ? { ttfb_timeout } : {}),
    ...(headers ? { headers } : {}),
    ...(body ? { body } : {}),
    ...(bodyExpression ? { bodyExpression } : {}),
    ...(responseExpression ? { responseExpression } : {}),
  };
  delete normalized.body_expression;
  delete normalized.response_expression;
  return normalized;
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

function parseDocument(rawText: string): ParsedConfigDocument {
  return parseYAML(rawText) as ParsedConfigDocument;
}

export function parseConfigDocument(rawText: string): ParsedConfigDocument {
  return parseDocument(rawText);
}

export function parseSourceConfigDocument(rawText: string): ParsedConfigDocument {
  return parseDocument(rawText);
}

export function materializeConfig(document: ParsedConfigDocument, options?: MaterializeConfigOptions): ServerConfig {
  const defaultTTFBTimeout = options?.ttfb_timeout ?? normalizeTimeout(document.server?.ttfb_timeout, "server.ttfb_timeout") ?? DEFAULT_TTFB_TIMEOUT;
  const recordMaxSize = options?.recordMaxSize ?? (normalizePositiveInteger(document.record?.max_size, "record.max_size") ?? DEFAULT_RECORD_MAX_SIZE);
  const authToken = normalizeOptionalString(options?.authToken ?? document.server?.auth?.token);
  const providers = (document.providers ?? []).map((provider) => ({
    ...provider,
    name: String(provider.name || "").trim(),
    provider: provider.provider,
    base_url: String(provider.base_url || "").trim(),
    api_key: resolveEnvVars(String(provider.api_key || "")),
  }));
  const providerNames = new Set<string>();
  for (const provider of providers) {
    if (!provider.name) throw new Error("Provider config missing 'name'");
    if (providerNames.has(provider.name)) throw new Error(`Duplicate provider name '${provider.name}'`);
    providerNames.add(provider.name);
    if (!provider.provider) throw new Error(`Provider '${provider.name}' missing 'provider'`);
    if (provider.provider !== "openai-subscription" && !provider.base_url) throw new Error(`Provider '${provider.name}' missing 'base_url'`);
    if (provider.provider !== "openai-subscription" && !['openai-chat', 'openai-responses', 'anthropic', 'openai-image'].includes(provider.provider)) {
      throw new Error(`Provider '${provider.name}' has invalid provider '${provider.provider}'`);
    }
    if (provider.provider === "openai-subscription" && (provider.base_url || provider.api_key)) {
      throw new Error(`Provider '${provider.name}' of type 'openai-subscription' cannot configure 'base_url' or 'api_key'`);
    }
  }
  const models = (document.models ?? []).map((sourceModel) => {
    const customProviderName = String(sourceModel.custom_provider || "").trim();
    if (customProviderName) {
      const conflictingFields = ["provider", "base_url", "api_key"].filter((field) => Object.hasOwn(sourceModel, field));
      if (conflictingFields.length > 0) {
        throw new Error(
          `Model '${sourceModel.name}' cannot combine 'custom_provider' with ${conflictingFields.map((field) => `'${field}'`).join(", ")}`,
        );
      }
    }
    const customProvider = customProviderName ? providers.find((provider) => provider.name === customProviderName) : undefined;
    if (customProviderName && !customProvider) {
      throw new Error(`Model '${sourceModel.name}' references unknown custom provider '${customProviderName}'`);
    }
    const expanded = customProvider
      ? customProvider.provider === "openai-subscription"
        ? { ...sourceModel, custom_provider: customProviderName, subscription_provider: customProviderName, provider: "openai-responses", base_url: "https://chatgpt.com/backend-api/codex", api_key: "" }
        : { ...sourceModel, custom_provider: customProviderName, provider: customProvider.provider, base_url: customProvider.base_url, api_key: customProvider.api_key }
      : { ...sourceModel, api_key: resolveEnvVars(String(sourceModel.api_key || "")) };
    return normalizeModelConfig(expanded as ModelConfig, defaultTTFBTimeout);
  });
  const fallback = document.fallback ?? {};

  for (const m of models) {
    if (!m.name) throw new Error("Model config missing 'name'");
    if (!m.provider) throw new Error(`Model '${m.name}' missing 'provider'`);
    if (!m.base_url) throw new Error(`Model '${m.name}' missing 'base_url'`);
    if (!m.model) throw new Error(`Model '${m.name}' missing 'model'`);
    if (!["openai-chat", "openai-responses", "anthropic", "openai-image"].includes(m.provider)) {
      throw new Error(`Model '${m.name}' has invalid provider '${m.provider}'. Must be openai-chat, openai-responses, anthropic, or openai-image`);
    }
  }
  validateFallback(models, fallback);

  return {
    port: Number(process.env.PORT) || options?.port || (document.server?.port ?? 3000),
    ...(defaultTTFBTimeout !== undefined ? { ttfb_timeout: defaultTTFBTimeout } : {}),
    ...(authToken ? { auth: { token: authToken } } : {}),
    models,
    providers,
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
