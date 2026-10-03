/** CLI compatibility values used by subscription-backed upstreams. Update these when the CLIs change. */
export const CODEX_CLI_VERSION = "0.146.0";
export const CODEX_CLI_ORIGINATOR = "codex_cli_rs";
export function buildCodexCliUserAgent(version: string): string {
  return `${CODEX_CLI_ORIGINATOR}/${version} (Ubuntu 22.4.0; x86_64) xterm-256color`;
}
export const CODEX_CLI_USER_AGENT = buildCodexCliUserAgent(CODEX_CLI_VERSION);

export const CLAUDE_CODE_VERSION = "2.1.284";
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
  "x-stainless-os": "Linux",
  "x-stainless-arch": "arm64",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": "v26.3.0",
  "x-stainless-retry-count": "0",
  "x-stainless-timeout": "600",
  "anthropic-dangerous-direct-browser-access": "true",
};
