import { test } from "node:test";
import assert from "node:assert/strict";
import { spyBuyHold } from "../scripts/backtest/benchmark.mjs";
import { computeMetrics } from "../scripts/backtest/metrics.mjs";

test("spyBuyHold: curve tracks SPY, one round-trip trade, metrics computable", () => {
  const cal = Array.from({ length: 100 }, (_, i) => `d${String(i).padStart(3, "0")}`);
  const spy = cal.map((date, i) => ({ date, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1e6 }));
  const cfg = { feeBps: 0, slippageBps: 10 };
  const { equityCurve, ledger } = spyBuyHold(spy, cal, 100000, cfg);
  assert.equal(equityCurve.length, cal.length);
  assert.equal(ledger.length, 1);
  const m = computeMetrics(equityCurve, ledger, { startEquity: 100000 });
  assert.ok(m.cagr !== null);
  assert.ok(m.finalNav > 100000); // SPY rose ~99% over the window, minus costs
});
