import { parse as parseYAML, parseDocument } from "yaml";
import { localize } from "../core/i18n.js";
import type { ServerConfig } from "../core/config.js";

/** A token as the /tokens page edits it; `value` keeps its `${ENV_VAR}` form. */
export interface TokenDraft {
  name: string;
  value: string;
  models: Array<{ alias: string; target: string }>;
}

export class TokenValidationError extends Error {}

const text = (value: unknown) => (value === undefined || value === null ? "" : String(value));

function mappingDraft(entry: unknown): { alias: string; target: string } {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const [alias = "", target = ""] = Object.entries(entry)[0] ?? [];
    return { alias, target: text(target) };
  }
  return { alias: text(entry), target: text(entry) };
}

/** The `tokens` list as written in config.yaml. */
export function readTokenDrafts(rawText: string): TokenDraft[] {
  const tokens = (parseYAML(rawText) as { tokens?: unknown } | null)?.tokens;
  if (!Array.isArray(tokens)) return [];
  return tokens.map((entry) => {
    const token = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    return {
      name: text(token.name),
      value: text(token.value),
      models: Array.isArray(token.available_models) ? token.available_models.map(mappingDraft) : [],
    };
  });
}

/** The tokens of the active config, for when config.yaml itself can't be read. */
export function tokenDraftsFromConfig(config: ServerConfig): TokenDraft[] {
  return config.tokens.map((token) => ({ name: token.name ?? "", value: token.value, models: token.models.map((mapping) => ({ ...mapping })) }));
}

export function validateTokenDrafts(value: unknown): TokenDraft[] {
  const invalid = () => new TokenValidationError(localize("tokens 格式不正确", "tokens has an invalid shape"));
  if (!Array.isArray(value)) throw invalid();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid();
    const { name, value: tokenValue, models } = entry as Record<string, unknown>;
    if (typeof name !== "string" || typeof tokenValue !== "string" || !Array.isArray(models)) throw invalid();
    return {
      name: name.trim(),
      value: tokenValue.trim(),
      models: models.map((mapping) => {
        const { alias, target } = (mapping ?? {}) as Record<string, unknown>;
        if (typeof alias !== "string" || typeof target !== "string") throw invalid();
        return { alias: alias.trim(), target: target.trim() };
      }),
    };
  });
}

/** Replaces the `tokens` list in config.yaml text; the rest of the file, comments included, is kept. */
export function writeTokenDrafts(rawText: string, drafts: TokenDraft[]): string {
  const document = parseDocument(rawText);
  if (document.errors.length > 0) throw new TokenValidationError(document.errors[0].message);
  if (drafts.length === 0) {
    document.delete("tokens");
  } else {
    document.set("tokens", document.createNode(drafts.map((draft) => ({
      ...(draft.name ? { name: draft.name } : {}),
      value: draft.value,
      available_models: draft.models.map(({ alias, target }) => ({ [alias]: target })),
    }))));
  }
  return document.toString({ lineWidth: 0 });
}
