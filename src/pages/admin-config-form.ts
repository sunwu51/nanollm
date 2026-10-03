import { stringify as stringifyYAML } from "yaml";
import { parseSourceConfigDocument, type ServerConfig } from "../core/config.js";

type AdminModelDraft = {
  name: string;
  connection_mode: "direct" | "custom";
  provider: string;
  custom_provider: string;
  base_url: string;
  api_key: string;
  model: string;
  proxy?: string;
  body_expression?: string;
  response_expression?: string;
  extras?: Record<string, unknown>;
};
type AdminProviderDraft = {
  name: string;
  provider: string;
  base_url: string;
  api_key: string;
  proxy?: string;
};
type AdminFallbackDraft = {
  name: string;
  members: string[];
};
export type AdminConfigForm = {
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
  providers: AdminProviderDraft[];
  fallbackGroups: AdminFallbackDraft[];
};

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

export function buildAdminConfigForm(rawText: string): AdminConfigForm {
  const sourceConfig = parseSourceConfigDocument(rawText) as Record<string, unknown>;
  const { server, record, models, providers, fallback, ...rootExtras } = sourceConfig;
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
    providers: Array.isArray(providers)
      ? providers.map((entry) => {
          const providerObject = toPlainObject(entry);
          return {
            name: toInputString(providerObject.name),
            provider: toInputString(providerObject.provider),
            base_url: toInputString(providerObject.base_url),
            api_key: toInputString(providerObject.api_key),
            proxy: toInputString(providerObject.proxy),
          };
        })
      : [],
    models: Array.isArray(models)
      ? models.map((entry) => {
          const modelObject = toPlainObject(entry);
          const {
            name, provider, custom_provider, base_url, api_key, model, proxy,
            body_expression, bodyExpression, response_expression, responseExpression,
            ...extras
          } = modelObject;
          return {
            name: toInputString(name),
            connection_mode: custom_provider ? "custom" : "direct",
            provider: toInputString(provider),
            custom_provider: toInputString(custom_provider),
            base_url: toInputString(base_url),
            api_key: toInputString(api_key),
            model: toInputString(model),
            proxy: toInputString(proxy),
            body_expression: toInputString(body_expression ?? bodyExpression),
            response_expression: toInputString(response_expression ?? responseExpression),
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

export function buildAdminConfigFormFromEffectiveConfig(config: ServerConfig): AdminConfigForm {
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
    providers: config.providers.map((provider) => ({ ...provider, proxy: provider.proxy ?? "" })),
    models: config.models.map((model) => ({
      name: model.name,
      connection_mode: model.custom_provider ? "custom" : "direct",
      provider: model.provider,
      custom_provider: model.custom_provider ?? "",
      base_url: model.base_url,
      api_key: model.api_key,
      model: model.model,
      proxy: model.proxy ?? "",
      body_expression: model.bodyExpression ?? "",
      response_expression: model.responseExpression ?? "",
      extras: {},
    })),
    fallbackGroups: Object.entries(config.fallback).map(([name, members]) => ({
      name,
      members,
    })),
  };
}

export function buildYamlTextFromAdminForm(form: AdminConfigForm, options?: { preservedPort?: unknown }): string {
  const root = toPlainObject(form.rootExtras);
  const serverExtras = toPlainObject(form.serverExtras);
  const recordExtras = toPlainObject(form.recordExtras);
  const preservedPort = toPositiveIntegerOrUndefined(options?.preservedPort, "server.port");
  const serverTTFBTimeout = toPositiveIntegerOrUndefined(form.server?.ttfb_timeout, "server.ttfb_timeout");
  const recordMaxSize = toPositiveIntegerOrUndefined(form.record?.max_size, "record.max_size");

  const providers = Array.isArray(form.providers)
    ? form.providers.map((entry) => {
        const proxy = toInputString(entry.proxy).trim();
        return {
          name: entry.name ?? "",
          provider: entry.provider ?? "",
          ...(entry.provider === "openai-subscription" || entry.provider === "claude-subscription" ? {} : { base_url: entry.base_url ?? "", api_key: entry.api_key ?? "" }),
          ...(proxy ? { proxy } : {}),
        };
      })
    : [];

  const models = Array.isArray(form.models)
    ? form.models.map((entry) => {
        const customProvider = entry.connection_mode === "custom" ? (entry.custom_provider ?? "").trim() : "";
        const { body_expression, bodyExpression: legacyBody, response_expression, responseExpression: legacyResponse, proxy: extraProxy, ...extras } = toPlainObject(entry.extras);
        const proxy = toInputString(entry.proxy || extraProxy).trim();
        const bodyExpression = toInputString(entry.body_expression || body_expression || legacyBody).trim();
        const responseExpression = toInputString(entry.response_expression || response_expression || legacyResponse).trim();
        return {
          ...extras,
          name: entry.name ?? "",
          ...(customProvider
            ? { custom_provider: customProvider }
            : { provider: entry.provider ?? "", base_url: entry.base_url ?? "", api_key: entry.api_key ?? "" }),
          model: entry.model ?? "",
          ...(proxy ? { proxy } : {}),
          ...(bodyExpression ? { body_expression: bodyExpression } : {}),
          ...(responseExpression ? { response_expression: responseExpression } : {}),
        };
      })
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

  if (providers.length > 0) document.providers = providers;

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
