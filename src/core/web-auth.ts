import type { Context, MiddlewareHandler } from "hono";
import { buildAuthCookieValue, extractBearerToken, isAuthorizedToken, readAuthCookie } from "./auth.js";
import { renderLoginPage } from "../pages/login-page.js";

const COOKIE_NAME = "nanollm_auth";
const COOKIE_MAX_AGE = 90 * 24 * 60 * 60;
const PAGE_PATHS = new Set(["/admin", "/admin/config", "/status", "/record", "/jobs"]);

function safeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/admin";
  const url = new URL(value, "http://localhost");
  if (url.origin !== "http://localhost" || !PAGE_PATHS.has(url.pathname)) return "/admin";
  url.searchParams.delete("token");
  return url.pathname + url.search;
}

function persistCookie(c: Context, token: string): void {
  const secure = new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
  c.header("Set-Cookie", `${COOKIE_NAME}=${buildAuthCookieValue(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}${secure ? "; Secure" : ""}`);
}

export function webAuth(getToken: () => string | undefined): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === "OPTIONS" || c.req.path === "/health") return next();
    const token = getToken();
    const authorized = !token || [
      extractBearerToken(c.req.header("authorization")),
      readAuthCookie(c.req.header("cookie"), COOKIE_NAME),
    ].some((candidate) => isAuthorizedToken(token, candidate));

    if (c.req.path === "/login" && (c.req.method === "GET" || c.req.method === "POST")) {
      c.header("Cache-Control", "no-store");
      c.header("Referrer-Policy", "no-referrer");
      if (c.req.method === "GET") {
        const returnTo = safeReturnTo(c.req.query("returnTo"));
        if (authorized) {
          if (token) persistCookie(c, token);
          return c.redirect(returnTo, 303);
        }
        return c.html(renderLoginPage(returnTo));
      }
      const body = await c.req.parseBody();
      const returnTo = safeReturnTo(body.returnTo);
      if (!token || isAuthorizedToken(token, typeof body.password === "string" ? body.password : undefined)) {
        if (token) persistCookie(c, token);
        return c.redirect(returnTo, 303);
      }
      return c.html(renderLoginPage(returnTo, true), 401);
    }

    if (PAGE_PATHS.has(c.req.path)) {
      c.header("Cache-Control", "no-store");
      c.header("Referrer-Policy", "no-referrer");
    }
    if (authorized) {
      if (token) persistCookie(c, token);
      return next();
    }
    if (c.req.method === "GET" && PAGE_PATHS.has(c.req.path)) {
      const url = new URL(c.req.url);
      return c.redirect("/login?returnTo=" + encodeURIComponent(safeReturnTo(url.pathname + url.search)), 302);
    }
    c.header("WWW-Authenticate", "Bearer");
    c.header("X-Nanollm-Auth-Required", "1");
    return c.json({ error: "Unauthorized" }, 401);
  };
}
