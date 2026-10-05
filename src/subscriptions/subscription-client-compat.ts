/** CLI compatibility values used by subscription-backed upstreams. Update these when the CLIs change. */
export const CODEX_CLI_VERSION = "0.160.0";
export const CODEX_CLI_ORIGINATOR = "codex-tui";
/**
 * Every subscription request leaves from the gateway, so it reports one fixed Codex TUI identity on macOS
 * (Apple silicon) instead of whichever client and OS made the call.
 */
export function buildCodexCliUserAgent(version: string): string {
  return `${CODEX_CLI_ORIGINATOR}/${version} (Mac OS 26.5.1; arm64) xterm-256color (${CODEX_CLI_ORIGINATOR}; ${version})`;
}
export const CODEX_CLI_USER_AGENT = buildCodexCliUserAgent(CODEX_CLI_VERSION);

export const CLAUDE_CODE_VERSION = "2.1.289";
export const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
export const CLAUDE_CODE_BETA = "claude-code-20250219";
export const CLAUDE_CLI_USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`;
export const CLAUDE_CODE_USER_AGENT = `claude-code/${CLAUDE_CODE_VERSION}`;

/**
 * Claude Code OAuth request defaults based on sub2api:
 * https://github.com/Wei-Shaw/sub2api/blob/9a62841fd124d026cf3694fcf9b79e98addcdbdc/backend/internal/pkg/claude/constants.go
 * Supplied values take precedence.
 */
export const CLAUDE_CODE_DEFAULT_HEADERS: Readonly<Record<string, string>> = {
  Accept: "application/json",
  "User-Agent": CLAUDE_CLI_USER_AGENT,
  "x-app": "cli",
  "x-stainless-lang": "js",
  "x-stainless-package-version": "0.112.1",
  "x-stainless-os": "Windows",
  "x-stainless-arch": "x64",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": "v26.3.0",
  "x-stainless-retry-count": "0",
  "x-stainless-timeout": "600",
  "anthropic-dangerous-direct-browser-access": "true",
};

/**
 * The fixed platform every Claude subscription request reports (Claude Code on Windows x64), whichever machine the
 * client runs on. Unlike the defaults above, these replace client-supplied values.
 */
export const CLAUDE_CODE_PLATFORM_HEADERS: Readonly<Record<string, string>> = {
  "x-stainless-lang": CLAUDE_CODE_DEFAULT_HEADERS["x-stainless-lang"],
  "x-stainless-os": CLAUDE_CODE_DEFAULT_HEADERS["x-stainless-os"],
  "x-stainless-arch": CLAUDE_CODE_DEFAULT_HEADERS["x-stainless-arch"],
};
