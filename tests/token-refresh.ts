import assert from "node:assert/strict";
import { test } from "node:test";

import { createTokenRefreshScheduler } from "../src/subscriptions/token-refresh.js";

const MINUTE = 60_000;

for (const outcome of ["first succeeds", "retry succeeds", "both fail", "request recovers"] as const) {
  test(`background token refresh: ${outcome}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const info = t.mock.method(console, "info", () => {});
    t.mock.method(console, "error", () => {});
    const calls: number[] = [];
    const old = { expiresAt: 60 * MINUTE, refreshToken: "old-token" };
    const next = { expiresAt: 120 * MINUTE, refreshToken: "new-token" };
    const succeed = () => scheduler.refreshed("test", old, next, true);
    const scheduler = createTokenRefreshScheduler("TEST", async () => {
      calls.push(Date.now());
      if (outcome === "first succeeds" || (outcome === "retry succeeds" && calls.length === 2)) {
        succeed();
        return next;
      }
      throw new Error("test refresh failure");
    });
    scheduler.schedule("test", old);
    t.mock.timers.tick(50 * MINUTE - 1);
    assert.deepEqual(calls, []);
    t.mock.timers.tick(1);
    await Promise.resolve();
    assert.deepEqual(calls, [50 * MINUTE]);
    if (outcome === "request recovers") succeed();
    scheduler.schedule("test", outcome === "first succeeds" || outcome === "request recovers" ? next : old);
    t.mock.timers.tick(5 * MINUTE);
    await Promise.resolve();
    const retried = outcome === "retry succeeds" || outcome === "both fail";
    assert.deepEqual(calls, retried ? [50 * MINUTE, 55 * MINUTE] : [50 * MINUTE]);
    t.mock.timers.tick(10 * MINUTE);
    assert.equal(calls.length, retried ? 2 : 1);
    const successLog = info.mock.calls.find(call => String(call.arguments[0]).includes("refresh succeeded"));
    if (outcome === "both fail") {
      assert.equal(successLog, undefined);
    } else {
      assert.deepEqual(successLog?.arguments[1], {
        refreshedAt: new Date((outcome === "retry succeeds" ? 55 : 50) * MINUTE).toISOString(),
        previousAccessTokenExpiresAt: new Date(old.expiresAt).toISOString(),
        accessTokenExpiresAt: new Date(next.expiresAt).toISOString(),
        refreshTokenReturned: true,
        refreshTokenChanged: true,
      });
    }
  });
}
