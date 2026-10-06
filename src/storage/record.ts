import type { InStatement, ResultSet } from "@libsql/client";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { brotliCompress, brotliDecompress, constants as zlibConstants } from "node:zlib";
import { getRequestId } from "../core/request-context.js";
import { DEFAULT_RECORD_MAX_SIZE } from "../core/config.js";
import type { SqliteClient } from "./sqlite.js";
import { allRows, enqueueClientWrite, firstRow, waitForClientWrites } from "./sqlite.js";
import type { ErrorCauseDetail } from "../core/error-details.js";

const REDACTED = "[REDACTED]";
const SENSITIVE_HEADERS = new Set(["authorization", "x-api-key", "cookie", "set-cookie"]);
const IMAGE_REFERENCE_KEY = "__nanollm_record_image_ref";

type ImageReference = {
  [IMAGE_REFERENCE_KEY]: string;
  mediaType?: string;
  bytes: number;
  base64Only?: boolean;
};

export interface RecordedMessage {
  headers?: Record<string, string>;
  body?: unknown;
  truncated?: boolean;
}

export interface RecordedAttempt {
  index: number;
  provider: string;
  modelName: string;
  url: string;
  proxy?: string | null;
  request: RecordedMessage;
  response: {
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
    truncated?: boolean;
  };
  error?: {
    message: string;
    causes?: ErrorCauseDetail[];
    status?: number;
    upstream?: unknown;
  };
}

export type RequestSource = "claudecode" | "codex" | "opencode" | "other";
export type RequestStatus = "in_progress" | "success" | "failure";

export interface RecordEntry {
  requestId: string;
  key: string;
  createdAt: number;
  firstByteAt?: number;
  completedAt?: number;
  stream: boolean;
  clientRequest: {
    path: string;
    headers: Record<string, string>;
    body: unknown;
    model?: string;
    actualModel?: string;
    source: RequestSource;
    status: RequestStatus;
  };
  attempts: RecordedAttempt[];
  clientResponse: {
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
    truncated?: boolean;
  };
  error?: {
    message: string;
    causes?: ErrorCauseDetail[];
  };
}

export interface RecordSummary {
  enabled: boolean;
  capturedCount: number;
  limit: number;
  sessionStartedAt?: number;
  size: number;
  recentKeys: Array<{ key: string; requestId: string; path: string; model?: string; actualModel?: string; source: RequestSource; status: RequestStatus; responseStatus?: number; createdAt: number }>;
}

interface RecordStoreLike {
  start(options?: { maxSize?: number }): RecordSummary | Promise<RecordSummary>;
  configure(options?: { maxSize?: number }): RecordSummary | Promise<RecordSummary>;
  stop(): RecordSummary | Promise<RecordSummary>;
  summary(): RecordSummary | Promise<RecordSummary>;
  beginRequest(input: {
    requestId: string;
    path: string;
    headers: Headers | Record<string, string>;
    body: unknown;
    stream: boolean;
  }): boolean;
  get(requestIdOrPrefix: string, options?: { hydrateImages?: boolean }): RecordEntry | undefined | Promise<RecordEntry | undefined>;
  getImage(hash: string): string | undefined | Promise<string | undefined>;
  ensureAttempt(input: {
    requestId?: string;
    index: number;
    provider: string;
    modelName: string;
    url: string;
    proxy?: string | null;
    requestHeaders: Headers | Record<string, string>;
    requestBody: unknown;
  }): RecordedAttempt | undefined;
  setAttemptResponseMeta(input: {
    requestId?: string;
    index: number;
    status: number;
    headers: Headers | Record<string, string>;
  }): void;
  setAttemptResponseBody(input: { requestId?: string; index: number; body: unknown }): void;
  appendAttemptResponseBody(input: { requestId?: string; index: number; chunk: string }): void;
  setAttemptError(input: { requestId?: string; index: number; message: string; causes?: ErrorCauseDetail[]; status?: number; upstream?: unknown }): void;
  setClientResponseMeta(input: {
    requestId?: string;
    status: number;
    headers?: Headers | Record<string, string>;
  }): void;
  setClientResponseBody(input: { requestId?: string; body: unknown }): void;
  appendClientResponseBody(input: { requestId?: string; chunk: string }): void;
  setRequestError(input: { requestId?: string; message: string; causes?: ErrorCauseDetail[] }): void;
  finalizeRequest(input: { requestId?: string }): void;
  flush?(): void | Promise<void>;
}

// Persist only the proxy endpoint, never credentials or query parameters.
function sanitizeRecordedProxy(proxy: string | null | undefined): string | null | undefined {
  if (proxy == null) return proxy;
  try {
    const url = new URL(proxy);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid proxy URL]";
  }
}

function extractRequestModel(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const model = (body as Record<string, unknown>).model;
  return typeof model === "string" && model ? model : undefined;
}

function classifyRequestSource(headers: Headers | Record<string, string> | undefined): RequestSource {
  if (!headers) return "other";
  const userAgent = typeof (headers as Headers).get === "function"
    ? (headers as Headers).get("user-agent")
    : Object.entries(headers).find(([key]) => key.toLowerCase() === "user-agent")?.[1];
  const normalized = userAgent?.toLowerCase() ?? "";
  if (normalized.includes("claude-cli")) return "claudecode";
  if (normalized.includes("codex")) return "codex";
  if (normalized.includes("opencode")) return "opencode";
  return "other";
}

