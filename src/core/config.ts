import { readFileSync } from "node:fs";
import { parse as parseYAML } from "yaml";
import type { StreamFormat } from "../converters/streams.js";
import { compileRecordRule } from "./record-rule.js";

export const DEFAULT_PORT = 3000;
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
  claude_subscription_provider?: string;
  image?: boolean;
  ttfb_timeout?: number;
  allow_h2?: boolean;
  proxy?: string;
  provider_proxy?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  bodyExpression?: string;
  responseExpression?: string;
  body_expression?: string;
  response_expression?: string;
  ignore_invalid_history?: boolean;
  reasoning_profile?: ReasoningProfile;
}

/** How replayed thinking is adapted to the upstream (see proxy/reasoning-history). */
export type ReasoningProfile = "auto" | "claude" | "deepseek" | "none";
const REASONING_PROFILES: readonly ReasoningProfile[] = ["auto", "claude", "deepseek", "none"];

export type SubscriptionProviderType = "openai-subscription" | "claude-subscription";
export const CLAUDE_SUBSCRIPTION_BASE_URL = "https://api.anthropic.com/v1";

export function isSubscriptionProviderType(value: unknown): value is SubscriptionProviderType {
  return value === "openai-subscription" || value === "claude-subscription";
}

export interface CustomProviderConfig {
  name: string;
  provider: StreamFormat | SubscriptionProviderType;
  base_url: string;
  api_key: string;
  proxy?: string;
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
  tokens: TokenConfig[];
  record: {
    max_size: number;
    /** JS expression over the client request; when truthy the request is not recorded. */
    skip_when?: string;
  };
}

/** One `available_models` entry: the name a client sends, and the model or fallback group it routes to. */
export interface TokenModelMapping {
  alias: string;
  target: string;
}

/** A client token that may use only the names in its `available_models`. */
export interface TokenConfig {
  name?: string;
  value: string;
  models: TokenModelMapping[];
}

export interface TokenDocument {
  name?: string;
  value?: string;
  available_models?: Array<string | Record<string, string>>;
}

