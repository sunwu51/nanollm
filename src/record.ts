import { createHash } from "node:crypto";
import { getRequestId } from "./request-context.js";
import { DEFAULT_RECORD_MAX_SIZE } from "./config.js";
import type { SqliteClient } from "./sqlite.js";
import { allRows, enqueueClientWrite, firstRow, waitForClientWrites } from "./sqlite.js";

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
  request: RecordedMessage;
  response: {
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
    truncated?: boolean;
  };
  error?: {
    message: string;
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
  setAttemptError(input: { requestId?: string; index: number; message: string; status?: number; upstream?: unknown }): void;
  setClientResponseMeta(input: {
    requestId?: string;
    status: number;
    headers?: Headers | Record<string, string>;
  }): void;
  setClientResponseBody(input: { requestId?: string; body: unknown }): void;
  appendClientResponseBody(input: { requestId?: string; chunk: string }): void;
  setRequestError(input: { requestId?: string; message: string }): void;
  finalizeRequest(input: { requestId?: string }): void;
  flush?(): void | Promise<void>;
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

function collectImageReferences(value: unknown, hashes = new Set<string>()): Set<string> {
  if (isImageReference(value)) hashes.add(value[IMAGE_REFERENCE_KEY]);
  else if (Array.isArray(value)) value.forEach((item) => collectImageReferences(item, hashes));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectImageReferences(item, hashes));
  return hashes;
}