function buildRequestMeta(headers: Headers | Record<string, string> | undefined, body: unknown) {
  return {
    model: extractRequestModel(body),
    source: classifyRequestSource(headers),
  };
}

function cloneJson<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isImageDataUrl(value: string) {
  return /^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(value);
}

function imageReference(value: string, images: Map<string, string>, base64Only = false): ImageReference {
  const hash = createHash("sha256").update(value).digest("hex");
  images.set(hash, value);
  const mediaType = /^data:([^;,]+)/i.exec(value)?.[1];
  return { [IMAGE_REFERENCE_KEY]: hash, ...(mediaType ? { mediaType } : {}), bytes: Buffer.byteLength(value), ...(base64Only ? { base64Only: true } : {}) };
}

function isImageReference(value: unknown): value is ImageReference {
  return !!value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>)[IMAGE_REFERENCE_KEY] === "string";
}

// Responses image_generation_call items and partial_image stream events carry raw base64 without a data URL prefix.
function isGeneratedImageField(source: Record<string, unknown>, key: string, item: unknown): item is string {
  if (typeof item !== "string" || !item || isImageDataUrl(item)) return false;
  return (key === "result" && source.type === "image_generation_call") ||
    (key === "partial_image_b64" && source.type === "response.image_generation_call.partial_image");
}

// Keep request records compact while retaining enough information to reconstruct them for replay.
function compactImages(value: unknown, images: Map<string, string>): unknown {
  if (typeof value === "string") return isImageDataUrl(value) ? imageReference(value, images) : value;
  if (Array.isArray(value)) return value.map((item) => compactImages(item, images));
  if (!value || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (key === "data" && source.type === "base64" && typeof item === "string" && typeof source.media_type === "string") {
      result[key] = imageReference(`data:${source.media_type};base64,${item}`, images, true);
    } else if (isGeneratedImageField(source, key, item)) {
      const format = typeof source.output_format === "string" && source.output_format ? source.output_format : "png";
      result[key] = imageReference(`data:image/${format};base64,${item}`, images, true);
    } else {
      result[key] = compactImages(item, images);
    }
  }
  return result;
}

function restoreImages(value: unknown, images: Map<string, string>): unknown {
  if (isImageReference(value)) {
    const image = images.get(value[IMAGE_REFERENCE_KEY]);
    return image && value.base64Only ? image.slice(image.indexOf(",") + 1) : image ?? value;
  }
  if (Array.isArray(value)) return value.map((item) => restoreImages(item, images));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, restoreImages(item, images)]));
}

const TEXT_IMAGE_REFERENCE = new RegExp(`"${IMAGE_REFERENCE_KEY}":"([a-f0-9]{64})"`, "g");

function collectImageReferences(value: unknown, hashes = new Set<string>()): Set<string> {
  if (isImageReference(value)) hashes.add(value[IMAGE_REFERENCE_KEY]);
  // Streamed bodies keep references inside raw SSE text.
  else if (typeof value === "string" && value.includes(IMAGE_REFERENCE_KEY)) {
    for (const match of value.matchAll(TEXT_IMAGE_REFERENCE)) hashes.add(match[1]);
  }
  else if (Array.isArray(value)) value.forEach((item) => collectImageReferences(item, hashes));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectImageReferences(item, hashes));
  return hashes;
}

const SSE_IMAGE_HINT = /data:image\/|"base64"|image_generation_call/;

// Streamed bodies are stored as raw SSE text; compact image payloads inside each JSON data line.
function compactSseText(text: string, images: Map<string, string>): string {
  if (!SSE_IMAGE_HINT.test(text)) return text;
  return text.split("\n").map((line) => {
    if (!line.startsWith("data:") || !SSE_IMAGE_HINT.test(line)) return line;
    try {
      const compacted = compactImages(JSON.parse(line.slice(5)), images);
      if (collectImageReferences(compacted).size === 0) return line;
      return `data: ${JSON.stringify(compacted)}${line.endsWith("\r") ? "\r" : ""}`;
    } catch {
      return line;
    }
  }).join("\n");
}

function compactRecordBody(body: unknown, images: Map<string, string>): { value: unknown; truncated: boolean } {
  const parsed = typeof body === "string" ? (() => { try { return JSON.parse(body); } catch { return body; } })() : body;
  return { value: typeof parsed === "string" ? compactSseText(parsed, images) : compactImages(parsed, images), truncated: false };
}

function compactStreamedBodies(record: RecordEntry, images: Map<string, string>) {
  for (const attempt of record.attempts) {
    if (typeof attempt.response.body === "string") attempt.response.body = compactSseText(attempt.response.body, images);
  }
  if (typeof record.clientResponse.body === "string") record.clientResponse.body = compactSseText(record.clientResponse.body, images);
}

function maskHeaderValue(name: string, value: string): string {
  return SENSITIVE_HEADERS.has(name.toLowerCase()) ? REDACTED : value;
}

function normalizeHeaders(headers: Headers | Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const entries =
    typeof (headers as Headers).entries === "function"
      ? Array.from((headers as Headers).entries())
      : Object.entries(headers);
  return Object.fromEntries(entries.map(([key, value]) => [key, maskHeaderValue(key, value)]));
}

function normalizeBody(body: unknown): { value: unknown; truncated: boolean } {
  if (typeof body === "string") {
    try {
      return { value: cloneJson(JSON.parse(body)), truncated: false };
    } catch {
      return { value: body, truncated: false };
    }
  }

  return { value: cloneJson(body), truncated: false };
}

