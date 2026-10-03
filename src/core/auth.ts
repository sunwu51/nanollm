import { timingSafeEqual } from "node:crypto";

export function extractBearerToken(headerValue: string | null | undefined): string | undefined {
  if (!headerValue) return undefined;
  const match = /^\s*Bearer\s+(.+)\s*$/i.exec(headerValue);
  if (!match) return undefined;
  const token = match[1].trim();
  return token ? token : undefined;
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
