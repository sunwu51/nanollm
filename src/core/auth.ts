import { timingSafeEqual } from "node:crypto";
import { getPublicModelNames, resolveModelForRequest, type ServerConfig, type TokenConfig } from "./config.js";

export function extractBearerToken(headerValue: string | null | undefined): string | undefined {
  if (!headerValue) return undefined;
  const match = /^\s*Bearer\s+(.+)\s*$/i.exec(headerValue);
  if (!match) return undefined;
  const token = match[1].trim();
  return token ? token : undefined;
}

/** The client's token from `Authorization: Bearer`, or from `x-api-key` (Anthropic SDK clients). */
export function extractRequestToken(headers: Headers): string | undefined {
  return extractBearerToken(headers.get("authorization")) ?? (headers.get("x-api-key")?.trim() || undefined);
}

export function isAuthorizedToken(expectedToken: string | undefined, candidateToken: string | undefined): boolean {
  if (!expectedToken) return true;
  if (!candidateToken) return false;
  const expected = Buffer.from(expectedToken);
  const candidate = Buffer.from(candidateToken);
  if (expected.length !== candidate.length) return false;
  return timingSafeEqual(expected, candidate);
}

export function buildAuthCookieValue(token: string): string {
  return encodeURIComponent(token);
}

export function readAuthCookie(cookieHeader: string | null | undefined, cookieName: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const segment of cookieHeader.split(";")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    if (key !== cookieName) continue;
    const value = trimmed.slice(separatorIndex + 1);
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

function matchesToken(expectedToken: string | undefined, candidateToken: string | undefined): boolean {
  return Boolean(expectedToken) && isAuthorizedToken(expectedToken, candidateToken);
}

function findClientToken(config: ServerConfig, candidateToken: string | undefined): TokenConfig | undefined {
  if (!candidateToken) return undefined;
  // Compare against every token so the timing doesn't reveal which one matched.
  return config.tokens.reduce<TokenConfig | undefined>((matched, token) => (matchesToken(token.value, candidateToken) ? token : matched), undefined);
}

/** Whether the token is one of the `tokens` entries. */
export function isScopedToken(config: ServerConfig, candidateToken: string | undefined): boolean {
  return Boolean(findClientToken(config, candidateToken));
}

/** The name a token maps `name` to: an exact client name first, then the longest `prefix*` one. */
function mapTokenName(token: TokenConfig, name: string): string | undefined {
  const exact = token.models.find((mapping) => mapping.alias === name);
  if (exact) return exact.target;
  let best: { target: string; prefix: string } | undefined;
  for (const { alias, target } of token.models) {
    if (!alias.endsWith("*")) continue;
    const prefix = alias.slice(0, -1);
    if (name.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) best = { target, prefix };
  }
  if (!best) return undefined;
  return best.target.endsWith("*") ? best.target.slice(0, -1) + name.slice(best.prefix.length) : best.target;
}

/** The config entry a public name routes to: the group, the model, or the wildcard model whose pattern matches it. */
function getPublicEntryName(config: ServerConfig, name: string): string | undefined {
  if (name in config.fallback) return name;
  return resolveModelForRequest(config, name)?.model.name;
}

/** Without an admin token, public names are open, except the models and groups some token maps to. */
function isOpenName(config: ServerConfig, name: string): boolean {
  if (config.auth?.token) return false;
  const entry = getPublicEntryName(config, name);
  return entry === undefined || !config.tokens.some((token) => token.models.some((mapping) => mapping.target === entry));
}

/**
 * The public model or group name a request for `name` routes to, or undefined when its token can't use it.
 * The admin token uses every public name as is. A client token uses the names in its `available_models`,
 * mapped to their targets, plus the names open to everyone.
 */
export function resolveModelAccess(config: ServerConfig, name: string, candidateToken: string | undefined): string | undefined {
  if (matchesToken(config.auth?.token, candidateToken)) return name;
  const token = findClientToken(config, candidateToken);
  const mapped = token ? mapTokenName(token, name) : undefined;
  if (mapped !== undefined) return mapped;
  return isOpenName(config, name) ? name : undefined;
}

/** For in-process calls (jobs, model tests, replays): public names route as is, other names through the first token that maps them. */
export function resolveInternalModelName(config: ServerConfig, name: string): string {
  if (getPublicEntryName(config, name) !== undefined) return name;
  for (const token of config.tokens) {
    const mapped = mapTokenName(token, name);
    if (mapped !== undefined) return mapped;
  }
  return name;
}

export function canAccessModel(config: ServerConfig, name: string, candidateToken: string | undefined): boolean {
  return resolveModelAccess(config, name, candidateToken) !== undefined;
}

/** The names a token can request, each with the public model or group name it routes to. */
export function listAccessibleModels(config: ServerConfig, candidateToken: string | undefined): Array<{ name: string; target: string }> {
  if (matchesToken(config.auth?.token, candidateToken)) return getPublicModelNames(config).map((name) => ({ name, target: name }));
  const token = findClientToken(config, candidateToken);
  const listed = (token?.models ?? []).map(({ alias, target }) => ({ name: alias, target }));
  const names = new Set(listed.map((entry) => entry.name));
  const open = getPublicModelNames(config).filter((name) => !names.has(name) && isOpenName(config, name)).map((name) => ({ name, target: name }));
  return [...listed, ...open];
}

export function getAccessibleModelNames(config: ServerConfig, candidateToken: string | undefined): string[] {
  return listAccessibleModels(config, candidateToken).map((entry) => entry.name);
}
