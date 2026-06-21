import { test } from "node:test";
import assert from "node:assert/strict";
import {
  performance,
  byScoreBucket,
  componentEdge,
  analyze,
  formatAnalysis,
} from "../lambdas/control/analytics.mjs";

// Synthetic CLOSED outcomes — proves the harness is correct before any real data.
function outcome(score, outcomeType, profitPct, breakdown) {
  return { status: "CLOSED", strategyVersion: "gp-1.0.0", score, outcome: outcomeType, profitPct, breakdown };
}

const SET = [
  outcome(82, "TARGET", 10, { trend: 20, setup: 16, momentum: 15 }),
  outcome(78, "TARGET", 8, { trend: 20, setup: 12, momentum: 9 }),
  outcome(71, "STOP", -3, { trend: 14, setup: 8, momentum: 4 }),
  outcome(64, "STOP", -3, { trend: 13, setup: 8, momentum: 4 }),
  outcome(60, "TIMEOUT", 1, { trend: 13, setup: 10, momentum: 9 }),
];

test("performance computes win-rate, profit factor, avg win/loss, expectancy", () => {
  const p = performance(SET);
  assert.equal(p.n, 5);
  assert.equal(p.winRate, 60); // 3 profits >0 (10, 8, 1) of 5
  assert.equal(p.avgWinPct, 6.33); // (10+8+1)/3
  assert.equal(p.avgLossPct, -3); // (-3 + -3)/2
  assert.equal(p.profitFactor, 3.17); // (10+8+1) / (3+3) = 19/6
  assert.equal(p.expectancyPct, 2.6); // (10+8-3-3+1)/5
  assert.equal(p.targets, 2);
  assert.equal(p.stops, 2);
  assert.equal(p.timeouts, 1);
});

test("performance handles empty + no-loss sets", () => {
  assert.deepEqual(performance([]), { n: 0 });
  const allWin = performance([outcome(80, "TARGET", 5, {})]);
  assert.equal(allWin.profitFactor, null); // undefined ratio, no losses
});

test("byScoreBucket groups by 10-pt band", () => {
  const b = byScoreBucket(SET);
  assert.equal(b["80s"].n, 1);
  assert.equal(b["70s"].n, 2);
  assert.equal(b["60s"].n, 2);
});

test("componentEdge ranks how well each component separates winners", () => {
  const e = componentEdge(SET);
  // trend cleanly separates: high-half (>=median) are the winners → positive edge
  assert.ok(e.trend);
  assert.ok(e.trend.winRateEdge >= 0);
  assert.equal(typeof e.trend.expectancyEdge, "number");
});

test("componentEdge returns {} below the minimum sample", () => {
  assert.deepEqual(componentEdge(SET.slice(0, 2)), {});
});

test("analyze filters by strategyVersion and bundles everything", () => {
  const mixed = [...SET, outcome(90, "TARGET", 12, { trend: 20 })];
  mixed[mixed.length - 1].strategyVersion = "gp-OLD";
  const a = analyze(mixed, { strategyVersion: "gp-1.0.0" });
  assert.equal(a.overall.n, 5); // gp-OLD excluded
  assert.ok(a.byScoreBucket["80s"]);
  assert.ok(a.componentEdge.trend);
});

test("formatAnalysis renders, and gives the honest empty message", () => {
  const text = formatAnalysis(analyze(SET, { strategyVersion: "gp-1.0.0" }), "30d");
  assert.match(text, /Analysis \(30d\) — gp-1\.0\.0/);
  assert.match(text, /PF 3\.17/);
  assert.match(text, /Component predictors/);

  const empty = formatAnalysis(analyze([], { strategyVersion: "gp-1.0.0" }));
  assert.match(empty, /No closed outcomes yet/);
  assert.match(empty, /forbidden by design/);
});
