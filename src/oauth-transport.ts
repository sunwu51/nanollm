import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface OAuthTransportResponse { status: number; body: string; }

function helperName() {
  return process.platform === "win32" ? "nanollm-oauth-transport.exe" : "nanollm-oauth-transport";
}

function platformDirectory() {
  return `${process.platform}-${process.arch}`;
}

export function resolveOAuthTransportPath() {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // npm packages keep all supported helpers in platform-specific directories.
    join(moduleDir, "..", "..", "native-bin", platformDirectory(), helperName()),
    join(moduleDir, "..", "native-bin", platformDirectory(), helperName()),
    // GitHub release bundles keep both executables beside each other.
    join(dirname(process.execPath), helperName()),
    join(moduleDir, "..", "native", "oauth-transport", "target", "release", helperName()),
    join(moduleDir, "native", "oauth-transport", helperName()),
    resolve(process.cwd(), "native", "oauth-transport", "target", "release", helperName()),
  ];
  return candidates.find(existsSync);
}

export async function oauthPost(
  url: string,
  body: URLSearchParams | string,
  contentType = "application/x-www-form-urlencoded",
): Promise<OAuthTransportResponse> {
  const helper = resolveOAuthTransportPath();
  if (!helper) {
    const response = await fetch(url, { method: "POST", headers: { "content-type": contentType, accept: "application/json", "user-agent": "codex_cli_rs" }, body });
    return { status: response.status, body: await response.text() };
  }
  const input = JSON.stringify({ url, headers: { "content-type": contentType, accept: "application/json", "user-agent": "codex_cli_rs" }, body: body.toString(), timeout_secs: 30 });
  return new Promise((resolvePromise, reject) => {
    const child = execFile(helper, { timeout: 35_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { reject(new Error(`OAuth transport failed: ${stderr.trim() || error.message}`)); return; }
      try { resolvePromise(JSON.parse(stdout) as OAuthTransportResponse); }
      catch { reject(new Error(`OAuth transport returned invalid JSON: ${stdout.slice(0, 240)}`)); }
    });
    child.stdin?.end(input);
  });
}
