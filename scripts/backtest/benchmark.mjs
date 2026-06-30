// benchmark.mjs — SPY buy-and-hold over the identical calendar, same cost model
// and same curve/ledger shape as the engine so computeMetrics is reused verbatim.
import { afterCostProfitPct } from "../../lambdas/shared/labeling.mjs";
const round = (n, dp = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** dp) / 10 ** dp : n);

export function spyBuyHold(spyBars, calendar, startEquity, config) {
  const COST = (config.feeBps + config.slippageBps) / 1e4;
  const byDate = new Map(spyBars.map((b) => [b.date, b]));
  const first = byDate.get(calendar[0]);
  const last = byDate.get(calendar[calendar.length - 1]);
  // Fractional shares; full deployment at the first open (cost on the buy).
  const entry = first.open;
  const shares = (startEquity / (entry * (1 + COST)));
  const equityCurve = calendar.map((date) => {
    const b = byDate.get(date);
    const px = b ? b.close : entry;
    const nav = shares * px; // fully invested; cash ≈ 0
    return { date, nav: round(nav, 2), invested: round(nav, 2), cash: 0 };
  });
  const exit = last.close;
  const ledger = [{
    ticker: "SPY", entryDate: calendar[0], entry: round(entry), shares: round(shares, 6),
    exitDate: calendar[calendar.length - 1], exit: round(exit), exitReason: "end_of_backtest",
    profitPct: afterCostProfitPct(entry, exit, config), daysHeld: calendar.length - 1,
    costPaid: round(shares * (entry + exit) * COST, 2),
  }];
  return { equityCurve, ledger };
}
