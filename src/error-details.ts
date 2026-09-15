export interface ErrorCauseDetail {
  name?: string;
  message: string;
  code?: string;
  errno?: string | number;
}

const MAX_CAUSE_DEPTH = 5;
const MAX_FIELD_LENGTH = 2_000;

function safeString(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value)
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(api[-_ ]?key|authorization|token)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .trim();
  return text ? text.slice(0, MAX_FIELD_LENGTH) : undefined;
}

export function extractErrorCauses(error: unknown): ErrorCauseDetail[] {
  const causes: ErrorCauseDetail[] = [];
  const seen = new Set<unknown>();
  let current = error && typeof error === "object" ? (error as { cause?: unknown }).cause : undefined;

  while (current !== undefined && current !== null && causes.length < MAX_CAUSE_DEPTH && !seen.has(current)) {
    seen.add(current);
    if (typeof current === "object") {
      const value = current as Record<string, unknown>;
      const message = safeString(value.message) ?? safeString(value.code) ?? safeString(value.errno);
      if (message) {
        causes.push({
          message,
          ...(safeString(value.name) ? { name: safeString(value.name) } : {}),
          ...(safeString(value.code) ? { code: safeString(value.code) } : {}),
          ...(typeof value.errno === "number" || typeof value.errno === "string"
            ? { errno: typeof value.errno === "number" ? value.errno : safeString(value.errno)! }
            : {}),
        });
      }
      current = value.cause;
    } else {
      const message = safeString(current);
      if (message) causes.push({ message });
      break;
    }
  }

  return causes;
}

export function formatErrorWithCauses(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const causes = extractErrorCauses(error);
  const details = causes.map((cause) => cause.code && cause.code !== cause.message
    ? `${cause.message} (${cause.code})`
    : cause.message);
  return [message, ...details].filter((value, index, values) => value && values.indexOf(value) === index).join(": ");
}