function appendTextBody(current: unknown, chunk: string): { value: string; truncated: boolean } {
  const base = typeof current === "string" ? current : "";
  return { value: base + chunk, truncated: false };
}

function getRecordKey(requestId: string): string {
  return requestId;
}

function normalizeLookupValue(value: string): string {
  return value.trim();
}

function resolveRequestId(requestId?: string): string | undefined {
  return requestId ?? getRequestId();
}

class RecordStore implements RecordStoreLike {
  enabled = true;
  capturedCount = 0;
  limit = DEFAULT_RECORD_MAX_SIZE;
  sessionStartedAt?: number;
  private readonly records = new Map<string, RecordEntry>();
  private readonly images = new Map<string, string>();

  private pruneImages() {
    const referenced = new Set<string>();
    for (const record of this.records.values()) collectImageReferences(record, referenced);
    for (const hash of this.images.keys()) if (!referenced.has(hash)) this.images.delete(hash);
  }

  private evictOldestIfNeeded() {
    if (this.records.size < this.limit || this.records.size === 0) return;
    const oldestKey = this.records.keys().next().value;
    if (oldestKey) {
      this.records.delete(oldestKey);
      this.pruneImages();
      this.capturedCount = Math.max(0, this.capturedCount - 1);
    }
  }

  private trimToLimit() {
    while (this.records.size > this.limit && this.records.size > 0) {
      const oldestKey = this.records.keys().next().value;
      if (!oldestKey) break;
      this.records.delete(oldestKey);
      this.pruneImages();
      this.capturedCount = Math.max(0, this.capturedCount - 1);
    }
  }

  start(options?: { maxSize?: number }) {
    this.limit = options?.maxSize ?? DEFAULT_RECORD_MAX_SIZE;
    this.enabled = true;
    this.capturedCount = 0;
    if (!this.sessionStartedAt) this.sessionStartedAt = Date.now();
    this.records.clear();
    this.images.clear();
    return this.summary();
  }

  configure(options?: { maxSize?: number }) {
    if (options?.maxSize !== undefined) {
      this.limit = options.maxSize;
      this.trimToLimit();
    }
    return this.summary();
  }

  stop() {
    this.enabled = false;
    this.sessionStartedAt = undefined;
    return this.summary();
  }

  summary(): RecordSummary {
    return {
      enabled: this.enabled,
      capturedCount: this.capturedCount,
      limit: this.limit,
      sessionStartedAt: this.sessionStartedAt,
      size: this.records.size,
      recentKeys: Array.from(this.records.values())
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((record) => ({
          key: record.key,
          requestId: record.requestId,
          path: record.clientRequest.path,
          model: record.clientRequest.model,
          actualModel: record.clientRequest.actualModel,
          source: record.clientRequest.source,
          status: record.clientRequest.status,
          responseStatus: record.clientResponse.status,
          createdAt: record.createdAt,
        })),
    };
  }

  beginRequest(input: {
    requestId: string;
    path: string;
    headers: Headers | Record<string, string>;
    body: unknown;
    stream: boolean;
  }): boolean {
    if (!this.enabled) return false;
    const key = getRecordKey(input.requestId);
    if (this.records.has(key)) return true;
    this.evictOldestIfNeeded();
    const requestMeta = buildRequestMeta(input.headers, input.body);
    this.records.set(key, {
      requestId: input.requestId,
      key,
      createdAt: Date.now(),
      stream: input.stream,
      clientRequest: {
        path: input.path,
        headers: normalizeHeaders(input.headers) ?? {},
        body: compactRecordBody(input.body, this.images).value,
        model: requestMeta.model,
        actualModel: undefined,
        source: requestMeta.source,
        status: "in_progress",
      },
      attempts: [],
      clientResponse: {},
    });
    this.capturedCount += 1;
    return true;
  }

  get(requestId: string, options?: { hydrateImages?: boolean }): RecordEntry | undefined {
    const normalized = normalizeLookupValue(requestId);
    const record = this.records.get(normalized);
    return record && options?.hydrateImages ? restoreImages(record, this.images) as RecordEntry : record;
  }

  getImage(hash: string): string | undefined {
    return this.images.get(hash);
  }

  private getMutable(requestId?: string): RecordEntry | undefined {
    const id = resolveRequestId(requestId);
    if (!id) return undefined;
    return this.records.get(getRecordKey(id));
  }

  ensureAttempt(input: {
    requestId?: string;
    index: number;
    provider: string;
    modelName: string;
    url: string;
    proxy?: string | null;
    requestHeaders: Headers | Record<string, string>;
    requestBody: unknown;
  }) {
    const record = this.getMutable(input.requestId);
    if (!record) return;
    const existing = record.attempts.find((attempt) => attempt.index === input.index);
    if (existing) return existing;
    const body = compactRecordBody(input.requestBody, this.images);
    const attempt: RecordedAttempt = {
      index: input.index,
      provider: input.provider,
      modelName: input.modelName,
      url: input.url,
      proxy: sanitizeRecordedProxy(input.proxy),
      request: {
        headers: normalizeHeaders(input.requestHeaders),
        body: body.value,
        ...(body.truncated ? { truncated: true } : {}),
      },
      response: {},
    };
    record.clientRequest.actualModel = input.modelName;
    record.attempts.push(attempt);
    return attempt;
  }

