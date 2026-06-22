import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sma, atrWilder, rsiWilder, computeLevels,
  isTradingDay, mostRecentTradingDay, pctChange, range52w,
  smaLagged, maSlopePct, priorHighN, returnPct,
} from "../lambdas/shared/marketdata.mjs";

test("sma averages the last `period` values", () => {
  assert.equal(sma([1, 2, 3, 4, 5], 3), 4); // (3+4+5)/3
  assert.equal(sma([1, 2], 5), null); // not enough data
});

test("atrWilder equals the true range when range is constant", () => {
  // Every bar: high 11, low 9, close 10 → TR = 2 on every bar → ATR = 2.
  const bars = Array.from({ length: 30 }, () => ({ high: 11, low: 9, close: 10 }));
  assert.equal(atrWilder(bars, 14), 2);
});

test("rsiWilder returns 100 for a strictly rising series (no losses)", () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(rsiWilder(closes, 14), 100);
});

test("rsiWilder sits mid-range for an alternating series", () => {
  const closes = [];
  for (let i = 0; i < 40; i++) closes.push(100 + (i % 2 === 0 ? 0 : 1));
  const r = rsiWilder(closes, 14);
  assert.ok(r > 0 && r < 100);
});

test("rsiWilder returns neutral 50 for a flat series (no gains AND no losses)", () => {
  // A dead-flat series has avgGain === 0 && avgLoss === 0 — that is neutral, not
  // overbought. Returning 100 here would wrongly zero the momentum sub-score.
  const closes = Array.from({ length: 30 }, () => 100);
  assert.equal(rsiWilder(closes, 14), 50);
});

test("computeLevels finds clustered support below and resistance above price", () => {
  // Triangular wave 90↔110 (period 8): clean pivot highs at 110, lows at 90.
  const wave = [];
  const cycle = [90, 95, 100, 105, 110, 105, 100, 95];
  for (let c = 0; c < 7; c++) {
    for (const v of cycle) {
      wave.push({ high: v + 1, low: v - 1, close: v, volume: 1_000_000 });
    }
  }
  const atr = atrWilder(wave, 14);
  const levels = computeLevels(wave, atr, 100, 1_000_000);

  assert.ok(levels.nearestResistance, "expected a resistance level");
  assert.ok(levels.nearestSupport, "expected a support level");
  assert.ok(levels.nearestResistance.price > 100);
  assert.ok(levels.nearestSupport.price < 100);
  assert.ok(levels.nearestResistance.price > 108 && levels.nearestResistance.price < 112);
  assert.ok(levels.nearestSupport.price > 88 && levels.nearestSupport.price < 92);
  assert.ok(levels.nearestResistance.touches >= 2);
  assert.ok(levels.nearestSupport.touches >= 2);
});

test("computeLevels rejects single-touch levels (needs >=2)", () => {
  // One lonely spike high; everything else flat → no 2-touch cluster.
  const bars = Array.from({ length: 20 }, (_, i) => ({
    high: i === 10 ? 130 : 101, low: 99, close: 100, volume: 1_000_000,
  }));
  const atr = atrWilder(bars, 14);
  const levels = computeLevels(bars, atr, 100, 1_000_000);
  // The lone 130 spike must not become a resistance (only 1 touch).
  assert.equal(levels.nearestResistance, null);
});

test("trading-day calendar is weekend- and holiday-aware", () => {
  assert.equal(isTradingDay("2026-06-18"), true);  // Thursday
  assert.equal(isTradingDay("2026-06-19"), false); // Juneteenth (holiday)
  assert.equal(isTradingDay("2026-06-20"), false); // Saturday
  assert.equal(isTradingDay("2026-01-01"), false); // New Year's Day
});

test("pctChange computes latest vs prior close", () => {
  assert.equal(pctChange([{ close: 100 }, { close: 102 }]), 2);
  assert.equal(pctChange([{ close: 100 }]), null);
});

test("maSlopePct is positive for a rising series, null without enough history", () => {
  const rising = Array.from({ length: 240 }, (_, i) => 100 + i); // strictly up
  assert.ok(maSlopePct(rising, 200, 30) > 0);
  assert.equal(maSlopePct([1, 2, 3], 200, 30), null);
  // smaLagged sanity: SMA of [1..5] lagged by 1 == SMA of [1..4]
  assert.equal(smaLagged([1, 2, 3, 4, 5], 4, 1), 2.5);
});

test("priorHighN returns the highest high of the N bars before the last", () => {
  const bars = [
    { high: 10 }, { high: 12 }, { high: 11 }, // prior window
    { high: 9 }, // latest bar — excluded
  ];
  assert.equal(priorHighN(bars, 3), 12);
  assert.equal(priorHighN([{ high: 1 }], 3), null); // not enough history
});

test("returnPct computes price return over n bars, null when short", () => {
  const bars = [{ close: 100 }, { close: 110 }, { close: 121 }];
  assert.equal(returnPct(bars, 2), 21); // 121 vs 100
  assert.equal(returnPct(bars, 1), 10); // 121 vs 110
  assert.equal(returnPct(bars, 5), null);
});

test("range52w returns min low / max high over the window", () => {
  const bars = [
    { high: 10, low: 5 },
    { high: 12, low: 4 },
    { high: 11, low: 6 },
  ];
  assert.deepEqual(range52w(bars), { low52: 4, high52: 12 });
});

test("mostRecentTradingDay skips the Juneteenth holiday", () => {
  // Friday 2026-06-19 is Juneteenth → most recent completed trading day is 06-18.
  const friAfternoon = new Date("2026-06-19T20:00:00Z"); // ~16:00 ET
  assert.equal(mostRecentTradingDay(friAfternoon), "2026-06-18");
});
