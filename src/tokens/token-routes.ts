import { Hono } from "hono";
import { parseConfigText } from "../core/config.js";
import type { ConfigManager } from "../core/config-manager.js";
import { localize } from "../core/i18n.js";
import { readTokenDrafts, TokenValidationError, tokenDraftsFromConfig, validateTokenDrafts, writeTokenDrafts } from "./tokens.js";

/** API behind the /tokens page. Saving rewrites the `tokens` list of config.yaml and applies it right away. */
export function createTokenRoutes(configManager: ConfigManager, writeConfig: (text: string) => void) {
  const routes = new Hono();
  routes.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.req.method !== "GET") {
      const origin = c.req.header("origin");
      if (origin) {
        try { if (new URL(origin).host !== new URL(c.req.url).host) return c.json({ error: "Cross-origin mutations are not allowed" }, 403); }
        catch { return c.json({ error: "Invalid Origin" }, 403); }
      }
      if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) return c.json({ error: localize("请求应使用 application/json", "Requests must use application/json") }, 415);
    }
    await next();
  });
  routes.onError((error, c) => c.json({ error: error.message }, error instanceof TokenValidationError || error instanceof SyntaxError ? 400 : 500));

  const data = () => {
    const snapshot = configManager.getActiveSnapshot();
    const config = snapshot.effectiveConfig;
    let tokens;
    try {
      tokens = readTokenDrafts(snapshot.rawText);
    } catch {
      tokens = tokenDraftsFromConfig(config);
    }
    return {
      version: snapshot.version,
      tokens,
      targets: [
        ...Object.keys(config.fallback).map((name) => ({ name, kind: "group" })),
        ...config.models.map((model) => ({ name: model.name, kind: "model", provider: model.provider })),
      ],
      hasAdminToken: Boolean(config.auth?.token),
      ...(snapshot.lastError ? { lastError: snapshot.lastError.message } : {}),
    };
  };

  routes.get("/data", (c) => c.json(data()));
  routes.put("/tokens", async (c) => {
    const body = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TokenValidationError(localize("请求体应为 JSON 对象", "The request body must be a JSON object"));
    const drafts = validateTokenDrafts(body.tokens);
    if (body.baseVersion !== configManager.getActiveSnapshot().version) {
      return c.json({ error: localize("配置已在别处修改，请重新加载后再保存", "The config changed elsewhere. Reload and save again") }, 409);
    }
    const yamlText = writeTokenDrafts(configManager.getActiveSnapshot().rawText, drafts);
    try {
      parseConfigText(yamlText);
    } catch (error) {
      throw new TokenValidationError(error instanceof Error ? error.message : String(error));
    }
    writeConfig(yamlText);
    configManager.applyText(yamlText, "ui");
    return c.json(data());
  });
  return routes;
}
