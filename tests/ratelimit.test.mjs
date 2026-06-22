import { test } from "node:test";
import assert from "node:assert/strict";
import { createLimiter, withRetry, isRateLimited } from "../lambdas/shared/ratelimit.mjs";

const noSleep = async () => {};

test("isRateLimited classifies Tiingo/Finnhub rate-limit errors", () => {
  assert.equal(isRateLimited(new Error("Tiingo request failed: 429 Too Many Requests")), true);
  assert.equal(isRateLimited(new Error("Tiingo rate-limited / quota: run over your hourly allocation")), true);
  assert.equal(isRateLimited(new Error("Tiingo returned no bars for FOO")), false);
  assert.equal(isRateLimited(new Error("boom")), false);
  assert.equal(isRateLimited(undefined), false);
});

test("withRetry retries a rate-limit error then succeeds", async () => {
  let n = 0;
  const r = await withRetry(
    async () => { n += 1; if (n < 3) throw new Error("429 Too Many Requests"); return "ok"; },
    { sleep: noSleep }
  );
  assert.equal(r, "ok");
  assert.equal(n, 3); // 1 + 2 retries
});

test("withRetry gives up after `retries` and rethrows (caller catches → no crash)", async () => {
  let n = 0;
  await assert.rejects(
    () => withRetry(async () => { n += 1; throw new Error("429"); }, { retries: 2, sleep: noSleep }),
    /429/
  );
  assert.equal(n, 3); // initial + 2 retries, then rethrow
});

test("withRetry does NOT retry a non-rate-limit error", async () => {
  let n = 0;
  await assert.rejects(
    () => withRetry(async () => { n += 1; throw new Error("bad ticker"); }, { sleep: noSleep }),
    /bad ticker/
  );
  assert.equal(n, 1); // no retries
});

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
