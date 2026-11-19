import assert from "node:assert/strict";
import test from "node:test";
import { Script } from "node:vm";
import { Worker } from "node:worker_threads";
import { renderAdminConfigPage } from "../src/pages/admin-config-page.js";

const html = renderAdminConfigPage({}, "en");
const workerSource = /function expressionTestWorker\(\) \{[\s\S]*?(?=\n      function openExpressionTestDialog)/.exec(html)![0];

// Exercise the exact browser worker source using a worker_threads message adapter.
function preview(expression: string, input: unknown = {}, kind = "body_expression", headers?: unknown, path?: string): Promise<{ output?: string; error?: string; sizeError?: boolean; skip?: boolean }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort } = require("node:worker_threads");
      global.self = { postMessage: value => parentPort.postMessage(value) };
      (${workerSource})();
      parentPort.on("message", data => self.onmessage({ data }));
    `, { eval: true });
    const finish = (result: Parameters<typeof resolve>[0]) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ error: "Expression timed out" }), 1000);
    worker.once("message", finish);
    worker.once("error", error => { clearTimeout(timer); void worker.terminate(); reject(error); });
    worker.postMessage({ expression, input, kind, headers, path });
  });
}

test("browser preview transforms JSON and supports optional chaining", async () => {
  const result = await preview("({...body, value: body.message?.a?.b ?? 'default'})", { message: { a: { b: 42 } } });
  assert.deepEqual(JSON.parse(result.output!), { message: { a: { b: 42 } }, value: 42 });
  assert.deepEqual(JSON.parse((await preview("({value: body.message?.a?.b ?? 'default'})")).output!), { value: "default" });
  assert.deepEqual(JSON.parse((await preview("", { value: 1 })).output!), { value: 1 });
});

test("response preview exposes normalized read-only headers", async () => {
  const result = await preview("({...response, source: headers['x-source'], frozen: Object.isFrozen(headers)})", { model: "example" }, "response_expression", { "X-Source": "demo" });
  assert.deepEqual(JSON.parse(result.output!), { model: "example", source: "demo", frozen: true });
  for (const headers of [null, [], { foo: 1 }]) {
    assert.match((await preview("response", {}, "response_expression", headers)).error!, /Headers must be/);
  }
});

test("skip_when preview exposes request headers, model and path like the server rule", async () => {
  const skip = (expression: string, headers?: unknown, path = "/v1/chat/completions") =>
    preview(expression, { model: "alpha" }, "skip_when", headers, path);
  assert.equal((await skip("headers['authorization']?.endsWith('ansang')", { Authorization: "Bearer sk-ansang" })).skip, true);
  assert.equal((await skip("headers.Authorization === 'Bearer k'", { authorization: "Bearer k" })).skip, true);
  assert.equal((await skip("'X-Api-Key' in headers", { "x-api-key": "k" })).skip, true);
  assert.equal((await skip("model === 'alpha' && path === '/v1/messages'", {}, "/v1/messages")).skip, true);
  assert.equal((await skip("headers['authorization']?.endsWith('ansang')", {})).skip, false);
  assert.equal((await skip("")).skip, false);
  assert.match((await skip("header['authorization']")).error!, /header is not defined/);
  assert.equal((await skip("Object.isFrozen(body) && Object.isFrozen(headers)")).skip, true);
  assert.match((await skip("Promise.resolve(true)")).error!, /must return synchronously/);
  assert.match((await skip("true", { foo: 1 })).error!, /Headers must be/);
});

test("skip_when dialog offers request headers and path inputs", () => {
  assert.match(html, /isSkip\s+\? addInput\(T\.expressionRequestHeaders/);
  assert.match(html, /addInput\(T\.expressionPath, "\/v1\/chat\/completions", true\)/);
  assert.match(html, /payload\.skip \? T\.skipWhenMatched : T\.skipWhenNotMatched/);
});

test("browser preview reports invalid expressions and non-JSON results", async () => {
  for (const [expression, expected] of [
    ["({", /Unexpected/],
    ["(() => { throw new Error('sample error') })()", /sample error/],
    ["undefined", /returned undefined/],
    ["Promise.resolve({})", /must return synchronously/],
    ["() => {}", /not JSON serializable/],
    ["(() => { const a = {}; a.self = a; return a; })()", /circular/i],
  ] as const) assert.match((await preview(expression)).error!, expected);
});

test("runaway expressions and serialization can be terminated, then another test succeeds", async () => {
  assert.match((await preview("(() => { while (true) {} })()")).error!, /timed out/);
  assert.match((await preview("({toJSON() { while (true) {} }})")).error!, /timed out/);
  assert.deepEqual(JSON.parse((await preview("({...body, ok: true})")).output!), { ok: true });
});

test("browser preview limits output size", async () => {
  assert.equal((await preview("'x'.repeat(1024 * 1024)")).sizeError, true);
});

test("admin dialog is frontend-only and shows the browser environment note below Run", () => {
  for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Script(match[1]);
  assert.match(html, /new Worker\(workerUrl\)/);
  assert.match(html, /worker\.terminate\(\)/);
  assert.match(html, /URL\.revokeObjectURL\(workerUrl\)/);
  assert.match(html, /setTimeout\(\(\) => fail\(T.expressionTimeout\), 1000\)/);
  assert.match(html, /stopWorker\(\); dialog.remove\(\)/);
  assert.match(html, /body.appendChild\(actions\);\s+const browserNote/);
  assert.match(html, /not the real Node.js environment/);
  assert.doesNotMatch(html, /\/admin\/expressions\/test/);
});
