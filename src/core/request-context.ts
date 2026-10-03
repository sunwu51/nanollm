import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

interface RequestContextStore {
  requestId: string;
  responsesCustomToolNames: Set<string>;
  clientHeaders?: Headers;
  clientIp?: string;
}

const requestContext = new AsyncLocalStorage<RequestContextStore>();

function formatTimestamp(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}`;
}

export function createRequestId(): string {
  return randomUUID();
}

export function runWithRequestId<T>(requestId: string, callback: () => T): T {
  return requestContext.run({ requestId, responsesCustomToolNames: new Set<string>() }, callback);
}

export function getRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

export function setClientRequestHeaders(headers: Headers): void {
  const store = requestContext.getStore();
  if (store) store.clientHeaders = headers;
}

export function setClientIp(ip: string | undefined): void {
  const store = requestContext.getStore();
  if (store) store.clientIp = ip;
}

export function getClientIp(): string | undefined {
  return requestContext.getStore()?.clientIp;
}

export function getClientRequestHeaders(): Headers | undefined {
  return requestContext.getStore()?.clientHeaders;
}

export function markResponsesCustomToolName(name: string): void {
  requestContext.getStore()?.responsesCustomToolNames.add(name);
}

export function isResponsesCustomToolName(name: string): boolean {
  return requestContext.getStore()?.responsesCustomToolNames.has(name) ?? false;
}

export function withRequestId(message: string, fallbackRequestId?: string): string {
  const requestId = getRequestId() ?? fallbackRequestId;
  const timestamp = `[${formatTimestamp()}]`;
  return requestId ? `${timestamp} [requestId=${requestId.slice(0, 6)}] ${message}` : `${timestamp} ${message}`;
}