export interface ParsedConfigDocument {
  server?: { port?: number; ttfb_timeout?: number; auth?: { token?: string } };
  record?: { max_size?: number; skip_when?: string };
  models?: Array<Partial<ModelConfig> & Pick<ModelConfig, "name" | "model">>;
  providers?: CustomProviderConfig[];
  fallback?: Record<string, string[]>;
  tokens?: TokenDocument[];
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

export function resolveEnvVars(value: string): string {
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

function normalizeReasoningProfile(value: unknown, fieldName: string): ReasoningProfile {
  if (value === undefined || value === null || value === "") return "auto";
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : value;
  if (REASONING_PROFILES.includes(normalized as ReasoningProfile)) return normalized as ReasoningProfile;
  throw new Error(`'${fieldName}' must be one of ${REASONING_PROFILES.join(", ")}`);
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

function normalizeRecordRule(value: unknown): string | undefined {
  const expression = normalizeOptionalString(value);
  if (!expression) return undefined;
  try {
    compileRecordRule(expression);
  } catch (error) {
    throw new Error(`'record.skip_when' is not a valid expression: ${error instanceof Error ? error.message : String(error)}`);
  }
  return expression;
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
  const reasoning_profile = normalizeReasoningProfile(model.reasoning_profile, `models.${model.name || "<unknown>"}.reasoning_profile`);
  const proxy = normalizeProxyUrl(model.proxy, `models.${model.name || "<unknown>"}.proxy`);

  const normalized = {
    ...model,
    image,
    allow_h2,
    ignore_invalid_history,
    reasoning_profile,
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
  const recordSkipWhen = normalizeRecordRule(document.record?.skip_when);
  const authToken = normalizeOptionalString(options?.authToken ?? document.server?.auth?.token);
  const providers = (document.providers ?? []).map((provider) => {
    const name = String(provider.name || "").trim();
    const proxy = normalizeProxyUrl(provider.proxy, `providers.${name || "<unknown>"}.proxy`);
    const normalized: CustomProviderConfig = {
      ...provider,
      name,
      provider: provider.provider,
      base_url: String(provider.base_url || "").trim(),
      api_key: resolveEnvVars(String(provider.api_key || "")),
      proxy,
    };
    if (!proxy) delete normalized.proxy;
    return normalized;
  });
  const providerNames = new Set<string>();
  for (const provider of providers) {
    if (!provider.name) throw new Error("Provider config missing 'name'");
    if (providerNames.has(provider.name)) throw new Error(`Duplicate provider name '${provider.name}'`);
    providerNames.add(provider.name);
    if (!provider.provider) throw new Error(`Provider '${provider.name}' missing 'provider'`);
    const subscription = isSubscriptionProviderType(provider.provider);
    if (!subscription && !provider.base_url) throw new Error(`Provider '${provider.name}' missing 'base_url'`);
    if (!subscription && !['openai-chat', 'openai-responses', 'anthropic', 'openai-image'].includes(provider.provider)) {
      throw new Error(`Provider '${provider.name}' has invalid provider '${provider.provider}'`);
    }
    if (subscription && (provider.base_url || provider.api_key)) {
      throw new Error(`Provider '${provider.name}' of type '${provider.provider}' cannot configure 'base_url' or 'api_key'`);
    }
  }
  const models = (document.models ?? []).map((sourceModel) => {
    if (Object.hasOwn(sourceModel, "auth_token")) {
      throw new Error(`Model '${sourceModel.name}' uses 'auth_token'; access tokens are now configured in the top-level 'tokens' list`);
    }
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
        ? { ...sourceModel, custom_provider: customProviderName, subscription_provider: customProviderName, provider: "openai-responses", base_url: "https://chatgpt.com/backend-api/codex", api_key: "", ...(customProvider.proxy ? { provider_proxy: customProvider.proxy } : {}) }
        : customProvider.provider === "claude-subscription"
        ? { ...sourceModel, custom_provider: customProviderName, claude_subscription_provider: customProviderName, provider: "anthropic", base_url: CLAUDE_SUBSCRIPTION_BASE_URL, api_key: "", ...(customProvider.proxy ? { provider_proxy: customProvider.proxy } : {}) }
        : { ...sourceModel, custom_provider: customProviderName, provider: customProvider.provider, base_url: customProvider.base_url, api_key: customProvider.api_key, ...(customProvider.proxy ? { provider_proxy: customProvider.proxy } : {}) }
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
  const tokens = normalizeTokens(document.tokens, new Set([...Object.keys(fallback), ...models.map((model) => model.name)]), authToken);

  return {
    port: Number(process.env.PORT) || options?.port || (document.server?.port ?? DEFAULT_PORT),
    ...(defaultTTFBTimeout !== undefined ? { ttfb_timeout: defaultTTFBTimeout } : {}),
    ...(authToken ? { auth: { token: authToken } } : {}),
    models,
    providers,
    fallback,
    tokens,
    record: {
      max_size: recordMaxSize,
      ...(recordSkipWhen ? { skip_when: recordSkipWhen } : {}),
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

function normalizeTokenMapping(entry: unknown, path: string): TokenModelMapping {
  // `- gpt-5` is short for `- gpt-5: gpt-5`.
  if (typeof entry === "string") return { alias: entry.trim(), target: entry.trim() };
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).length !== 1) {
    throw new Error(`'${path}' must be a 'client name: model or group' pair`);
  }
  const [[alias, target]] = Object.entries(entry);
  return { alias: alias.trim(), target: String(target ?? "").trim() };
}

function normalizeTokens(document: unknown, publicNames: Set<string>, adminToken: string | undefined): TokenConfig[] {
  if (document === undefined || document === null) return [];
  if (!Array.isArray(document)) throw new Error("'tokens' must be a list");
  const values = new Set<string>();
  return document.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`'tokens[${index}]' must be an object`);
    const source = entry as TokenDocument;
    const name = normalizeOptionalString(source.name);
    const label = name ? `Token '${name}'` : `'tokens[${index}]'`;
    if (source.value === undefined || source.value === null || !String(source.value).trim()) throw new Error(`${label} is missing 'value'`);
    // An unset ${ENV_VAR} leaves the value empty; such a token matches no request.
    const value = resolveEnvVars(String(source.value)).trim();
    if (value) {
      if (values.has(value)) throw new Error(`${label} repeats the value of another token`);
      if (value === adminToken) throw new Error(`${label} has the same value as 'server.auth.token'`);
      values.add(value);
    }
    const mappings = source.available_models ?? [];
    if (!Array.isArray(mappings)) throw new Error(`${label}: 'available_models' must be a list`);
    const aliases = new Set<string>();
    const models = mappings.map((mapping, mappingIndex) => {
      const { alias, target } = normalizeTokenMapping(mapping, `tokens[${index}].available_models[${mappingIndex}]`);
      if (!alias || !target) throw new Error(`${label}: each 'available_models' entry needs a client name and a model or group`);
      assertValidModelNamePattern(alias);
      if (aliases.has(alias)) throw new Error(`${label} lists '${alias}' more than once`);
      aliases.add(alias);
      if (!publicNames.has(target)) throw new Error(`${label} maps '${alias}' to unknown model or group '${target}'`);
      if (target.endsWith("*") && !alias.endsWith("*")) throw new Error(`${label}: '${alias}' must end with '*' to map to wildcard model '${target}'`);
      return { alias, target };
    });
    return { ...(name ? { name } : {}), value, models };
  });
}
