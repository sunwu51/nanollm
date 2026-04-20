import { getRequestId } from "./request-context.js";

const RECORD_LIMIT = 100;
const MAX_TEXT_CHARS = 256 * 1024;
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

export interface RecordEntry {
  requestId: string;
  key: string;
  createdAt: number;
  stream: boolean;
  clientRequest: {
    path: string;
    headers: Record<string, string>;
    body: unknown;
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
  recentKeys: Array<{ key: string; requestId: string; path: string; createdAt: number }>;
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

function truncateText(text: string): { value: string; truncated: boolean } {
  if (text.length <= MAX_TEXT_CHARS) return { value: text, truncated: false };
  return {
    value: `${text.slice(0, MAX_TEXT_CHARS)}\n...[truncated]`,
    truncated: true,
  };
}

function normalizeBody(body: unknown): { value: unknown; truncated: boolean } {
  if (typeof body === "string") {
    try {
      return { value: cloneJson(JSON.parse(body)), truncated: false };
    } catch {
      const text = truncateText(body);
      return { value: text.value, truncated: text.truncated };
    }
  }

  return { value: cloneJson(body), truncated: false };
}

function appendTextBody(current: unknown, chunk: string): { value: string; truncated: boolean } {
  const base = typeof current === "string" ? current : "";
  return truncateText(base + chunk);
}

function getRecordKey(requestId: string): string {
  return requestId.slice(0, 6);
}

function normalizeLookupValue(value: string): string {
  return value
    .trim()
    .replace(/^.*requestId=/i, "")
    .replace(/^[\[\("'\s]+/, "")
    .replace(/[\]\)"'\s,]+$/, "");
}

function resolveRequestId(requestId?: string): string | undefined {
  return requestId ?? getRequestId();
}

class RecordStore {
  enabled = false;
  capturedCount = 0;
  readonly limit = RECORD_LIMIT;
  sessionStartedAt?: number;
  private readonly records = new Map<string, RecordEntry>();

  start() {
    this.enabled = true;
    this.capturedCount = 0;
    this.sessionStartedAt = Date.now();
    this.records.clear();
  }

  stop() {
    this.enabled = false;
    this.sessionStartedAt = undefined;
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
        .slice(0, 12)
        .map((record) => ({
          key: record.key,
          requestId: record.requestId,
          path: record.clientRequest.path,
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
    if (!this.enabled || this.capturedCount >= this.limit) return false;
    const key = getRecordKey(input.requestId);
    if (this.records.has(key)) return true;
    this.records.set(key, {
      requestId: input.requestId,
      key,
      createdAt: Date.now(),
      stream: input.stream,
      clientRequest: {
        path: input.path,
        headers: normalizeHeaders(input.headers) ?? {},
        body: cloneJson(input.body),
      },
      attempts: [],
      clientResponse: {},
    });
    this.capturedCount += 1;
    return true;
  }

  get(requestIdOrPrefix: string): RecordEntry | undefined {
    const normalized = normalizeLookupValue(requestIdOrPrefix);
    return this.records.get(normalized.slice(0, 6));
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
  }

  appendClientResponseBody(input: { requestId?: string; chunk: string }) {
    const record = this.getMutable(input.requestId);
    if (!record) return;
    const text = appendTextBody(record.clientResponse.body, input.chunk);
    record.clientResponse.body = text.value;
    record.clientResponse.truncated = text.truncated;
  }

  setRequestError(input: { requestId?: string; message: string }) {
    const record = this.getMutable(input.requestId);
    if (!record) return;
    record.error = { message: input.message };
  }
}

const recordStore = new RecordStore();

export function startRecording() {
  recordStore.start();
  return recordStore.summary();
}

export function stopRecording() {
  recordStore.stop();
  return recordStore.summary();
}

export function getRecordSummary() {
  return recordStore.summary();
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
