import { ProxyAgent, fetch as undiciFetch } from "undici";
import { CODEX_CLI_VERSION } from "./subscription-client-compat.js";

const RELEASES_URL = "https://api.github.com/repos/openai/codex/releases/latest";
/** The Codex backend answers 404 to versions below this (sub2api #3901). */
const CODEX_UPSTREAM_MIN_VERSION = "0.144.0";
const SYNC_INTERVAL_MS = 6 * 60 * 60_000;
const FAILURE_RETRY_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 5000;

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** `rust-v0.159.2` -> `0.159.2`; prereleases such as `rust-v0.160.0-alpha.1` are rejected. */
export function parseCodexReleaseVersion(tag: unknown): string | undefined {
  const match = typeof tag === "string" ? /^(?:rust-)?v?(\d+\.\d+\.\d+)$/.exec(tag.trim()) : null;
  return match && compareVersions(match[1], CODEX_UPSTREAM_MIN_VERSION) >= 0 ? match[1] : undefined;
}

/** Latest stable Codex CLI release (GitHub already leaves drafts and prereleases out of /releases/latest). */
export async function fetchLatestCodexVersion(options: { url?: string; proxyUrl?: string } = {}): Promise<string> {
  const dispatcher = options.proxyUrl ? new ProxyAgent(options.proxyUrl) : undefined;
  try {
    const response = await undiciFetch(options.url ?? RELEASES_URL, {
      dispatcher,
      headers: { Accept: "application/vnd.github+json", "User-Agent": "nanollm" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`GitHub releases request failed (${response.status})`);
    const version = parseCodexReleaseVersion((JSON.parse(text) as { tag_name?: unknown }).tag_name);
    if (!version) throw new Error("latest Codex release has an unusable version");
    return version;
  } finally {
    await dispatcher?.close();
  }
}

export interface CodexVersionSource {
  /** Waits for a sync when the cached version has expired. */
  latest(proxyUrl?: string): Promise<string>;
  /** Never waits: returns the cached version and refreshes it in the background once expired. */
  current(proxyUrl?: string): string;
}

/**
 * Follows the latest Codex release (synced every few hours) and never reports a version older than the built-in
 * default. A failed sync keeps the last known version and retries sooner.
 */
export function createCodexVersionSource(options: { url?: string } = {}): CodexVersionSource {
  let cached: { version: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;
  const latest = async (proxyUrl?: string): Promise<string> => {
    if (cached && cached.expiresAt > Date.now()) return cached.version;
    inflight ??= fetchLatestCodexVersion({ url: options.url, proxyUrl })
      .then((version) => {
        cached = { version: compareVersions(version, CODEX_CLI_VERSION) > 0 ? version : CODEX_CLI_VERSION, expiresAt: Date.now() + SYNC_INTERVAL_MS };
        return cached.version;
      })
      .catch(() => {
        cached = { version: cached?.version ?? CODEX_CLI_VERSION, expiresAt: Date.now() + FAILURE_RETRY_MS };
        return cached.version;
      })
      .finally(() => { inflight = undefined; });
    return inflight;
  };
  const current = (proxyUrl?: string): string => {
    if (!cached || cached.expiresAt <= Date.now()) void latest(proxyUrl);
    return cached?.version ?? CODEX_CLI_VERSION;
  };
  return { latest, current };
}

const defaultSource = createCodexVersionSource();
/**
 * The version to report as `client_version`. The model catalog is filtered by client version, so a stale
 * value hides newer models.
 */
export const getLatestCodexVersion = defaultSource.latest;
/** The version subscription request headers report; request paths use this so they never wait on GitHub. */
export const getCurrentCodexVersion = defaultSource.current;
