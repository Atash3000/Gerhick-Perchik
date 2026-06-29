import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMomentumData } from "../lambdas/shared/marketdata.mjs";

const CFG = { trendMa: 100, momentumLookback: 90, gapFilterWindow: 90, atrPeriod: 20 };

// Build n ascending daily bars ending on `lastDate`, close = priceFn(i), flat OHLC.
function makeBars(n, priceFn, lastDate = "2026-06-26") {
  // Generate sequential weekday-ish dates backwards from lastDate (calendar days are
  // fine — buildMomentumData only reads bars[last].date for freshness).
  const out = [];
  let d = new Date(`${lastDate}T00:00:00Z`);
  for (let i = n - 1; i >= 0; i--) {
    const close = priceFn(i);
    out.unshift({
      date: d.toISOString().slice(0, 10),
      open: close, high: close * 1.01, low: close * 0.99, close,
      volume: 1_000_000,
    });
    d = new Date(d.getTime() - 86400000);
  }
  return out;
}

// A fixed "now" right after 2026-06-26's close so that bar is the most-recent
// trading day (2026-06-26 is a Friday).
const NOW = new Date("2026-06-26T23:00:00Z");

test("buildMomentumData computes the momentum indicator view from fresh bars", () => {
  const bars = makeBars(260, (i) => 100 + i * 0.1); // gentle uptrend, 260 bars
  const md = buildMomentumData("AAA", bars, CFG, { now: NOW });

  assert.equal(md.fresh, true);
  assert.equal(md.ticker, "AAA");
  assert.equal(md.dataAsOf, "2026-06-26");
  assert.equal(md.close, bars[bars.length - 1].close);
  assert.equal(typeof md.ma50, "number");
  assert.equal(typeof md.ma100, "number"); // trendMa
  assert.equal(typeof md.ma200, "number");
  assert.equal(typeof md.atr, "number"); // ATR20
  assert.equal(typeof md.avgVolume30, "number");
  assert.equal(typeof md.return63d, "number");
  assert.ok(md.bars === bars); // carries bars forward for eligibility/exits
});

test("buildMomentumData uses ATR over config.atrPeriod (20), not the default 14", () => {
  const bars = makeBars(260, (i) => 100 + i * 0.1);
  const md20 = buildMomentumData("AAA", bars, { ...CFG, atrPeriod: 20 }, { now: NOW });
  const md14 = buildMomentumData("AAA", bars, { ...CFG, atrPeriod: 14 }, { now: NOW });
  assert.notEqual(md20.atr, md14.atr); // period actually flows through
});

test("buildMomentumData flags a STALE feed (latest bar older than the trading day) → fresh:false", () => {
  const bars = makeBars(260, (i) => 100 + i * 0.1, "2026-06-19"); // a week stale
  const md = buildMomentumData("AAA", bars, CFG, { now: NOW });
  assert.equal(md.fresh, false);
  assert.match(md.reason, /stale/);
  assert.equal(md.dataAsOf, "2026-06-19");
});

test("buildMomentumData flags INSUFFICIENT history → fresh:false (never scored on thin data)", () => {
  const bars = makeBars(120, (i) => 100 + i * 0.1); // < 201
  const md = buildMomentumData("AAA", bars, CFG, { now: NOW });
  assert.equal(md.fresh, false);
  assert.match(md.reason, /insufficient/i);
});

test("buildMomentumData on empty/missing bars → fresh:false, no throw", () => {
  assert.equal(buildMomentumData("AAA", [], CFG, { now: NOW }).fresh, false);
  assert.equal(buildMomentumData("AAA", null, CFG, { now: NOW }).fresh, false);
});
