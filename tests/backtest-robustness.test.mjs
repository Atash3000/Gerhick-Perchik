import { test } from "node:test";
import assert from "node:assert/strict";
import { runAblation } from "../scripts/backtest/robustness/ablation.mjs";
import { runRebalanceDays } from "../scripts/backtest/robustness/rebalance-day.mjs";
import { runConcentration } from "../scripts/backtest/robustness/concentration.mjs";
import { runCostSensitivity } from "../scripts/backtest/robustness/cost.mjs";
import { runTrendMaSweep } from "../scripts/backtest/robustness/sweep.mjs";
import { runBaselines } from "../scripts/backtest/robustness/baseline.mjs";
import {
  return126Ranker,
  return189Ranker,
  slopeRanker,
  momentumRanker,
  applyRankZones,
} from "../scripts/backtest/rankers.mjs";

// ---------------------------------------------------------------------------
// G — ablation
// ---------------------------------------------------------------------------
test("runAblation: one row per removed rule + a baseline row", () => {
  const runMetrics = (_inputs, opts) => ({
    cagr: opts.ablation && Object.keys(opts.ablation).length ? 5 : 9,
    maxDrawdown: 20,
    sharpe: 0.5,
  });
  const rows = runAblation({}, runMetrics);
  const removed = rows.map((r) => r.removed);
  assert.ok(removed.includes("baseline"));
  for (const f of ["noRegime", "noRanking", "noAtrSizing", "noGovernor", "noTrend"]) {
    assert.ok(removed.includes(f));
  }
});

test("runAblation: baseline row has cagr=9, ablation rows have cagr=5", () => {
  const runMetrics = (_inputs, opts) => ({
    cagr: opts.ablation && Object.keys(opts.ablation).length ? 5 : 9,
    maxDrawdown: 20,
    sharpe: 0.5,
  });
  const rows = runAblation({}, runMetrics);
  const base = rows.find((r) => r.removed === "baseline");
  assert.equal(base.cagr, 9);
  const ablRow = rows.find((r) => r.removed === "noRegime");
  assert.equal(ablRow.cagr, 5);
});

test("runAblation: each row has cagr, maxDrawdown, sharpe", () => {
  const runMetrics = () => ({ cagr: 7, maxDrawdown: 18, sharpe: 0.6 });
  const rows = runAblation({}, runMetrics);
  assert.equal(rows.length, 6); // baseline + 5 flags
  for (const row of rows) {
    assert.ok("cagr" in row);
    assert.ok("maxDrawdown" in row);
    assert.ok("sharpe" in row);
  }
});

// ---------------------------------------------------------------------------
// C — rebalance-day
// ---------------------------------------------------------------------------
test("runRebalanceDays: 5 rows, computes spread + sameVerdict", () => {
  const runMetrics = (_i, opts) => ({
    cagr: 10 + opts.rebalanceWeekday * 0.1,
    maxDrawdown: 20,
  });
  const r = runRebalanceDays({}, runMetrics);
  assert.equal(r.rows.length, 5);
  assert.ok(Math.abs(r.cagrSpread - 0.4) < 1e-9); // (10.5 - 10.1)
});

test("runRebalanceDays: sameVerdict true when spread <= 3", () => {
  const runMetrics = (_i, opts) => ({ cagr: 10 + opts.rebalanceWeekday * 0.1, maxDrawdown: 20 });
  const r = runRebalanceDays({}, runMetrics);
  assert.equal(r.sameVerdict, true);
});

test("runRebalanceDays: sameVerdict false when spread > 3", () => {
  const runMetrics = (_i, opts) => ({ cagr: opts.rebalanceWeekday * 2, maxDrawdown: 20 });
  const r = runRebalanceDays({}, runMetrics);
  // spread = 10 - 2 = 8 > 3
  assert.equal(r.sameVerdict, false);
});

test("runRebalanceDays: rows have weekday 1..5", () => {
  const runMetrics = (_i, opts) => ({ cagr: opts.rebalanceWeekday, maxDrawdown: 5 });
  const r = runRebalanceDays({}, runMetrics);
  assert.deepEqual(r.rows.map((row) => row.weekday), [1, 2, 3, 4, 5]);
});

// ---------------------------------------------------------------------------
// B — concentration
// ---------------------------------------------------------------------------
test("runConcentration: stripping best months lowers the return proxy", () => {
  // 24 monthly steps; one huge month dominates.
  const curve = [];
  let nav = 100000;
  for (let i = 0; i < 24 * 21; i++) {
    const monthly = i === 21 * 5 ? 1.5 : 1.001; // one +50% month
    nav *= Math.pow(monthly, 1 / 21);
    curve.push({
      date: `2010-${String(1 + Math.floor(i / 21)).padStart(2, "0")}-01`,
      nav,
      invested: nav,
      cash: 0,
    });
  }
  const c = runConcentration(curve);
  assert.ok(c.strip10 <= c.full); // removing the best months reduces the proxy
});

test("runConcentration: full >= strip5 >= strip10 >= strip20", () => {
  const curve = [];
  let nav = 100000;
  for (let i = 0; i < 36 * 21; i++) {
    // spike in months 3, 10, 20 (0-indexed month numbers)
    const monthIdx = Math.floor(i / 21);
    const monthly = [3, 10, 20].includes(monthIdx) ? 1.4 : 1.002;
    nav *= Math.pow(monthly, 1 / 21);
    curve.push({
      date: `2010-${String(1 + monthIdx).padStart(2, "0")}-01`,
      nav,
      invested: nav,
      cash: 0,
    });
  }
  const c = runConcentration(curve);
  assert.ok(c.full >= c.strip5);
  assert.ok(c.strip5 >= c.strip10);
  assert.ok(c.strip10 >= c.strip20);
});

