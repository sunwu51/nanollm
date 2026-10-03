import { brotliCompressSync, gzipSync } from "node:zlib";

export const RESPONSE_COMPRESSION_THRESHOLD_BYTES = 256 * 1024;

function chooseResponseEncoding(requestHeaders: Headers): "br" | "gzip" | undefined {
  const acceptEncoding = requestHeaders.get("accept-encoding");
  if (acceptEncoding == null || acceptEncoding.trim() === "") return "gzip";
  const encodings = acceptEncoding.toLowerCase();
  if (/\bbr\b/.test(encodings)) return "br";
  if (/\bgzip\b/.test(encodings)) return "gzip";
  return undefined;
}

function withVaryAcceptEncoding(headers: Headers) {
  const existing = headers.get("vary");
  if (!existing) {
    headers.set("vary", "Accept-Encoding");
    return;
  }
  if (!existing.split(",").some((item) => item.trim().toLowerCase() === "accept-encoding")) {
    headers.set("vary", `${existing}, Accept-Encoding`);
  }
}

export function buildNonStreamResponse(requestHeaders: Headers, body: string, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  const bodyBytes = Buffer.byteLength(body);
  if (bodyBytes <= RESPONSE_COMPRESSION_THRESHOLD_BYTES || headers.has("content-encoding")) {
    headers.delete("content-length");
    return new Response(body, { ...init, headers });
  }

  const encoding = chooseResponseEncoding(requestHeaders);
  if (!encoding) {
    headers.delete("content-length");
    return new Response(body, { ...init, headers });
  }

  const compressed = encoding === "br" ? brotliCompressSync(body) : gzipSync(body);
  headers.set("content-encoding", encoding);
  headers.set("content-length", String(compressed.byteLength));
  withVaryAcceptEncoding(headers);
  return new Response(compressed, { ...init, headers });
}

export function buildJsonResponse(requestHeaders: Headers, body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return buildNonStreamResponse(requestHeaders, JSON.stringify(body), { ...init, headers });
}
