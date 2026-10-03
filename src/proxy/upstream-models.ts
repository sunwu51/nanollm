import { ProxyAgent, fetch as undiciFetch } from "undici";
import { resolveEnvVars } from "../core/config.js";

export interface UpstreamModelsRequest {
  provider: string;
  base_url: string;
  api_key: string;
  proxy?: string;
}

const FETCH_TIMEOUT_MS = 15000;
const ANTHROPIC_PAGE_LIMIT = 1000;
const MAX_PAGES = 20;
const SUPPORTED_PROTOCOLS = new Set(["openai-chat", "openai-responses", "openai-image", "anthropic"]);

export function extractUpstreamModelIds(payload: unknown): string[] {
  const root = payload as { data?: unknown; models?: unknown } | null;
  const items = Array.isArray(payload) ? payload : Array.isArray(root?.data) ? root.data : Array.isArray(root?.models) ? root.models : [];
  const ids: string[] = [];
  for (const item of items) {
    const entry = item as { id?: unknown; slug?: unknown } | null;
    const id = typeof item === "string" ? item : (entry?.id ?? entry?.slug);
    if (typeof id === "string" && id.trim()) ids.push(id.trim());
  }
  return ids;
}

function buildHeaders(provider: string, apiKey: string): Record<string, string> {
  if (provider === "anthropic") {
    return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

function resolveProxy(proxy: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  const value = proxy?.trim() || env.HTTPS_PROXY || env.HTTP_PROXY;
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("proxy 必须是有效的 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("proxy 必须使用 http:// 或 https://");
  return value;
}

/** Call `<base_url>/models` with the given (possibly unsaved) provider settings and return the sorted, de-duplicated model ids. */
export async function fetchUpstreamModels(
  request: UpstreamModelsRequest,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<string[]> {
  const provider = request.provider.trim();
  if (!SUPPORTED_PROTOCOLS.has(provider)) throw new Error(`协议 '${provider || "(空)"}' 不支持拉取模型列表`);
  const baseUrl = request.base_url.trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("请先填写 base_url");
  const apiKey = resolveEnvVars(request.api_key ?? "").trim();
  const headers = buildHeaders(provider, apiKey);
  const proxyUrl = resolveProxy(request.proxy, options.env ?? process.env);
  const dispatcher = proxyUrl ? new ProxyAgent({ uri: proxyUrl }) : undefined;

  const ids: string[] = [];
  try {
    let afterId: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = provider === "anthropic"
        ? `?limit=${ANTHROPIC_PAGE_LIMIT}${afterId ? `&after_id=${encodeURIComponent(afterId)}` : ""}`
        : "";
      const response = await undiciFetch(`${baseUrl}/models${query}`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        ...(dispatcher ? { dispatcher } : {}),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`上游返回 HTTP ${response.status}：${text.slice(0, 200)}`);
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`上游 /models 返回的不是 JSON：${text.slice(0, 200)}`);
      }
      ids.push(...extractUpstreamModelIds(payload));
      const meta = payload as { has_more?: unknown; last_id?: unknown } | null;
      if (provider !== "anthropic" || meta?.has_more !== true || typeof meta.last_id !== "string") break;
      afterId = meta.last_id;
    }
  } finally {
    await dispatcher?.close();
  }
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}