// ---------------------------------------------------------------------------
// E — cost sensitivity
// ---------------------------------------------------------------------------
test("runCostSensitivity: returns base and double objects with cagr + maxDrawdown", () => {
  const runMetrics = (inputs) => ({
    cagr: inputs.config.slippageBps === 10 ? 12 : 8,
    maxDrawdown: 20,
  });
  const baseInputs = { config: { slippageBps: 10 } };
  const r = runCostSensitivity(baseInputs, runMetrics);
  assert.ok("base" in r && "double" in r);
  assert.ok("cagr" in r.base && "maxDrawdown" in r.base);
  assert.ok("cagr" in r.double && "maxDrawdown" in r.double);
  assert.equal(r.base.cagr, 12);
  assert.equal(r.double.cagr, 8); // slippage doubled → lower cagr
});

test("runCostSensitivity: double run receives 2x slippageBps", () => {
  let capturedSlippage;
  const runMetrics = (inputs) => {
    capturedSlippage = inputs.config.slippageBps;
    return { cagr: 10, maxDrawdown: 15 };
  };
  // Call twice; first call = base, second = double
  const calls = [];
  const trackingRun = (inputs, opts) => {
    calls.push(inputs.config.slippageBps);
    return { cagr: 10, maxDrawdown: 15 };
  };
  runCostSensitivity({ config: { slippageBps: 5 } }, trackingRun);
  assert.equal(calls[0], 5);  // base
  assert.equal(calls[1], 10); // doubled
});

// ---------------------------------------------------------------------------
// J — trend-MA sweep
// ---------------------------------------------------------------------------
test("runTrendMaSweep: 6 rows, one per trendMa value", () => {
  const runMetrics = (_inputs, _opts) => ({ cagr: 10, maxDrawdown: 20 });
  const rows = runTrendMaSweep({}, runMetrics);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map((r) => r.trendMa), [80, 90, 100, 110, 120, 150]);
});

test("runTrendMaSweep: each row has trendMa, cagr, maxDrawdown", () => {
  const runMetrics = (inputs) => ({ cagr: inputs.config.trendMa / 10, maxDrawdown: 5 });
  const rows = runTrendMaSweep({ config: {} }, runMetrics);
  for (const row of rows) {
    assert.ok("trendMa" in row);
    assert.ok("cagr" in row);
    assert.ok("maxDrawdown" in row);
  }
  // Verify trendMa is passed through correctly
  assert.equal(rows[0].cagr, 8); // 80/10
  assert.equal(rows[2].cagr, 10); // 100/10
});

// ---------------------------------------------------------------------------
// A — baseline rankers
// ---------------------------------------------------------------------------
const MOCK_CONFIG = {
  entryRankPct: 20,
  exitRankPct: 30,
  momentumLookback: 90,
};

// Build a simple set of 10 items with 200 closes each
function makeItems(count = 10) {
  return Array.from({ length: count }, (_, i) => ({
    ticker: `T${i}`,
    closes: Array.from({ length: 200 }, (_, d) => 100 + d * 0.1 * (i + 1)),
    // item 0 has weakest trend, item 9 has strongest
  }));
}

test("return126Ranker: returns same shape as applyRankZones (rank, rankPct, inEntryZone)", () => {
  const items = makeItems(10);
  const ranked = return126Ranker(items, MOCK_CONFIG);
  assert.ok(Array.isArray(ranked));
  assert.ok(ranked.length > 0);
  for (const r of ranked) {
    assert.ok("ticker" in r);
    assert.ok("rank" in r);
    assert.ok("rankPct" in r);
    assert.ok("inEntryZone" in r);
    assert.ok("inExitZone" in r);
  }
});

test("return189Ranker: returns same shape as applyRankZones", () => {
  const items = makeItems(10);
  const ranked = return189Ranker(items, MOCK_CONFIG);
  assert.ok(Array.isArray(ranked));
  for (const r of ranked) {
    assert.ok("rank" in r && "rankPct" in r && "inEntryZone" in r && "inExitZone" in r);
  }
});

test("slopeRanker: returns same shape as applyRankZones", () => {
  const items = makeItems(10);
  const ranked = slopeRanker(items, MOCK_CONFIG);
  assert.ok(Array.isArray(ranked));
  for (const r of ranked) {
    assert.ok("rank" in r && "rankPct" in r && "inEntryZone" in r && "inExitZone" in r);
  }
});

test("return126Ranker: higher-trend items get lower rank number (rank 1 = best)", () => {
  // Item with higher slope trend should have higher 126-day return
  const items = makeItems(5);
  const ranked = return126Ranker(items, MOCK_CONFIG);
  // The highest-trend item (T4) should rank #1
  const top = ranked.find((r) => r.rank === 1);
  assert.ok(top != null);
  assert.equal(top.ticker, "T4"); // item 4 has highest slope
});

test("runBaselines: returns 4 rows with metric and cagr", () => {
  const runMetrics = (_inputs, opts) => ({
    cagr: opts.rankFn === momentumRanker ? 12 : 9,
    maxDrawdown: 20,
  });
  const rows = runBaselines({}, runMetrics);
  assert.equal(rows.length, 4);
  const metrics = rows.map((r) => r.metric);
  assert.ok(metrics.includes("return126"));
  assert.ok(metrics.includes("return189"));
  assert.ok(metrics.includes("slopeOnly"));
  assert.ok(metrics.includes("slopeR2"));
  for (const row of rows) {
    assert.ok("cagr" in row);
  }
});