  setAttemptResponseMeta(input: {
    requestId?: string;
    index: number;
    status: number;
    headers: Headers | Record<string, string>;
  }) {
    const attempt = this.getMutable(input.requestId)?.attempts.find((item) => item.index === input.index);
    if (!attempt) return;
    attempt.response.status = input.status;
    attempt.response.headers = normalizeHeaders(input.headers);
  }

  setAttemptResponseBody(input: { requestId?: string; index: number; body: unknown }) {
    const attempt = this.getMutable(input.requestId)?.attempts.find((item) => item.index === input.index);
    if (!attempt) return;
    const body = compactRecordBody(input.body, this.images);
    attempt.response.body = body.value;
    attempt.response.truncated = body.truncated;
  }

  appendAttemptResponseBody(input: { requestId?: string; index: number; chunk: string }) {
    const attempt = this.getMutable(input.requestId)?.attempts.find((item) => item.index === input.index);
    if (!attempt) return;
    const text = appendTextBody(attempt.response.body, input.chunk);
    attempt.response.body = text.value;
    attempt.response.truncated = text.truncated;
  }

  setAttemptError(input: { requestId?: string; index: number; message: string; causes?: ErrorCauseDetail[]; status?: number; upstream?: unknown }) {
    const attempt = this.getMutable(input.requestId)?.attempts.find((item) => item.index === input.index);
    if (!attempt) return;
    attempt.error = {
      message: input.message,
      ...(input.causes?.length ? { causes: input.causes } : {}),
      ...(input.status != null ? { status: input.status } : {}),
      ...(input.upstream !== undefined ? { upstream: normalizeBody(input.upstream).value } : {}),
    };
  }

  setClientResponseMeta(input: {
    requestId?: string;
    status: number;
    headers?: Headers | Record<string, string>;
  }) {
    const record = this.getMutable(input.requestId);
    if (!record) return;
    record.clientResponse.status = input.status;
    if (input.headers) {
      record.clientResponse.headers = normalizeHeaders(input.headers);
    }
  }

  setClientResponseBody(input: { requestId?: string; body: unknown }) {
    const record = this.getMutable(input.requestId);
    if (!record) return;
    const body = compactRecordBody(input.body, this.images);
    record.clientResponse.body = body.value;
    record.clientResponse.truncated = body.truncated;
    record.firstByteAt ??= Date.now();
    record.clientRequest.status = "success";
  }

  appendClientResponseBody(input: { requestId?: string; chunk: string }) {
    const record = this.getMutable(input.requestId);
    if (!record) return;
    const text = appendTextBody(record.clientResponse.body, input.chunk);
    record.clientResponse.body = text.value;
    record.clientResponse.truncated = text.truncated;
    record.firstByteAt ??= Date.now();
    record.clientRequest.status = "success";
  }

  setRequestError(input: { requestId?: string; message: string; causes?: ErrorCauseDetail[] }) {
    const record = this.getMutable(input.requestId);
    if (!record) return;
    record.error = { message: input.message, ...(input.causes?.length ? { causes: input.causes } : {}) };
    record.clientRequest.status = "failure";
  }

  finalizeRequest(input: { requestId?: string }) {
    const record = this.getMutable(input.requestId);
    if (!record || record.completedAt) return;
    compactStreamedBodies(record, this.images);
    record.completedAt = Date.now();
  }
}

type RecordRow = {
  entry_json: string | ArrayBuffer;
};

const compressBrotli = promisify(brotliCompress);
const decompressBrotli = promisify(brotliDecompress);

