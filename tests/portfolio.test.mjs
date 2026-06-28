import { test } from "node:test";
import assert from "node:assert/strict";
import { isRegimeOn, isEligible, rankByMomentum, DOLLAR_VOL_WINDOW } from "../lambdas/shared/portfolio.mjs";

// Frozen Strategy-v1 §8 values used across these tests.
const CFG = {
  regimeMa: 200,
  trendMa: 100,
  minPrice: 5,
  minDollarVol: 10_000_000,
  gapFilterPct: 15,
  gapFilterWindow: 90,
  momentumLookback: 90,
  entryRankPct: 20,
  exitRankPct: 30,
};

// Build an ascending bar series of length n. close[i] = priceFn(i); volume fixed.
function bars(n, priceFn, volume = 200_000) {
  return Array.from({ length: n }, (_, i) => {
    const close = priceFn(i);
    return { date: `d${i}`, open: close, high: close, low: close, close, volume };
  });
}
function closesOf(n, fn) {
  return Array.from({ length: n }, (_, i) => fn(i));
}

// --- isRegimeOn (§2) -------------------------------------------------------

test("isRegimeOn: SPY above its regime MA → risk-on (true)", () => {
  const spy = closesOf(220, (i) => 300 + i); // steadily rising, last well above SMA200
  assert.equal(isRegimeOn(spy, CFG), true);
});

test("isRegimeOn: SPY below its regime MA → no new buys (false)", () => {
  const spy = closesOf(220, (i) => 600 - i); // steadily falling, last below SMA200
  assert.equal(isRegimeOn(spy, CFG), false);
});

test("isRegimeOn: too little history to know the regime → null (never guess)", () => {
  assert.equal(isRegimeOn(closesOf(150, (i) => 300 + i), CFG), null);
  assert.equal(isRegimeOn([], CFG), null);
});

// --- isEligible (§1, §3) ---------------------------------------------------

test("isEligible: a clean, liquid, uptrending name is eligible", () => {
  const b = bars(150, (i) => 100 + i); // rising → above its 100-MA; price≫$5; $-vol≫10M
  const r = isEligible(b, CFG);
  assert.equal(r.eligible, true);
  assert.deepEqual(r.checks, { price: true, dollarVol: true, trend: true, noBigMove: true });
});

test("isEligible: a name below its trend MA is EXCLUDED", () => {
  const b = bars(150, (i) => 300 - i); // falling → last close below its 100-MA
  const r = isEligible(b, CFG);
  assert.equal(r.checks.trend, false);
  assert.equal(r.eligible, false);
});

test("isEligible: a >=15% single-day move in the last 90 days EXCLUDES the name", () => {
  // Clean uptrend, but one day jumps +20% vs the prior close, inside the window.
  const b = bars(150, (i) => 100 + i);
  const jumpAt = 130; // within the last 90 bars
  for (let i = jumpAt; i < b.length; i++) {
    b[i].close = b[i].close * 1.20; // shift the tail up by 20% → one 20% day at jumpAt
    b[i].open = b[i].close;
  }
  const r = isEligible(b, CFG);
  assert.equal(r.checks.noBigMove, false);
  assert.equal(r.eligible, false);
});

test("isEligible: an illiquid name (thin dollar volume) is EXCLUDED", () => {
  const b = bars(150, (i) => 100 + i, 10); // close~$200 * 10 shares = ~$2k « $10M
  const r = isEligible(b, CFG);
  assert.equal(r.checks.dollarVol, false);
  assert.equal(r.eligible, false);
});

test("isEligible: a sub-$5 penny name is EXCLUDED on price", () => {
  const b = bars(150, () => 3, 5_000_000); // $3 < minPrice, even if $-vol is fine
  const r = isEligible(b, CFG);
  assert.equal(r.checks.price, false);
  assert.equal(r.eligible, false);
});

test("isEligible: insufficient history → not eligible, flagged", () => {
  const r = isEligible(bars(50, (i) => 100 + i), CFG);
  assert.equal(r.eligible, false);
  assert.equal(r.insufficientHistory, true);
});

test("DOLLAR_VOL_WINDOW is the spec's fixed 20-day liquidity window", () => {
  assert.equal(DOLLAR_VOL_WINDOW, 20);
});

// --- rankByMomentum (§3) ---------------------------------------------------

test("rankByMomentum: the strongest, smoothest trend ranks #1", () => {
  const items = [
    { ticker: "FLAT", closes: closesOf(120, () => 100) },              // no trend
    { ticker: "STRONG", closes: closesOf(120, (i) => 100 * Math.exp(0.003 * i)) }, // steep & smooth
    { ticker: "MILD", closes: closesOf(120, (i) => 100 * Math.exp(0.0008 * i)) },  // gentle & smooth
  ];
  const ranked = rankByMomentum(items, CFG);
  assert.equal(ranked[0].ticker, "STRONG");
  assert.equal(ranked[0].rank, 1);
  assert.ok(ranked[0].momentum > ranked[1].momentum);
  assert.equal(ranked.at(-1).ticker, "FLAT");
});

test("rankByMomentum: entry/exit zones honor the 20%/30% hysteresis", () => {
  // 10 names with strictly decreasing momentum (g = 0.003 down to 0.0003).
  const items = Array.from({ length: 10 }, (_, k) => ({
    ticker: `T${k}`,
    closes: closesOf(120, (i) => 100 * Math.exp((0.003 - k * 0.0003) * i)),
  }));
  const ranked = rankByMomentum(items, CFG);
  // top 20% of 10 = top 2 → inEntryZone; below top 30% (ranks 4..10) → inExitZone.
  assert.deepEqual(ranked.filter((r) => r.inEntryZone).map((r) => r.rank), [1, 2]);
  assert.equal(ranked.find((r) => r.rank === 3).inEntryZone, false);
  assert.equal(ranked.find((r) => r.rank === 3).inExitZone, false); // hold band (20–30%)
  assert.deepEqual(ranked.filter((r) => r.inExitZone).map((r) => r.rank), [4, 5, 6, 7, 8, 9, 10]);
});

test("rankByMomentum: names with insufficient history are dropped, not ranked", () => {
  const items = [
    { ticker: "OK", closes: closesOf(120, (i) => 100 * Math.exp(0.002 * i)) },
    { ticker: "SHORT", closes: closesOf(50, (i) => 100 + i) }, // < momentumLookback
  ];
  const ranked = rankByMomentum(items, CFG);
  assert.deepEqual(ranked.map((r) => r.ticker), ["OK"]);
});
