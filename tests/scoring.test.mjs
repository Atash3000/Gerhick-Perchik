import { test } from "node:test";
import assert from "node:assert/strict";
import { score, DECISION } from "../lambdas/shared/scoring.mjs";
import { STRATEGY_VERSION } from "../lambdas/shared/version.mjs";

const round2 = (n) => Math.round(n * 100) / 100;

// A fixed tunables row (would come from gp-config at runtime). Threshold 53 is the
// gp-2.0.0 mechanical re-center (empiricalEdge 15→7.5); see docs/scoring.md.
const CONFIG = {
  buyScoreThreshold: 53,
  atrStopMultiple: 1.5,
  minRiskReward: 2.0,
  maxCorrelatedPositions: 3,
  alertMode: "observe",
  feeBps: 10,
  slippageBps: 5,
};

// A clean, fully-passing market-data object. close=100, stacked MAs, ATR=2 →
// stop=97 (risk 3), target=110 → R:R = 10/3 = 3.333. rsRank is attached by the
// scanner before scoring (cross-sectional percentile).
function baseMarketData() {
  return {
    ticker: "TEST",
    close: 100,
    ma50: 95,
    ma200: 90,
    atr: 2.0,
    rsi: 58,
    volume: 1_500_000,
    avgVolume30: 1_000_000,
    nearestSupport: { price: 98, touches: 3, strength: 0.6, brokenSupport: false },
    nearestResistance: { price: 110, touches: 3, strength: 0.7, brokenSupport: false },
    daysToEarnings: 20,
    sector: "Technology",
    rsRank: 88,
    dataAsOf: "2026-06-18",
    fresh: true,
  };
}

// gp-2.0.0: the scanner supplies fundamentals + the cross-sectional sector strength
// percentile via marketContext (both neutral-0 inside score() when absent).
const cleanContext = {
  spyBelow200ma: false,
  correlatedPositions: 0,
  newsLevel: "none",
  fundamentals: { epsGrowthQtr: 40, salesGrowthQtr: 30 },
  sectorStrengthPct: 75,
};

test("full passing case → BUY_CANDIDATE with correct derivation and breakdown", () => {
  const r = score(baseMarketData(), CONFIG, cleanContext);

  assert.equal(r.decision, DECISION.BUY_CANDIDATE);
  assert.equal(r.strategyVersion, STRATEGY_VERSION);
  assert.equal(r.dataAsOf, "2026-06-18");

  // Derived numbers — never typed in.
  assert.equal(r.entry, 100);
  assert.equal(r.stop, 97); // 100 - 1.5*2
  assert.equal(r.target, 110);
  assert.equal(r.riskReward, 3.333); // 10/3 rounded to 3dp

  // Breakdown components (gp-2.0.0 budget; gradient factors rounded to 2dp).
  assert.deepEqual(r.breakdown, {
    empiricalEdge: 7.5,    // fixed neutral midpoint (7.5 of 15) until Phase 8
    setup: 16,             // near support (+8) + strength round(6*0.6)=4 + reward round(6*0.666)=4
    trend: 15,             // close>200 (+5), close>50 (+5), 50>200 (+5)
    momentum: 10,          // RSI 58 in sweet spot
    volume: 8,             // 1.5x average
    news: 2,               // clean tape
    rsRank: 10.67,         // 12 * 88/99
    growthQuality: 9.1,    // 13 * avg(40,30)=35 /50
    sectorStrength: 3.79,  // 5 * 75/99
  });
  assert.equal(r.score, 82.06);

  // Every gate passed.
  assert.ok(Object.values(r.gates).every(Boolean));
});

test("breakdown always sums to score (invariant survives weight changes)", () => {
  const r = score(baseMarketData(), CONFIG, cleanContext);
  const sum = round2(Object.values(r.breakdown).reduce((a, b) => a + b, 0));
  assert.equal(sum, r.score);
});

// --- gp-2.0.0 new factors: missing data is neutral 0, NEVER a rejection ----------

test("MISSING rsRank → rsRank component 0, still fully scorable", () => {
  const md = baseMarketData();
  delete md.rsRank;
  const r = score(md, CONFIG, cleanContext);
  assert.notEqual(r.decision, DECISION.NO_DATA);
  assert.equal(r.breakdown.rsRank, 0);
});

test("MISSING revenue growth (eps present) → growthQuality uses eps alone", () => {
  const ctx = { ...cleanContext, fundamentals: { epsGrowthQtr: 40, salesGrowthQtr: null } };
  const r = score(baseMarketData(), CONFIG, ctx);
  // 13 * clamp(40,0,50)/50 = 13 * 0.8 = 10.4
  assert.equal(r.breakdown.growthQuality, 10.4);
});

