import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport } from "../scripts/backtest/report.mjs";

const M = { cagr: 9, maxDrawdown: 18, sharpe: 0.8, sortino: 1.1, winRate: 45, avgWin: 12, avgLoss: -6,
  expectancy: 2, profitFactor: 1.4, annualTurnover: 3, avgHoldingDays: 40, costDragPct: 8,
  pctTimeInCash: 22, worstLosingStreak: 4, avgExposure: 0.7, returnPerInvested: 13, nTrades: 50, finalNav: 142000 };
const SPY = { ...M, cagr: 11, maxDrawdown: 34, sharpe: 0.6, sortino: 0.7, finalNav: 150000 };

test("buildReport: stamps PRELIMINARY, rf=0, SHA, and quantified coverage", () => {
  const { markdown, json } = buildReport({
    strategyVersion: "gp-momentum-1.0.0", gitSha: "abc1234", runTimestamp: "2026-06-29T00:00:00Z",
    period: { start: "2015-01-02", end: "2026-06-26" }, universeSize: 199,
    params: { trendMa: 100, kStop: 2.5 },
    strategy: M, spy: SPY, tests: {},
    coverage: [{ window: "2008-2009", namesWithData: 42, total: 199 }],
    warnings: ["AAPL cache age 9d > 7d threshold"],
  });
  assert.match(markdown, /PRELIMINARY/);
  assert.match(markdown, /rf\s*=\s*0/);
  assert.match(markdown, /abc1234/);
  assert.match(markdown, /2008-2009: 42\/199/);
  assert.match(markdown, /cache age 9d/);
  assert.ok(Array.isArray(json.passFail));
  // Max-DD criterion: 18 ≤ 0.65*34 = 22.1 → pass.
  const dd = json.passFail.find((c) => /drawdown/i.test(c.criterion));
  assert.equal(dd.pass, true);
});
