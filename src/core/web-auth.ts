import type { Context, MiddlewareHandler } from "hono";
import { buildAuthCookieValue, extractRequestToken, isAuthorizedToken, readAuthCookie } from "./auth.js";
import { renderLoginPage } from "../pages/login-page.js";
import { resolveLang } from "./i18n.js";

const COOKIE_NAME = "nanollm_auth";
const COOKIE_MAX_AGE = 90 * 24 * 60 * 60;
const PAGE_PATHS = new Set(["/admin", "/admin/config", "/status", "/record", "/jobs"]);
// Routes that name a model; a model/group token may reach them and the route checks the model it names.
const MODEL_API_PATHS = new Set([
  "/v1/models",
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/messages",
  "/v1/images/generations",
  "/v1/images/edits",
  "/v1/alpha/search",
  "/alpha/search",
]);

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

/**
 * The token routes check model access with. A signed-in browser only sends the login cookie,
 * so a cookie holding the admin token counts as the admin token; otherwise the header token is used.
 */
export function getRequestAuthToken(c: Context, adminToken: string | undefined): string | undefined {
  if (adminToken && isAuthorizedToken(adminToken, readAuthCookie(c.req.header("cookie"), COOKIE_NAME))) return adminToken;
  return extractRequestToken(c.req.raw.headers);
}

/** `isScopedToken` lets model/group tokens through to model routes; it never grants pages or a cookie. */
export function webAuth(getToken: () => string | undefined, isScopedToken?: (candidate: string | undefined) => boolean): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === "OPTIONS" || c.req.path === "/health") return next();
    const token = getToken();
    const requestToken = extractRequestToken(c.req.raw.headers);
    const authorized = !token || [
      requestToken,
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
        return c.html(renderLoginPage(returnTo, false, resolveLang(c.req.header("cookie"), c.req.header("accept-language"))));
      }
      const body = await c.req.parseBody();
      const returnTo = safeReturnTo(body.returnTo);
      if (!token || isAuthorizedToken(token, typeof body.password === "string" ? body.password : undefined)) {
        if (token) persistCookie(c, token);
        return c.redirect(returnTo, 303);
      }
      return c.html(renderLoginPage(returnTo, true, resolveLang(c.req.header("cookie"), c.req.header("accept-language"))), 401);
    }

    if (PAGE_PATHS.has(c.req.path)) {
      c.header("Cache-Control", "no-store");
      c.header("Referrer-Policy", "no-referrer");
    }
    if (authorized) {
      if (token) persistCookie(c, token);
      return next();
    }
    if (MODEL_API_PATHS.has(c.req.path) && isScopedToken?.(requestToken)) return next();
    if (c.req.method === "GET" && PAGE_PATHS.has(c.req.path)) {
      const url = new URL(c.req.url);
      return c.redirect("/login?returnTo=" + encodeURIComponent(safeReturnTo(url.pathname + url.search)), 302);
    }
    c.header("WWW-Authenticate", "Bearer");
    c.header("X-Nanollm-Auth-Required", "1");
    return c.json({ error: "Unauthorized" }, 401);
  };
}
