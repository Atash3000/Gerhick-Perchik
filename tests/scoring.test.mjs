import { test } from "node:test";
import assert from "node:assert/strict";
import { score, DECISION } from "../lambdas/shared/scoring.mjs";
import { STRATEGY_VERSION } from "../lambdas/shared/version.mjs";

// A fixed tunables row (would come from gp-config at runtime).
const CONFIG = {
  buyScoreThreshold: 60,
  atrStopMultiple: 1.5,
  minRiskReward: 2.0,
  maxCorrelatedPositions: 3,
  alertMode: "observe",
  feeBps: 10,
  slippageBps: 5,
};

// A clean, fully-passing market-data object. close=100, stacked MAs, ATR=2 →
// stop=97 (risk 3), target=110 → R:R = 10/3 = 3.333.
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
    dataAsOf: "2026-06-18",
    fresh: true,
  };
}

const cleanContext = { spyBelow200ma: false, correlatedPositions: 0, newsLevel: "none" };

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

  // Breakdown components.
  assert.deepEqual(r.breakdown, {
    empiricalEdge: 15, // fixed neutral until Phase 8
    trend: 20,         // close>200 (+6), close>50 (+7), 50>200 (+7)
    setup: 16,         // near support (+8) + strength round(6*0.6)=4 + reward round(6*0.666)=4
    momentum: 15,      // RSI 58 in sweet spot
    volume: 10,        // 1.5x average
    news: 5,           // clean tape
  });
  assert.equal(r.score, 81);

  // Every gate passed.
  assert.ok(Object.values(r.gates).every(Boolean));
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
  const r = score(baseMarketData(), { ...CONFIG, buyScoreThreshold: 90 }, cleanContext);
  assert.equal(r.decision, DECISION.NO_SIGNAL);
  assert.equal(r.score, 81);
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