// entry_json holds the brotli-compressed record JSON as a BLOB (rows written before compression are
// JSON text and still read back). A record repeats the request body in each attempt and the stream in
// the client response, and a remote database receives the whole row on every insert. The window spans
// the whole record so those copies are matched, while memory stays proportional to the record size.
async function encodeRecordEntry(record: RecordEntry): Promise<Buffer> {
  const json = Buffer.from(JSON.stringify(record));
  return compressBrotli(json, {
    params: {
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
      [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
      [zlibConstants.BROTLI_PARAM_LGWIN]: Math.min(zlibConstants.BROTLI_MAX_WINDOW_BITS, Math.max(16, Math.ceil(Math.log2(json.length + 1)))),
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: json.length,
    },
  });
}

async function decodeRecordEntry(value: string | ArrayBuffer): Promise<RecordEntry | undefined> {
  try {
    const json = typeof value === "string" ? value : (await decompressBrotli(Buffer.from(value))).toString("utf8");
    return JSON.parse(json) as RecordEntry;
  } catch {
    return undefined;
  }
}

function countFromResult(result: ResultSet | undefined): number {
  return Number(result ? firstRow<{ count?: number }>(result)?.count ?? 0 : 0);
}

function updateSummaryFields(record: RecordEntry) {
  return {
    path: record.clientRequest.path,
    model: record.clientRequest.model ?? null,
    actualModel: record.clientRequest.actualModel ?? null,
    source: record.clientRequest.source,
    status: record.clientRequest.status,
    responseStatus: record.clientResponse.status ?? null,
  };
}

class SqliteRecordStore implements RecordStoreLike {
  enabled = true;
  capturedCount = 0;
  limit = DEFAULT_RECORD_MAX_SIZE;
  sessionStartedAt?: number;
  private readonly activeRecords = new Map<string, RecordEntry>();
  private readonly persistQueue = new Map<string, RecordEntry>();
  private readonly images = new Map<string, string>();
  private readonly ready: Promise<void>;
  private persistScheduled = false;

  constructor(private readonly db: SqliteClient) {
    this.ready = this.initialize();
  }

  private async initialize() {
    await this.db.executeMultiple(`
      CREATE TABLE IF NOT EXISTS records (
        key TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        path TEXT NOT NULL,
        model TEXT,
        actual_model TEXT,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        response_status INTEGER,
        entry_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_records_created_at ON records(created_at);
      CREATE INDEX IF NOT EXISTS idx_records_request_id ON records(request_id);
      CREATE TABLE IF NOT EXISTS record_images (
        hash TEXT PRIMARY KEY,
        data_url TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS record_image_refs (
        record_key TEXT NOT NULL,
        image_hash TEXT NOT NULL,
        PRIMARY KEY (record_key, image_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_record_image_refs_hash ON record_image_refs(image_hash);
    `);
    this.capturedCount = await this.countRecords();
  }

  private async countRecords(): Promise<number> {
    const row = firstRow<{ count?: number }>(await this.db.execute("SELECT COUNT(*) AS count FROM records"));
    return Number(row?.count ?? 0);
  }

  private async waitForReady() {
    await this.ready;
  }

  private enqueueWrite(task: () => Promise<void>) {
    return enqueueClientWrite(this.db, async () => {
      await this.waitForReady();
      await task();
    });
  }

  private async waitForWrites() {
    await this.waitForReady();
    await waitForClientWrites(this.db);
  }

  // Trim statements end with the remaining row count so they can share a batch with the inserts.
  private trimStatements(): InStatement[] {
    return [
      {
        sql: `
          DELETE FROM records
          WHERE key IN (
            SELECT key FROM records ORDER BY created_at ASC, key ASC LIMIT max((SELECT COUNT(*) FROM records) - ?, 0)
          )
        `,
        args: [this.limit],
      },
      "DELETE FROM record_image_refs WHERE record_key NOT IN (SELECT key FROM records)",
      "DELETE FROM record_images WHERE hash NOT IN (SELECT DISTINCT image_hash FROM record_image_refs)",
      "SELECT COUNT(*) AS count FROM records",
    ];
  }

  private async trimToLimit() {
    const results = await this.db.batch(this.trimStatements(), "write");
    this.capturedCount = countFromResult(results.at(-1));
  }

  // SQLite owns completed images. Keep only blobs needed by active or queued records.
  private pruneStagedImages() {
    const referenced = new Set<string>();
    for (const record of [...this.activeRecords.values(), ...this.persistQueue.values()]) {
      collectImageReferences(record, referenced);
    }
    for (const hash of this.images.keys()) if (!referenced.has(hash)) this.images.delete(hash);
  }

  // Evict the oldest records, persisted or still in memory, until in-flight records fit in the limit.
  // `oldestPersisted` holds the oldest persisted rows, at least as many as the overflow.
  private async evictOldest(overflow: number, oldestPersisted: Array<{ key: string; created_at: number }>) {
    if (overflow <= 0 || this.limit <= 0) return [];
    const evicted = [
      ...oldestPersisted.map((row) => ({ key: row.key, createdAt: row.created_at, persisted: true })),
      ...[...this.activeRecords.values(), ...this.persistQueue.values()].map((record) => ({ key: record.key, createdAt: record.createdAt, persisted: false })),
    ]
      .sort((a, b) => a.createdAt - b.createdAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .slice(0, overflow);
    const persistedKeys = evicted.filter((item) => item.persisted).map((item) => item.key);
    for (const item of evicted) {
      if (item.persisted) continue;
      this.activeRecords.delete(item.key);
      this.persistQueue.delete(item.key);
    }
    if (persistedKeys.length > 0) {
      await this.db.execute({ sql: `DELETE FROM records WHERE key IN (${persistedKeys.map(() => "?").join(", ")})`, args: persistedKeys });
    }
    this.pruneStagedImages();
    return persistedKeys;
  }

  private async hydrateRecordImages(record: RecordEntry): Promise<RecordEntry> {
    const images = new Map(this.images);
    const hashes = [...collectImageReferences(record)];
    const missing = hashes.filter((hash) => !images.has(hash));
    if (missing.length > 0) {
      const placeholders = missing.map(() => "?").join(", ");
      const rows = allRows<{ hash: string; data_url: string }>(await this.db.execute({
        sql: `SELECT hash, data_url FROM record_images WHERE hash IN (${placeholders})`,
        args: missing,
      }));
      for (const row of rows) images.set(row.hash, row.data_url);
    }
    return restoreImages(record, images) as RecordEntry;
  }

  private async readByKey(key: string, hydrateImages = false): Promise<RecordEntry | undefined> {
    const active = this.activeRecords.get(key) ?? this.persistQueue.get(key);
    if (active) return hydrateImages ? this.hydrateRecordImages(active) : active;
    await this.waitForWrites();
    const row = firstRow<RecordRow>(await this.db.execute({
      sql: "SELECT entry_json FROM records WHERE key = ?",
      args: [key],
    }));
    const record = row ? await decodeRecordEntry(row.entry_json) : undefined;
    return record && hydrateImages ? this.hydrateRecordImages(record) : record;
  }

  private readMutable(requestId?: string): RecordEntry | undefined {
    const id = resolveRequestId(requestId);
    if (!id) return undefined;
    const key = getRecordKey(id);
    return this.activeRecords.get(key) ?? this.persistQueue.get(key);
  }

  private async buildRecordStatement(record: RecordEntry): Promise<InStatement> {
    const summary = updateSummaryFields(record);
    return {
      sql: `
        INSERT INTO records (
          key,
          request_id,
          created_at,
          path,
          model,
          actual_model,
          source,
          status,
          response_status,
          entry_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          request_id = excluded.request_id,
          created_at = excluded.created_at,
          path = excluded.path,
          model = excluded.model,
          actual_model = excluded.actual_model,
          source = excluded.source,
          status = excluded.status,
          response_status = excluded.response_status,
          entry_json = excluded.entry_json
      `,
      args: [
        record.key,
        record.requestId,
        record.createdAt,
        summary.path,
        summary.model,
        summary.actualModel,
        summary.source,
        summary.status,
        summary.responseStatus,
        await encodeRecordEntry(record),
      ],
    };
  }

  // Images are content-addressed and every later request of a conversation repeats them, so only
  // images the database does not hold yet are sent. Staged data is read before the lookup is awaited
  // because pruneStagedImages may drop the blobs of records that already left the persist queue.
  private async buildImageStatements(records: RecordEntry[]) {
    const statements: InStatement[] = [];
    const staged = new Map<string, string>();
    for (const record of records) {
      statements.push({ sql: "DELETE FROM record_image_refs WHERE record_key = ?", args: [record.key] });
      for (const hash of collectImageReferences(record)) {
        statements.push({ sql: "INSERT OR IGNORE INTO record_image_refs (record_key, image_hash) VALUES (?, ?)", args: [record.key, hash] });
        const dataUrl = this.images.get(hash);
        if (dataUrl) staged.set(hash, dataUrl);
      }
    }
    if (staged.size === 0) return statements;
    const hashes = [...staged.keys()];
    const stored = new Set(allRows<{ hash: string }>(await this.db.execute({
      sql: `SELECT hash FROM record_images WHERE hash IN (${hashes.map(() => "?").join(", ")})`,
      args: hashes,
    })).map((row) => row.hash));
    for (const [hash, dataUrl] of staged) {
      if (!stored.has(hash)) statements.push({ sql: "INSERT OR IGNORE INTO record_images (hash, data_url) VALUES (?, ?)", args: [hash, dataUrl] });
    }
    return statements;
  }

  private scheduleFlush() {
    if (this.persistScheduled) return;
    this.persistScheduled = true;
    queueMicrotask(() => {
      this.persistScheduled = false;
      void this.enqueueWrite(() => this.persistQueued());
    });
  }

  // Records, image rows and the trim go out as one batch: a single round trip per flush.
  private async persistQueued() {
    if (this.persistQueue.size === 0) return;
    const records = Array.from(this.persistQueue.values());
    this.persistQueue.clear();
    const [imageStatements, recordStatements] = await Promise.all([
      this.buildImageStatements(records),
      Promise.all(records.map((record) => this.buildRecordStatement(record))),
    ]);
    const results = await this.db.batch([...imageStatements, ...recordStatements, ...this.trimStatements()], "write");
    this.capturedCount = countFromResult(results.at(-1));
    this.pruneStagedImages();
  }

  // Runs on the write queue, so readers that wait for queued writes also see these rows.
  async flush() {
    await this.enqueueWrite(() => this.persistQueued());
  }

  async start(options?: { maxSize?: number }) {
    this.limit = options?.maxSize ?? DEFAULT_RECORD_MAX_SIZE;
    this.enabled = true;
    if (!this.sessionStartedAt) this.sessionStartedAt = Date.now();
    await this.enqueueWrite(() => this.trimToLimit());
    return this.summary();
  }

  async configure(options?: { maxSize?: number }) {
    if (options?.maxSize !== undefined) {
      this.limit = options.maxSize;
      await this.enqueueWrite(() => this.trimToLimit());
    }
    return this.summary();
  }

  async stop() {
    await this.flush();
    this.enabled = false;
    this.sessionStartedAt = undefined;
    return this.summary();
  }

  async summary(): Promise<RecordSummary> {
    await this.flush();
    const volatileCount = this.activeRecords.size + this.persistQueue.size;
    // One round trip: the row count, the newest rows to list and the oldest rows that in-flight records displace.
    const [countResult, recentResult, oldestResult] = await this.db.batch([
      "SELECT COUNT(*) AS count FROM records",
      {
        sql: `
          SELECT key, request_id, created_at, path, model, actual_model, source, status, response_status
          FROM records
          ORDER BY created_at DESC, key DESC
          LIMIT ?
        `,
        args: [this.limit],
      },
      {
        sql: "SELECT key, created_at FROM records ORDER BY created_at ASC, key ASC LIMIT max((SELECT COUNT(*) FROM records) + ? - ?, 0)",
        args: [volatileCount, this.limit],
      },
    ], "deferred");
    const persistedCount = countFromResult(countResult);
    const evictedKeys = new Set(await this.evictOldest(
      persistedCount + volatileCount - this.limit,
      allRows<{ key: string; created_at: number }>(oldestResult),
    ));
    const rows = allRows<{
      key: string;
      request_id: string;
      created_at: number;
      path: string;
      model?: string | null;
      actual_model?: string | null;
      source: RequestSource;
      status: RequestStatus;
      response_status?: number | null;
    }>(recentResult).filter((row) => !evictedKeys.has(row.key));
    const volatileSummaries = [...this.activeRecords.values(), ...this.persistQueue.values()].map((record) => {
      const summary = updateSummaryFields(record);
      return {
        key: record.key,
        request_id: record.requestId,
        created_at: record.createdAt,
        path: summary.path,
        model: summary.model,
        actual_model: summary.actualModel,
        source: summary.source,
        status: summary.status,
        response_status: summary.responseStatus,
      };
    });
    const volatileKeys = new Set(volatileSummaries.map((row) => row.key));
    const combinedRows = [...volatileSummaries, ...rows.filter((row) => !volatileKeys.has(row.key))]
      .sort((a, b) => b.created_at - a.created_at || b.key.localeCompare(a.key))
      .slice(0, this.limit);
    const size = Math.min(this.limit, persistedCount - evictedKeys.size + this.activeRecords.size + this.persistQueue.size);
    this.capturedCount = size;
    return {
      enabled: this.enabled,
      capturedCount: this.capturedCount,
      limit: this.limit,
      sessionStartedAt: this.sessionStartedAt,
      size,
      recentKeys: combinedRows.map((row) => ({
        key: row.key,
        requestId: row.request_id,
        path: row.path,
        model: row.model ?? undefined,
        actualModel: row.actual_model ?? undefined,
        source: row.source,
        status: row.status,
        responseStatus: row.response_status ?? undefined,
        createdAt: row.created_at,
      })),
    };
  }

  beginRequest(input: {
    requestId: string;
    path: string;
    headers: Headers | Record<string, string>;
    body: unknown;
    stream: boolean;
  }): boolean {
    if (!this.enabled) return false;
    const key = getRecordKey(input.requestId);
    if (this.activeRecords.has(key) || this.persistQueue.has(key)) return true;
    const requestMeta = buildRequestMeta(input.headers, input.body);
    this.activeRecords.set(key, {
      requestId: input.requestId,
      key,
      createdAt: Date.now(),
      stream: input.stream,
      clientRequest: {
        path: input.path,
        headers: normalizeHeaders(input.headers) ?? {},
        body: compactRecordBody(input.body, this.images).value,
        model: requestMeta.model,
        actualModel: undefined,
        source: requestMeta.source,
        status: "in_progress",
      },
      attempts: [],
      clientResponse: {},
    });
    this.capturedCount = Math.min(this.limit, this.capturedCount + 1);
    return true;
  }

  async get(requestId: string, options?: { hydrateImages?: boolean }): Promise<RecordEntry | undefined> {
    const normalized = normalizeLookupValue(requestId);
    return this.readByKey(normalized, options?.hydrateImages);
  }

  async getImage(hash: string): Promise<string | undefined> {
    const cached = this.images.get(hash);
    if (cached) return cached;
    await this.waitForWrites();
    const row = firstRow<{ data_url: string }>(await this.db.execute({
      sql: "SELECT data_url FROM record_images WHERE hash = ?",
      args: [hash],
    }));
    return row?.data_url;
  }

  ensureAttempt(input: {
    requestId?: string;
    index: number;
    provider: string;
    modelName: string;
    url: string;
    proxy?: string | null;
    requestHeaders: Headers | Record<string, string>;
    requestBody: unknown;
  }) {
    const record = this.readMutable(input.requestId);
    if (!record) return undefined;
    const existing = record.attempts.find((attempt) => attempt.index === input.index);
    if (existing) return existing;
    const body = compactRecordBody(input.requestBody, this.images);
    const attempt: RecordedAttempt = {
      index: input.index,
      provider: input.provider,
      modelName: input.modelName,
      url: input.url,
      proxy: sanitizeRecordedProxy(input.proxy),
      request: {
        headers: normalizeHeaders(input.requestHeaders),
        body: body.value,
        ...(body.truncated ? { truncated: true } : {}),
      },
      response: {},
    };
    record.clientRequest.actualModel = input.modelName;
    record.attempts.push(attempt);
    return attempt;
  }

  private mutate(requestId: string | undefined, mutator: (record: RecordEntry) => void) {
    const record = this.readMutable(requestId);
    if (!record) return;
    mutator(record);
    if (this.activeRecords.has(record.key)) {
      this.activeRecords.set(record.key, record);
      return;
    }
    if (this.persistQueue.has(record.key)) {
      this.persistQueue.set(record.key, record);
      return;
    }
  }

  setAttemptResponseMeta(input: {
    requestId?: string;
    index: number;
    status: number;
    headers: Headers | Record<string, string>;
  }) {
    this.mutate(input.requestId, (record) => {
      const attempt = record.attempts.find((item) => item.index === input.index);
      if (!attempt) return;
      attempt.response.status = input.status;
      attempt.response.headers = normalizeHeaders(input.headers);
    });
  }

  setAttemptResponseBody(input: { requestId?: string; index: number; body: unknown }) {
    this.mutate(input.requestId, (record) => {
      const attempt = record.attempts.find((item) => item.index === input.index);
      if (!attempt) return;
      const body = compactRecordBody(input.body, this.images);
      attempt.response.body = body.value;
      attempt.response.truncated = body.truncated;
    });
  }

  appendAttemptResponseBody(input: { requestId?: string; index: number; chunk: string }) {
    this.mutate(input.requestId, (record) => {
      const attempt = record.attempts.find((item) => item.index === input.index);
      if (!attempt) return;
      const text = appendTextBody(attempt.response.body, input.chunk);
      attempt.response.body = text.value;
      attempt.response.truncated = text.truncated;
    });
  }

  setAttemptError(input: { requestId?: string; index: number; message: string; causes?: ErrorCauseDetail[]; status?: number; upstream?: unknown }) {
    this.mutate(input.requestId, (record) => {
      const attempt = record.attempts.find((item) => item.index === input.index);
      if (!attempt) return;
      attempt.error = {
        message: input.message,
        ...(input.causes?.length ? { causes: input.causes } : {}),
        ...(input.status != null ? { status: input.status } : {}),
        ...(input.upstream !== undefined ? { upstream: normalizeBody(input.upstream).value } : {}),
      };
    });
  }

  setClientResponseMeta(input: {
    requestId?: string;
    status: number;
    headers?: Headers | Record<string, string>;
  }) {
    this.mutate(input.requestId, (record) => {
      record.clientResponse.status = input.status;
      if (input.headers) {
        record.clientResponse.headers = normalizeHeaders(input.headers);
      }
    });
  }

  setClientResponseBody(input: { requestId?: string; body: unknown }) {
    this.mutate(input.requestId, (record) => {
      const body = compactRecordBody(input.body, this.images);
      record.clientResponse.body = body.value;
      record.clientResponse.truncated = body.truncated;
      record.firstByteAt ??= Date.now();
      record.clientRequest.status = "success";
    });
  }

  appendClientResponseBody(input: { requestId?: string; chunk: string }) {
    this.mutate(input.requestId, (record) => {
      const text = appendTextBody(record.clientResponse.body, input.chunk);
      record.clientResponse.body = text.value;
      record.clientResponse.truncated = text.truncated;
      record.firstByteAt ??= Date.now();
      record.clientRequest.status = "success";
    });
  }

  setRequestError(input: { requestId?: string; message: string; causes?: ErrorCauseDetail[] }) {
    this.mutate(input.requestId, (record) => {
      record.error = { message: input.message, ...(input.causes?.length ? { causes: input.causes } : {}) };
      record.clientRequest.status = "failure";
    });
  }

  finalizeRequest(input: { requestId?: string }) {
    const id = resolveRequestId(input.requestId);
    if (!id) return;
    const key = getRecordKey(id);
    const record = this.activeRecords.get(key);
    if (!record) return;
    if (!record.completedAt) compactStreamedBodies(record, this.images);
    record.completedAt ??= Date.now();
    this.activeRecords.delete(key);
    this.persistQueue.set(key, record);
    this.scheduleFlush();
  }
}

let recordStore: RecordStoreLike = new RecordStore();

export function useMemoryRecordStore() {
  void recordStore.flush?.();
  recordStore = new RecordStore();
}

export function useSqliteRecordStore(db: SqliteClient) {
  void recordStore.flush?.();
  recordStore = new SqliteRecordStore(db);
}

export async function startRecording(options?: { maxSize?: number }) {
  return await recordStore.start(options);
}

export async function stopRecording() {
  return await recordStore.stop();
}

export async function configureRecording(options?: { maxSize?: number }) {
  return await recordStore.configure(options);
}

export async function getRecordSummary() {
  return await recordStore.summary();
}

export async function flushRecording() {
  await recordStore.flush?.();
}

export function beginRecordedRequest(input: {
  requestId: string;
  path: string;
  headers: Headers | Record<string, string>;
  body: unknown;
  stream: boolean;
}) {
  return recordStore.beginRequest(input);
}

export async function getRecordedRequest(requestIdOrPrefix: string, options?: { hydrateImages?: boolean }) {
  return await recordStore.get(requestIdOrPrefix, options);
}

export async function getRecordedImage(hash: string) {
  return await recordStore.getImage(hash);
}

export function ensureRecordedAttempt(input: {
  requestId?: string;
  index: number;
  provider: string;
  modelName: string;
  url: string;
  proxy?: string | null;
  requestHeaders: Headers | Record<string, string>;
  requestBody: unknown;
}) {
  return recordStore.ensureAttempt(input);
}

export function setRecordedAttemptResponseMeta(input: {
  requestId?: string;
  index: number;
  status: number;
  headers: Headers | Record<string, string>;
}) {
  recordStore.setAttemptResponseMeta(input);
}

export function setRecordedAttemptResponseBody(input: { requestId?: string; index: number; body: unknown }) {
  recordStore.setAttemptResponseBody(input);
}

export function appendRecordedAttemptResponseBody(input: { requestId?: string; index: number; chunk: string }) {
  recordStore.appendAttemptResponseBody(input);
}

export function setRecordedAttemptError(input: { requestId?: string; index: number; message: string; causes?: ErrorCauseDetail[]; status?: number; upstream?: unknown }) {
  recordStore.setAttemptError(input);
}

export function setRecordedClientResponseMeta(input: {
  requestId?: string;
  status: number;
  headers?: Headers | Record<string, string>;
}) {
  recordStore.setClientResponseMeta(input);
}

export function setRecordedClientResponseBody(input: { requestId?: string; body: unknown }) {
  recordStore.setClientResponseBody(input);
}

export function appendRecordedClientResponseBody(input: { requestId?: string; chunk: string }) {
  recordStore.appendClientResponseBody(input);
}

export function setRecordedRequestError(input: { requestId?: string; message: string; causes?: ErrorCauseDetail[] }) {
  recordStore.setRequestError(input);
}

export function finalizeRecordedRequest(input: { requestId?: string }) {
  recordStore.finalizeRequest(input);
}
