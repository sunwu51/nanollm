import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DEFAULT_PORT, loadConfig } from "../src/core/config.js";
import { defaultConfigText, ensureConfigFile } from "../src/core/config-manager.js";
import { findAvailablePort } from "../src/core/port.js";

async function listen(port: number, host?: string): Promise<http.Server | undefined> {
  const server = http.createServer();
  return new Promise((resolve) => {
    server.once("error", () => resolve(undefined));
    server.listen(port, host, () => resolve(server));
  });
}

test("ensureConfigFile creates a missing config with its directory and leaves an existing one alone", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nanollm-config-init-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "nested", "config.yaml");

  assert.equal(await ensureConfigFile(configPath, async () => 4100), 4100);
  assert.equal(readFileSync(configPath, "utf-8"), defaultConfigText(4100));
  assert.equal(loadConfig(configPath).models.length, 0);

  writeFileSync(configPath, "server:\n  port: 4200\n");
  let asked = false;
  assert.equal(await ensureConfigFile(configPath, async () => { asked = true; return 4300; }), undefined);
  assert.equal(asked, false, "an existing config never probes for a port");
  assert.equal(readFileSync(configPath, "utf-8"), "server:\n  port: 4200\n");
});

for (const host of [undefined, "0.0.0.0", "127.0.0.1"]) {
  test(`findAvailablePort skips a port listened on ${host ?? "the default address"}`, async (t) => {
    const busy = (await listen(0, host))!;
    t.after(() => busy.close());
    const busyPort = (busy.address() as import("node:net").AddressInfo).port;

    const port = await findAvailablePort(busyPort);
    assert.ok(port > busyPort, `expected a port after ${busyPort}, got ${port}`);
    assert.equal(await findAvailablePort(busyPort, 1), busyPort, "falls back to the start port when the range is exhausted");
  });
}

test("the gateway creates config.yaml in the working directory on a free port when none exists", { timeout: 60000 }, async (t) => {
  // Make sure the default port is taken, whether by this test or by something else on the machine.
  const blocker = await listen(DEFAULT_PORT);
  t.after(() => blocker?.close());

  // Run from an empty directory with no --config, CONFIG_PATH or PORT, like `npx nanollm` in a fresh folder.
  const dir = mkdtempSync(join(tmpdir(), "nanollm-config-init-"));
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CONFIG_PATH;
  delete env.PORT;
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("server.ts"), "--storage", "memory"],
    { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => { log += d; }); child.stderr.on("data", (d) => { log += d; });
  t.after(async () => {
    // Windows keeps a process's working directory locked until it exits.
    if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill(); await closed; }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const configPath = join(dir, "config.yaml");
  let base = "";
  for (const deadline = Date.now() + 30000; ;) {
    if (child.exitCode !== null) assert.fail("server exited:\n" + log);
    if (!base && /\[CONFIG INIT\]/.test(log)) base = `http://127.0.0.1:${loadConfig(configPath).port}`;
    if (base && await fetch(base + "/health").then((r) => r.ok, () => false)) break;
    if (Date.now() > deadline) assert.fail("server did not start:\n" + log);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const port = loadConfig(configPath).port;
  assert.notEqual(port, DEFAULT_PORT, "the busy default port is not written");
  assert.equal(readFileSync(configPath, "utf-8"), defaultConfigText(port));
  assert.match(log, new RegExp(`\\[CONFIG INIT\\] created .*config\\.yaml with port ${port}`));
  assert.match(log, new RegExp(`listening on http://localhost:${port}`));
  const models = await fetch(base + "/v1/models").then((r) => r.json()) as { data: unknown[] };
  assert.deepEqual(models.data, []);
});
