import { test } from "node:test";
import assert from "node:assert/strict";
import {
  performance,
  byRankBucket,
  analyze,
  formatAnalysis,
} from "../lambdas/control/analytics.mjs";

// Synthetic CLOSED momentum outcomes — rankPct (no score), outcome STOP|EXIT|TIMEOUT
// (no TARGET), no breakdown.
function outcome(rankPct, outcomeType, profitPct) {
  return { status: "CLOSED", strategyVersion: "gp-momentum-1.0.0", rankPct, outcome: outcomeType, profitPct };
}

const SET = [
  outcome(95, "EXIT", 10), // win
  outcome(85, "EXIT", 8), // win
  outcome(70, "STOP", -3), // loss
  outcome(65, "STOP", -3), // loss
  outcome(50, "TIMEOUT", 1), // win
];

test("performance: momentum win-rate, PF, avg win/loss, expectancy; counts STOP/EXIT/TIMEOUT", () => {
  const p = performance(SET);
  assert.equal(p.n, 5);
  assert.equal(p.winRate, 60); // 3 after-cost positive (10, 8, 1) of 5
  assert.equal(p.avgWinPct, 6.33);
  assert.equal(p.avgLossPct, -3);
  assert.equal(p.profitFactor, 3.17); // (10+8+1) / (3+3)
  assert.equal(p.expectancyPct, 2.6);
  assert.equal(p.stops, 2);
  assert.equal(p.exits, 2);
  assert.equal(p.timeouts, 1);
});

test("performance handles empty + no-loss sets", () => {
  assert.deepEqual(performance([]), { n: 0 });
  const allWin = performance([outcome(80, "EXIT", 5)]);
  assert.equal(allWin.profitFactor, null); // undefined ratio, no losses
});

test("performance uses the valid-profit subset as denominator (missing profitPct doesn't bias)", () => {
  const withMissing = [...SET, outcome(40, "TIMEOUT", undefined)];
  const p = performance(withMissing);
  assert.equal(p.n, 6);
  assert.equal(p.nValid, 5);
  assert.equal(p.invalidProfitCount, 1);
  assert.equal(p.winRate, 60); // 3 / 5 valid, not 3 / 6
  assert.equal(p.expectancyPct, 2.6);
});

test("byRankBucket groups by rank percentile band (does the strongest-ranked win more?)", () => {
  const b = byRankBucket(SET);
  assert.equal(b["80-100%"].n, 2); // rankPct 95, 85
  assert.equal(b["60-80%"].n, 2); // 70, 65
  assert.equal(b["40-60%"].n, 1); // 50
});

test("analyze filters by strategyVersion and bundles overall + byRankBucket (no componentEdge)", () => {
  const mixed = [...SET, outcome(90, "EXIT", 12)];
  mixed[mixed.length - 1].strategyVersion = "gp-OLD";
  const a = analyze(mixed, { strategyVersion: "gp-momentum-1.0.0" });
  assert.equal(a.overall.n, 5); // gp-OLD excluded
  assert.ok(a.byRankBucket["80-100%"]);
  assert.equal(a.componentEdge, undefined); // momentum has no score breakdown
});

test("formatAnalysis renders momentum, and the honest empty message", () => {
  const text = formatAnalysis(analyze(SET, { strategyVersion: "gp-momentum-1.0.0" }), "30d");
  assert.match(text, /Analysis \(30d\) — gp-momentum-1\.0\.0/);
  assert.match(text, /PF 3\.17/);
  assert.match(text, /By rank %:/);
  assert.doesNotMatch(text, /Component predictors/); // removed with the score breakdown

  const empty = formatAnalysis(analyze([], { strategyVersion: "gp-momentum-1.0.0" }));
  assert.match(empty, /No closed outcomes yet/);
  assert.match(empty, /forbidden by design/);
});
