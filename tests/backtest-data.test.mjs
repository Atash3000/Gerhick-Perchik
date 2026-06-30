import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUniverse, buildCalendar, coverageByWindow, detectStaleAndSplits } from "../scripts/backtest/data.mjs";

test("loadUniverse: cache-first, fetches only on miss", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gp-data-"));
  let calls = 0;
  const fetchBars = async (t) => { calls += 1; return [{ date: "2020-01-02", open: 1, high: 1, low: 1, close: 1, volume: 9 }]; };
  const a = await loadUniverse({ tickers: ["AAA"], startDate: "2010-01-01", dir, fetchBars, now: "2026-06-29T00:00:00Z" });
  const b = await loadUniverse({ tickers: ["AAA"], startDate: "2010-01-01", dir, fetchBars, now: "2026-06-29T00:00:00Z" });
  assert.equal(calls, 1);                  // second load hits the cache
  assert.equal(a[0].ticker, "AAA");
  assert.equal(b[0].bars.length, 1);
});

test("buildCalendar: SPY sessions within range, ascending", () => {
  const spy = ["d1", "d2", "d3", "d4"].map((date, i) => ({ date, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
  assert.deepEqual(buildCalendar(spy, "d2", "d3"), ["d2", "d3"]);
});

test("coverageByWindow: counts names spanning the window", () => {
  const uni = [
    { ticker: "OLD", bars: [{ date: "2005-01-01" }, { date: "2026-01-01" }] },
    { ticker: "NEW", bars: [{ date: "2019-01-01" }, { date: "2026-01-01" }] },
  ];
  const cov = coverageByWindow(uni, [{ window: "2008-2009", start: "2008-01-01", end: "2009-12-31" }]);
  assert.equal(cov[0].namesWithData, 1); // only OLD spans 2008-2009
  assert.equal(cov[0].total, 2);
});

test("detectStaleAndSplits: flags old cache + a price discontinuity", () => {
  const uni = [{ ticker: "SPLIT", bars: [{ date: "d1", close: 100 }, { date: "d2", close: 49 }] }];
  const w = detectStaleAndSplits(uni, { now: "2026-06-29T00:00:00Z", maxAgeDays: 7,
    fetchedAtByTicker: { SPLIT: "2026-06-01T00:00:00Z" } });
  assert.ok(w.some((s) => /SPLIT/.test(s) && /age/.test(s)));        // 28d > 7d
  assert.ok(w.some((s) => /SPLIT/.test(s) && /discontinuit/i.test(s))); // 49/100 < 0.67
});
