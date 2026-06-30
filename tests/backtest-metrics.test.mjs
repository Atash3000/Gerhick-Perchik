import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMetrics } from "../scripts/backtest/metrics.mjs";

test("computeMetrics: CAGR and maxDrawdown on a known curve", () => {
  // 253 sessions (≈1 year), NAV 100k → 110k linearly, with a dip to 99k mid-way.
  const curve = [];
  for (let i = 0; i < 253; i++) {
    let nav = 100000 + (10000 * i) / 252;
    if (i === 120) nav = 99000; // a trough below the running peak
    curve.push({ date: `d${i}`, nav, invested: nav, cash: 0 });
  }
  const ledger = [
    { profitPct: 5, daysHeld: 10, exitDate: "d50", costPaid: 1 },
    { profitPct: -2, daysHeld: 8, exitDate: "d80", costPaid: 1 },
  ];
  const m = computeMetrics(curve, ledger, { startEquity: 100000 });
  assert.ok(Math.abs(m.cagr - 10) < 0.5);            // ≈10% over ~1y
  assert.ok(m.maxDrawdown > 0);                       // the dip registers
  assert.equal(m.nTrades, 2);
  assert.equal(m.winRate, 50);
});

test("computeMetrics: Sharpe positive for steady gains, Sortino ≥ Sharpe", () => {
  const curve = [{ date: "d0", nav: 100000, invested: 0, cash: 100000 }];
  for (let i = 1; i < 60; i++) {
    const factor = i % 2 === 0 ? 1.0010 : 1.0012; // alternating ~0.10% / ~0.12% — positive mean, nonzero std
    curve.push({ date: `d${i}`, nav: curve[i - 1].nav * factor, invested: 0, cash: curve[i - 1].nav * factor });
  }
  const m = computeMetrics(curve, [], { startEquity: 100000 });
  assert.ok(Number.isFinite(m.sharpe) && m.sharpe > 0, `sharpe should be finite positive, got ${m.sharpe}`);
  assert.ok(m.sortino === null || m.sortino >= m.sharpe); // no/low downside → Sortino ≥ Sharpe
});
