import { timingSafeEqual } from "node:crypto";
import { getModelAuthToken, getPublicModelNames, type ServerConfig } from "./config.js";

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

/** Whether the token is the `auth_token` of any model or fallback group. */
export function isScopedToken(config: ServerConfig, candidateToken: string | undefined): boolean {
  if (!candidateToken) return false;
  const tokens = [...config.models.map((model) => model.auth_token), ...Object.values(config.fallback_auth_tokens ?? {})];
  // Compare against every token so the timing doesn't reveal which one matched.
  return tokens.reduce((matched, token) => matchesToken(token, candidateToken) || matched, false);
}

/**
 * A model or group name is reachable with the admin token or with its own `auth_token`.
 * Names without their own token are open only when no admin token is configured.
 * A member's token doesn't open its group, and a group's token doesn't open its members by name.
 */
export function canAccessModel(config: ServerConfig, name: string, candidateToken: string | undefined): boolean {
  const adminToken = config.auth?.token;
  if (matchesToken(adminToken, candidateToken)) return true;
  const ownToken = getModelAuthToken(config, name);
  if (ownToken) return matchesToken(ownToken, candidateToken);
  return !adminToken;
}

export function getAccessibleModelNames(config: ServerConfig, candidateToken: string | undefined): string[] {
  return getPublicModelNames(config).filter((name) => canAccessModel(config, name, candidateToken));
}