test("MISSING eps growth (revenue present) → growthQuality uses revenue alone", () => {
  const ctx = { ...cleanContext, fundamentals: { epsGrowthQtr: null, salesGrowthQtr: 30 } };
  const r = score(baseMarketData(), CONFIG, ctx);
  // 13 * clamp(30,0,50)/50 = 13 * 0.6 = 7.8
  assert.equal(r.breakdown.growthQuality, 7.8);
});

test("BOTH fundamentals missing → growthQuality 0, still scorable, no rejection", () => {
  const ctx = { ...cleanContext, fundamentals: null };
  const r = score(baseMarketData(), CONFIG, ctx);
  assert.notEqual(r.decision, DECISION.NO_DATA);
  assert.equal(r.breakdown.growthQuality, 0);
});

test("MISSING sectorStrengthPct → sectorStrength 0, still scorable", () => {
  const ctx = { ...cleanContext, sectorStrengthPct: null };
  const r = score(baseMarketData(), CONFIG, ctx);
  assert.notEqual(r.decision, DECISION.NO_DATA);
  assert.equal(r.breakdown.sectorStrength, 0);
});

test("ALL gp-2.0.0 factor data missing → name still scores on price action alone", () => {
  const md = baseMarketData();
  delete md.rsRank;
  const ctx = { spyBelow200ma: false, correlatedPositions: 0, newsLevel: "none" };
  const r = score(md, CONFIG, ctx);
  assert.notEqual(r.decision, DECISION.NO_DATA);
  assert.equal(r.breakdown.rsRank, 0);
  assert.equal(r.breakdown.growthQuality, 0);
  assert.equal(r.breakdown.sectorStrength, 0);
  // Price-action components still scored.
  assert.equal(r.breakdown.trend, 15);
  assert.equal(r.breakdown.setup, 16);
});

test("EXTREME fundamentals are clamped — 9000% can't dominate growthQuality", () => {
  const ctx = { ...cleanContext, fundamentals: { epsGrowthQtr: 9000, salesGrowthQtr: 9000 } };
  const r = score(baseMarketData(), CONFIG, ctx);
  // clamp each to +100, avg 100, saturate at 50 → full bucket, no more.
  assert.equal(r.breakdown.growthQuality, 13);
});

test("derived R:R is the result of entry/stop/target, computed correctly", () => {
  const md = baseMarketData();
  md.nearestResistance = { price: 106, touches: 2, strength: 0.5, brokenSupport: false };
  const r = score(md, CONFIG, cleanContext);
  // stop=97, risk=3, target=106 → R:R = 6/3 = 2.0 (exactly at the minimum).
  assert.equal(r.riskReward, 2.0);
  assert.equal(r.gates.riskReward, true);
});

test("GATE: price not above 200MA → NO_SIGNAL, no score", () => {
  const md = baseMarketData();
  md.close = 85; // below ma200 (90)
  const r = score(md, CONFIG, cleanContext);
  assert.equal(r.decision, DECISION.NO_SIGNAL);
  assert.equal(r.gates.trend, false);
  assert.equal(r.score, null);
  assert.match(r.reason, /200MA/);
});

test("GATE: R:R below minimum → NO_SIGNAL", () => {
  const md = baseMarketData();
  md.nearestResistance = { price: 104, touches: 2, strength: 0.5, brokenSupport: false };
  const r = score(md, CONFIG, cleanContext); // R:R = 4/3 = 1.333 < 2
  assert.equal(r.decision, DECISION.NO_SIGNAL);
  assert.equal(r.gates.riskReward, false);
  assert.match(r.reason, /R:R/);
});

test("GATE: earnings within 3 days → NO_SIGNAL", () => {
  const md = baseMarketData();
  md.daysToEarnings = 2;
  const r = score(md, CONFIG, cleanContext);
  assert.equal(r.decision, DECISION.NO_SIGNAL);
  assert.equal(r.gates.earnings, false);
  assert.match(r.reason, /earnings/);
});

test("GATE: SPY below 200MA → NO_SIGNAL", () => {
  const r = score(baseMarketData(), CONFIG, { ...cleanContext, spyBelow200ma: true });
  assert.equal(r.decision, DECISION.NO_SIGNAL);
  assert.equal(r.gates.marketRegime, false);
  assert.match(r.reason, /SPY/);
});

test("GATE: correlated-position cap reached → NO_SIGNAL", () => {
  const r = score(baseMarketData(), CONFIG, { ...cleanContext, correlatedPositions: 3 });
  assert.equal(r.decision, DECISION.NO_SIGNAL);
  assert.equal(r.gates.correlation, false);
  assert.match(r.reason, /correlated/);
});

test("GATE: HIGH news → NO_SIGNAL", () => {
  const r = score(baseMarketData(), CONFIG, { ...cleanContext, newsLevel: "high" });
  assert.equal(r.decision, DECISION.NO_SIGNAL);
  assert.equal(r.gates.news, false);
});

