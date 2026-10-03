export type LogLevel = "debug" | "info" | "error";

export function isLLMPath(path: string): boolean {
  return path.startsWith("/v1");
}

export function getHTTPLogLevel(path: string): LogLevel {
  return isLLMPath(path) ? "info" : "debug";
}

function getConfiguredLogLevel(): LogLevel {
  const value = process.env.LOG_LEVEL?.toLowerCase();
  if (value === "debug" || value === "info" || value === "error") {
    return value;
  }
  return "info";
}

export function shouldEmitLog(level: LogLevel): boolean {
  const configured = getConfiguredLogLevel();
  const weights: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    error: 30,
  };
  return weights[level] >= weights[configured];
}
