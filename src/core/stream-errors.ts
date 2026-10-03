export function isReleasedReaderStateError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String((error as Error & { code?: unknown }).code ?? "") : "";
  if (code !== "ERR_INVALID_STATE") return false;
  return /Releasing reader|Reader released/i.test(error.message);
}

export function shouldIgnoreStreamReadError(
  error: unknown,
  options: { cancelled: boolean; completed: boolean },
): boolean {
  if (options.cancelled) return true;
  if (options.completed && isReleasedReaderStateError(error)) return true;
  return false;
}
