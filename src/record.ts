import { getRequestId } from "./request-context.js";
import { DEFAULT_RECORD_MAX_SIZE } from "./config.js";
import type { DatabaseSync } from "node:sqlite";

const REDACTED = "[REDACTED]";
const SENSITIVE_HEADERS = new Set(["authorization", "x-api-key", "cookie", "set-cookie"]);

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
  start(options?: { maxSize?: number }): RecordSummary;
  configure(options?: { maxSize?: number }): RecordSummary;
  stop(): RecordSummary;
  summary(): RecordSummary;
  beginRequest(input: {
    requestId: string;
    path: string;
    headers: Headers | Record<string, string>;
    body: unknown;
    stream: boolean;
  }): boolean;
  get(requestIdOrPrefix: string): RecordEntry | undefined;
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
  flush?(): void;
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

  private evictOldestIfNeeded() {
    if (this.records.size < this.limit || this.records.size === 0) return;
    const oldestKey = this.records.keys().next().value;
    if (oldestKey) {
      this.records.delete(oldestKey);
      this.capturedCount = Math.max(0, this.capturedCount - 1);
    }
  }

  private trimToLimit() {
    while (this.records.size > this.limit && this.records.size > 0) {
      const oldestKey = this.records.keys().next().value;
      if (!oldestKey) break;
      this.records.delete(oldestKey);
      this.capturedCount = Math.max(0, this.capturedCount - 1);
    }
  }

  start(options?: { maxSize?: number }) {
    this.limit = options?.maxSize ?? DEFAULT_RECORD_MAX_SIZE;
    this.enabled = true;
    this.capturedCount = 0;
    if (!this.sessionStartedAt) this.sessionStartedAt = Date.now();
    this.records.clear();
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
        body: cloneJson(input.body),
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

  get(requestId: string): RecordEntry | undefined {
    const normalized = normalizeLookupValue(requestId);
    return this.records.get(normalized);
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
    const body = normalizeBody(input.requestBody);
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
  private persistScheduled = false;

  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
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
    `);
    this.capturedCount = this.countRecords();
  }

  private countRecords(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM records").get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  private countVisibleRecords(): number {
    return this.countRecords() + this.activeRecords.size + this.persistQueue.size;
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

  private getOldestPersistedKey(): string | undefined {
    const row = this.db.prepare("SELECT key FROM records ORDER BY created_at ASC, key ASC LIMIT 1").get() as { key?: string } | undefined;
    return row?.key;
  }

  private evictOldestIfNeeded() {
    while (this.countVisibleRecords() >= this.limit && this.limit > 0) {
      const volatileKey = this.getOldestVolatileKey();
      const persistedKey = this.getOldestPersistedKey();
      const volatileRecord = volatileKey ? (this.activeRecords.get(volatileKey) ?? this.persistQueue.get(volatileKey)) : undefined;
      const persistedRecord = persistedKey ? this.readByKey(persistedKey) : undefined;
      const evictVolatile =
        volatileRecord &&
        (!persistedRecord ||
          volatileRecord.createdAt < persistedRecord.createdAt ||
          (volatileRecord.createdAt === persistedRecord.createdAt && volatileRecord.key < persistedRecord.key));
      if (evictVolatile && volatileKey) {
        this.activeRecords.delete(volatileKey);
        this.persistQueue.delete(volatileKey);
      } else if (persistedKey) {
        this.db.prepare("DELETE FROM records WHERE key = ?").run(persistedKey);
      } else {
        break;
      }
    }
  }

  private trimToLimit() {
    this.db.prepare(`
      DELETE FROM records
      WHERE key IN (
        SELECT key FROM records ORDER BY created_at ASC, key ASC LIMIT max((SELECT COUNT(*) FROM records) - ?, 0)
      )
    `).run(this.limit);
    this.capturedCount = this.countRecords();
  }

  private readByKey(key: string): RecordEntry | undefined {
    const active = this.activeRecords.get(key) ?? this.persistQueue.get(key);
    if (active) return active;
    const row = this.db.prepare("SELECT entry_json FROM records WHERE key = ?").get(key) as RecordRow | undefined;
    return row ? parseRecordEntry(row.entry_json) : undefined;
  }

  private hasPersistedKey(key: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM records WHERE key = ?").get(key);
  }

  private readMutable(requestId?: string): RecordEntry | undefined {
    const id = resolveRequestId(requestId);
    if (!id) return undefined;
    return this.readByKey(getRecordKey(id));
  }

  private writeRecordNow(record: RecordEntry) {
    const summary = updateSummaryFields(record);
    this.db.prepare(`
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
    `).run(
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
    );
  }

  private scheduleFlush() {
    if (this.persistScheduled) return;
    this.persistScheduled = true;
    queueMicrotask(() => {
      this.persistScheduled = false;
      this.flush();
    });
  }

  flush() {
    if (this.persistQueue.size === 0) return;
    const records = Array.from(this.persistQueue.values());
    this.persistQueue.clear();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const record of records) {
        this.writeRecordNow(record);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  start(options?: { maxSize?: number }) {
    this.limit = options?.maxSize ?? DEFAULT_RECORD_MAX_SIZE;
    this.enabled = true;
    if (!this.sessionStartedAt) this.sessionStartedAt = Date.now();
    this.trimToLimit();
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
    this.flush();
    this.enabled = false;
    this.sessionStartedAt = undefined;
    return this.summary();
  }

  summary(): RecordSummary {
    const rows = this.db.prepare(`
      SELECT key, request_id, created_at, path, model, actual_model, source, status, response_status
      FROM records
      ORDER BY created_at DESC, key DESC
      LIMIT ?
    `).all(this.limit) as Array<{
      key: string;
      request_id: string;
      created_at: number;
      path: string;
      model?: string | null;
      actual_model?: string | null;
      source: RequestSource;
      status: RequestStatus;
      response_status?: number | null;
    }>;
    const activeSummaries = Array.from(this.activeRecords.values()).map((record) => {
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
    const combinedRows = [...activeSummaries, ...rows.filter((row) => !this.activeRecords.has(row.key))]
      .sort((a, b) => b.created_at - a.created_at || b.key.localeCompare(a.key))
      .slice(0, this.limit);
    const size = Math.min(this.limit, this.countRecords() + activeSummaries.filter((row) => !this.hasPersistedKey(row.key)).length);
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
    if (this.activeRecords.has(key) || this.persistQueue.has(key) || this.hasPersistedKey(key)) return true;
    this.trimToLimit();
    this.evictOldestIfNeeded();
    const requestMeta = buildRequestMeta(input.headers, input.body);
    this.activeRecords.set(key, {
      requestId: input.requestId,
      key,
      createdAt: Date.now(),
      stream: input.stream,
      clientRequest: {
        path: input.path,
        headers: normalizeHeaders(input.headers) ?? {},
        body: cloneJson(input.body),
        model: requestMeta.model,
        actualModel: undefined,
        source: requestMeta.source,
        status: "in_progress",
      },
      attempts: [],
      clientResponse: {},
    });
    this.capturedCount = this.countRecords() + this.activeRecords.size;
    return true;
  }

  get(requestId: string): RecordEntry | undefined {
    const normalized = normalizeLookupValue(requestId);
    return this.readByKey(normalized);
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
    const body = normalizeBody(input.requestBody);
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
    this.writeRecordNow(record);
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
  recordStore.flush?.();
  recordStore = new RecordStore();
}

export function useSqliteRecordStore(db: DatabaseSync) {
  recordStore.flush?.();
  recordStore = new SqliteRecordStore(db);
}

export function startRecording(options?: { maxSize?: number }) {
  return recordStore.start(options);
}

export function stopRecording() {
  return recordStore.stop();
}

export function configureRecording(options?: { maxSize?: number }) {
  return recordStore.configure(options);
}

export function getRecordSummary() {
  return recordStore.summary();
}

export function flushRecording() {
  recordStore.flush?.();
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

export function getRecordedRequest(requestIdOrPrefix: string) {
  return recordStore.get(requestIdOrPrefix);
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