test("GATE: no resistance above price → NO_SIGNAL (no tradeable target)", () => {
  const md = baseMarketData();
  md.nearestResistance = null;
  const r = score(md, CONFIG, cleanContext);
  assert.equal(r.decision, DECISION.NO_SIGNAL);
  assert.equal(r.gates.hasTarget, false);
  assert.match(r.reason, /resistance/);
});

test("gates pass but score below threshold → NO_SIGNAL but score is still returned", () => {
  // Threshold 90 is above the gp-2.0.0 ceiling (92.5) but above this name's 82.06,
  // so it cleanly NO_SIGNALs with the score still returned.
  const r = score(baseMarketData(), { ...CONFIG, buyScoreThreshold: 90 }, cleanContext);
  assert.equal(r.decision, DECISION.NO_SIGNAL);
  assert.equal(r.score, 82.06);
  assert.ok(r.breakdown);
  assert.ok(Object.values(r.gates).every(Boolean));
});

test("NO_DATA: stale feed (fresh:false) → NO_DATA, nothing scored", () => {
  const r = score({ ticker: "TEST", fresh: false, dataAsOf: "2026-06-10", reason: "stale feed" }, CONFIG, cleanContext);
  assert.equal(r.decision, DECISION.NO_DATA);
  assert.equal(r.score, null);
  assert.equal(r.gates, null);
  assert.match(r.reason, /stale/);
});

test("NO_DATA: missing required field → NO_DATA", () => {
  const md = baseMarketData();
  delete md.ma200;
  const r = score(md, CONFIG, cleanContext);
  assert.equal(r.decision, DECISION.NO_DATA);
  assert.match(r.reason, /ma200/);
});

test("NO_DATA: non-finite field (NaN atr) → NO_DATA", () => {
  const md = baseMarketData();
  md.atr = NaN;
  const r = score(md, CONFIG, cleanContext);
  assert.equal(r.decision, DECISION.NO_DATA);
  assert.match(r.reason, /atr/);
});

test("NO_DATA: missing/null market data object → NO_DATA", () => {
  const r = score(null, CONFIG, cleanContext);
  assert.equal(r.decision, DECISION.NO_DATA);
});

test("GATE: HIGH news is normalized (any case) and rejected", () => {
  const r = score(baseMarketData(), CONFIG, { ...cleanContext, newsLevel: "HIGH" });
  assert.equal(r.decision, DECISION.NO_SIGNAL);
  assert.equal(r.gates.news, false);
});

test("NO_DATA: missing config tunable → NO_DATA with a clear reason", () => {
  const cfg = { ...CONFIG };
  delete cfg.atrStopMultiple;
  const r = score(baseMarketData(), cfg, cleanContext);
  assert.equal(r.decision, DECISION.NO_DATA);
  assert.match(r.reason, /config: atrStopMultiple/);
});

test("NO_DATA: non-positive ATR → NO_DATA", () => {
  const md = baseMarketData();
  md.atr = 0;
  const r = score(md, CONFIG, cleanContext);
  assert.equal(r.decision, DECISION.NO_DATA);
  assert.match(r.reason, /non-positive atr/);
});

test("NO_DATA: out-of-range config tunables are rejected with a clear reason", () => {
  for (const [k, v] of [
    ["atrStopMultiple", 0],
    ["minRiskReward", -1],
    ["maxCorrelatedPositions", -1],
    ["buyScoreThreshold", 250],
  ]) {
    const r = score(baseMarketData(), { ...CONFIG, [k]: v }, cleanContext);
    assert.equal(r.decision, DECISION.NO_DATA, `${k}=${v} should be NO_DATA`);
    assert.match(r.reason, new RegExp(k));
  }
});

test("position sizing computed when account tunables are present", () => {
  const cfg = { ...CONFIG, accountSize: 10000, riskPctPerTrade: 1 };
  const r = score(baseMarketData(), cfg, cleanContext);
  // entry 100, stop 97 → per-share risk 3; budget 100 → shares floor(100/3)=33
  assert.equal(r.sizing.shares, 33);
  assert.equal(r.sizing.riskAmount, 99); // 33 × 3
  assert.equal(r.sizing.notional, 3300); // 33 × 100
  assert.equal(r.sizing.riskPct, 1);
});

test("sizing is null when account tunables are absent (informational only)", () => {
  const r = score(baseMarketData(), CONFIG, cleanContext);
  assert.equal(r.sizing, null);
});

test("setup score ignores a support that is not below price", () => {
  const md = baseMarketData();
  md.nearestSupport = { price: 105, touches: 3, strength: 0.6, brokenSupport: false }; // above close 100
  const r = score(md, CONFIG, cleanContext);
  assert.equal(r.decision, DECISION.BUY_CANDIDATE); // resistance 110 still a valid target
  assert.equal(r.breakdown.setup, 4); // reward-room only; no support proximity/strength credit
});