function compactRecordBody(body: unknown, images: Map<string, string>): { value: unknown; truncated: boolean } {
  const parsed = typeof body === "string" ? (() => { try { return JSON.parse(body); } catch { return body; } })() : body;
  return { value: compactImages(parsed, images), truncated: false };
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
    const body = normalizeBody(input.body);
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

  setAttemptError(input: { requestId?: string; index: number; message: string; status?: number; upstream?: unknown }) {
    const attempt = this.getMutable(input.requestId)?.attempts.find((item) => item.index === input.index);
    if (!attempt) return;
    attempt.error = {
      message: input.message,
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
    const body = normalizeBody(input.body);
    record.clientResponse.body = body.value;
    record.clientResponse.truncated = body.truncated;
    record.clientRequest.status = "success";
  }

  appendClientResponseBody(input: { requestId?: string; chunk: string }) {
    const record = this.getMutable(input.requestId);
    if (!record) return;
    const text = appendTextBody(record.clientResponse.body, input.chunk);
    record.clientResponse.body = text.value;
    record.clientResponse.truncated = text.truncated;
    record.clientRequest.status = "success";
  }

  setRequestError(input: { requestId?: string; message: string }) {
    const record = this.getMutable(input.requestId);
    if (!record) return;
    record.error = { message: input.message };
    record.clientRequest.status = "failure";
  }

  finalizeRequest(_input: { requestId?: string }) {}
}

type RecordRow = {
  entry_json: string;
};

function parseRecordEntry(json: string): RecordEntry | undefined {
  try {
    return JSON.parse(json) as RecordEntry;
  } catch {
    return undefined;
  }
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
    enqueueClientWrite(this.db, async () => {
      await this.waitForReady();
      await task();
    });
  }

  private async waitForWrites() {
    await this.waitForReady();
    await waitForClientWrites(this.db);
  }

  private async trimToLimit() {
    await this.waitForReady();
    await this.db.execute({
      sql: `
        DELETE FROM records
        WHERE key IN (
          SELECT key FROM records ORDER BY created_at ASC, key ASC LIMIT max((SELECT COUNT(*) FROM records) - ?, 0)
        )
      `,
      args: [this.limit],
    });
    await this.db.execute("DELETE FROM record_image_refs WHERE record_key NOT IN (SELECT key FROM records)");
    await this.db.execute("DELETE FROM record_images WHERE hash NOT IN (SELECT DISTINCT image_hash FROM record_image_refs)");
    this.capturedCount = await this.countRecords();
  }

  // SQLite owns completed images. Keep only blobs needed by active or queued records.
  private pruneStagedImages() {
    const referenced = new Set<string>();
    for (const record of [...this.activeRecords.values(), ...this.persistQueue.values()]) {
      collectImageReferences(record, referenced);
    }
    for (const hash of this.images.keys()) if (!referenced.has(hash)) this.images.delete(hash);
  }

  private getOldestVolatileKey(): string | undefined {
    let oldest: { key: string; createdAt: number } | undefined;
    for (const record of [...this.activeRecords.values(), ...this.persistQueue.values()]) {
      if (!oldest || record.createdAt < oldest.createdAt || (record.createdAt === oldest.createdAt && record.key < oldest.key)) {
        oldest = { key: record.key, createdAt: record.createdAt };
      }
    }
    return oldest?.key;
  }

  private async getOldestPersistedRow(): Promise<{ key: string; created_at: number } | undefined> {
    return firstRow<{ key: string; created_at: number }>(await this.db.execute(`
      SELECT key, created_at
      FROM records
      ORDER BY created_at ASC, key ASC
      LIMIT 1
    `));
  }

  private async countVisibleRecords(): Promise<number> {
    return (await this.countRecords()) + this.activeRecords.size + this.persistQueue.size;
  }

  private async evictOldestIfNeeded(incomingCount = 0) {
    while ((await this.countVisibleRecords()) + incomingCount > this.limit && this.limit > 0) {
      const volatileKey = this.getOldestVolatileKey();
      const volatileRecord = volatileKey ? (this.activeRecords.get(volatileKey) ?? this.persistQueue.get(volatileKey)) : undefined;
      const persistedRow = await this.getOldestPersistedRow();
      const evictVolatile =
        volatileRecord &&
        (!persistedRow ||
          volatileRecord.createdAt < persistedRow.created_at ||
          (volatileRecord.createdAt === persistedRow.created_at && volatileRecord.key < persistedRow.key));
      if (evictVolatile && volatileKey) {
        this.activeRecords.delete(volatileKey);
        this.persistQueue.delete(volatileKey);
      } else if (persistedRow?.key) {
        await this.db.execute({ sql: "DELETE FROM records WHERE key = ?", args: [persistedRow.key] });
      } else {
        break;
      }
    }
    this.pruneStagedImages();
    this.capturedCount = Math.min(this.limit, await this.countVisibleRecords());
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
    const record = row ? parseRecordEntry(row.entry_json) : undefined;
    return record && hydrateImages ? this.hydrateRecordImages(record) : record;
  }

  private readMutable(requestId?: string): RecordEntry | undefined {
    const id = resolveRequestId(requestId);
    if (!id) return undefined;
    const key = getRecordKey(id);
    return this.activeRecords.get(key) ?? this.persistQueue.get(key);
  }

  private buildRecordStatement(record: RecordEntry) {
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
        JSON.stringify(record),
      ],
    };
  }

  private buildImageStatements(records: RecordEntry[]) {
    const statements: Array<{ sql: string; args: any[] }> = [];
    const hashes = new Set<string>();
    for (const record of records) {
      const recordHashes = [...collectImageReferences(record)];
      statements.push({ sql: "DELETE FROM record_image_refs WHERE record_key = ?", args: [record.key] });
      for (const hash of recordHashes) {
        hashes.add(hash);
        statements.push({ sql: "INSERT OR IGNORE INTO record_image_refs (record_key, image_hash) VALUES (?, ?)", args: [record.key, hash] });
      }
    }
    for (const hash of hashes) {
      const dataUrl = this.images.get(hash);
      if (dataUrl) statements.push({ sql: "INSERT OR IGNORE INTO record_images (hash, data_url) VALUES (?, ?)", args: [hash, dataUrl] });
    }
    return statements;
  }

  private scheduleFlush() {
    if (this.persistScheduled) return;
    this.persistScheduled = true;
    queueMicrotask(() => {
      this.persistScheduled = false;
      this.enqueueWrite(() => this.flush());
    });
  }

  async flush() {
    await this.waitForReady();
    if (this.persistQueue.size === 0) return;
    const records = Array.from(this.persistQueue.values());
    this.persistQueue.clear();
    const statements = [...this.buildImageStatements(records), ...records.map((record) => this.buildRecordStatement(record))];
    if (statements.length > 0) {
      await this.db.batch(statements, "write");
    }
    await this.trimToLimit();
    this.pruneStagedImages();
  }

  async start(options?: { maxSize?: number }) {
    this.limit = options?.maxSize ?? DEFAULT_RECORD_MAX_SIZE;
    this.enabled = true;
    if (!this.sessionStartedAt) this.sessionStartedAt = Date.now();
    await this.trimToLimit();
    return this.summary();
  }

  async configure(options?: { maxSize?: number }) {
    if (options?.maxSize !== undefined) {
      this.limit = options.maxSize;
      await this.trimToLimit();
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
    await this.evictOldestIfNeeded();
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
    }>(await this.db.execute({
      sql: `
        SELECT key, request_id, created_at, path, model, actual_model, source, status, response_status
        FROM records
        ORDER BY created_at DESC, key DESC
        LIMIT ?
      `,
      args: [this.limit],
    }));
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
    const size = Math.min(this.limit, (await this.countRecords()) + this.activeRecords.size + this.persistQueue.size);
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
      const body = normalizeBody(input.body);
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

  setAttemptError(input: { requestId?: string; index: number; message: string; status?: number; upstream?: unknown }) {
    this.mutate(input.requestId, (record) => {
      const attempt = record.attempts.find((item) => item.index === input.index);
      if (!attempt) return;
      attempt.error = {
        message: input.message,
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
      const body = normalizeBody(input.body);
      record.clientResponse.body = body.value;
      record.clientResponse.truncated = body.truncated;
      record.clientRequest.status = "success";
    });
  }

  appendClientResponseBody(input: { requestId?: string; chunk: string }) {
    this.mutate(input.requestId, (record) => {
      const text = appendTextBody(record.clientResponse.body, input.chunk);
      record.clientResponse.body = text.value;
      record.clientResponse.truncated = text.truncated;
      record.clientRequest.status = "success";
    });
  }

  setRequestError(input: { requestId?: string; message: string }) {
    this.mutate(input.requestId, (record) => {
      record.error = { message: input.message };
      record.clientRequest.status = "failure";
    });
  }

  finalizeRequest(input: { requestId?: string }) {
    const id = resolveRequestId(input.requestId);
    if (!id) return;
    const key = getRecordKey(id);
    const record = this.activeRecords.get(key);
    if (!record) return;
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

export function setRecordedAttemptError(input: { requestId?: string; index: number; message: string; status?: number; upstream?: unknown }) {
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

export function setRecordedRequestError(input: { requestId?: string; message: string }) {
  recordStore.setRequestError(input);
}

export function finalizeRecordedRequest(input: { requestId?: string }) {
  recordStore.finalizeRequest(input);
}
