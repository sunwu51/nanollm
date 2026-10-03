import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { test } from "node:test";
import { resolveShutdownTimeoutMs } from "../src/core/shutdown.js";

async function startFixture(t: { after: (fn: () => void) => void }, mode = "normal", timeoutMs = 1_000) {
  const moduleUrl = new URL("../src/core/shutdown.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
    import http from 'node:http';
    import { installGracefulShutdown } from ${JSON.stringify(moduleUrl)};
    const server = http.createServer((req, res) => {
      console.log('REQUEST START');
      if (req.url === '/stream') {
        res.writeHead(200, {'content-type': 'text/event-stream'});
        res.write('data: waiting\\n\\n');
      } else {
        setTimeout(() => { res.end('finished'); console.log('REQUEST END'); }, 150);
      }
    });
    installGracefulShutdown({ server, timeoutMs: ${timeoutMs},
      stopBackgroundWork: () => console.log('BACKGROUND STOPPED'),
      cleanup: async () => {
        console.log('FLUSH START');
        if (${JSON.stringify(mode)} === 'hang') await new Promise(() => {});
        if (${JSON.stringify(mode)} === 'fail') throw new Error('database unavailable');
        await new Promise(resolve => setTimeout(resolve, 30));
        console.log('FLUSH END');
        console.log('DATABASE CLOSED');
      }
    });
    // A lingering upstream socket/timer must not keep a finished shutdown alive.
    setInterval(() => {}, 60_000);
    server.listen(0, '127.0.0.1', () => process.send({port: server.address().port}));
  `], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const exited = once(child, "exit");
  const [ready] = await once(child, "message");
  return { child, exited, port: (ready as { port: number }).port, output: () => output };
}

function request(port: number, path = "/") {
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path }, resolve).on("error", reject);
  });
}

test("shutdown timeout rejects invalid values", () => {
  for (const value of ["", "0", "-1", "invalid", "Infinity", "1.5", "2147483648"]) {
    assert.equal(resolveShutdownTimeoutMs(value), 25_000);
  }
  assert.equal(resolveShutdownTimeoutMs("30000"), 30_000);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`idle server exits cleanly on ${signal} after flushing`, { timeout: 10_000 }, async (t) => {
    const fixture = await startFixture(t);
    fixture.child.kill(signal);
    assert.deepEqual(await fixture.exited, [0, null]);
    assert.match(fixture.output(), /FLUSH START\nFLUSH END\nDATABASE CLOSED/);
    assert.match(fixture.output(), /Complete; exiting with code 0/);
    assert.equal(fixture.output().split("BACKGROUND STOPPED").length - 1, 1);
  });
}

test("SIGTERM allows an active request to finish and ignores repeated signals", { timeout: 10_000 }, async (t) => {
  const fixture = await startFixture(t);
  // Wait until the server has accepted the request, then initiate shutdown.
  const started = new Promise<void>((resolve) => {
    const listener = () => {
      if (fixture.output().includes("REQUEST START")) {
        fixture.child.stdout.off("data", listener);
        resolve();
      }
    };
    fixture.child.stdout.on("data", listener);
  });
  const responsePromise = request(fixture.port);
  await started;
  fixture.child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 30));
  fixture.child.kill("SIGTERM");
  const response = await responsePromise;
  let body = "";
  for await (const chunk of response) body += chunk;
  assert.equal(body, "finished");
  assert.deepEqual(await fixture.exited, [0, null]);
  assert.match(fixture.output(), /REQUEST END\nFLUSH START/);
  assert.doesNotMatch(fixture.output(), /Drain deadline reached/);
  assert.equal(fixture.output().split("Received SIGTERM").length - 1, 1);
});

test("an endless SSE connection is cut off within the drain deadline", { timeout: 10_000 }, async (t) => {
  const fixture = await startFixture(t, "normal", 500);
  const response = await request(fixture.port, "/stream");
  response.on("error", () => {}); // Expected when shutdown cuts off the stream.
  response.resume();
  const closed = once(response, "close").catch(() => {});
  fixture.child.kill("SIGTERM");
  assert.deepEqual(await fixture.exited, [0, null]);
  await closed;
  assert.match(fixture.output(), /Drain deadline reached/);
  assert.match(fixture.output(), /FLUSH END\nDATABASE CLOSED/);
});

for (const mode of ["fail", "hang"]) {
  test(`cleanup ${mode} remains a real failure`, { timeout: 10_000 }, async (t) => {
    const fixture = await startFixture(t, mode, 500);
    fixture.child.kill("SIGTERM");
    assert.deepEqual(await fixture.exited, [1, null]);
    assert.doesNotMatch(fixture.output(), /Complete; exiting with code 0/);
  });
}
