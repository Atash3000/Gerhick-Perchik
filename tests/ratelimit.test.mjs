import { test } from "node:test";
import assert from "node:assert/strict";
import { createLimiter } from "../lambdas/shared/ratelimit.mjs";

test("createLimiter runs calls in order and returns their values", async () => {
  const lim = createLimiter(5);
  const order = [];
  const results = await Promise.all([
    lim(async () => { order.push(1); return "a"; }),
    lim(async () => { order.push(2); return "b"; }),
    lim(async () => { order.push(3); return "c"; }),
  ]);
  assert.deepEqual(order, [1, 2, 3]);
  assert.deepEqual(results, ["a", "b", "c"]);
});

test("createLimiter spaces calls by at least the min interval", async () => {
  const gap = 30;
  const lim = createLimiter(gap);
  const t0 = Date.now();
  await lim(() => Promise.resolve());
  await lim(() => Promise.resolve());
  await lim(() => Promise.resolve());
  // 3 calls → at least 2 gaps elapsed (generous lower bound to avoid flakiness).
  assert.ok(Date.now() - t0 >= gap * 2 - 5, "expected spacing between calls");
});

test("a failing call does not break pacing for subsequent calls", async () => {
  const lim = createLimiter(5);
  await assert.rejects(() => lim(async () => { throw new Error("boom"); }));
  const ok = await lim(async () => "recovered");
  assert.equal(ok, "recovered");
});
