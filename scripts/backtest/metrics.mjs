// metrics.mjs — Validation-Scorecard §1 metrics from an equity curve + ledger.
// PURE. Sharpe/Sortino use rf = 0 (stated in the report). All after-cost.
const round = (n, dp = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** dp) / 10 ** dp : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const std = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};

export function computeMetrics(equityCurve, ledger, { startEquity }) {
  const n = equityCurve.length;
  const navStart = startEquity;
  const navEnd = n ? equityCurve[n - 1].nav : startEquity;
  const years = n / 252;

  const cagr = years > 0 && navStart > 0 ? (Math.pow(navEnd / navStart, 1 / years) - 1) * 100 : null;

  // Max drawdown on the daily NAV curve.
  let peak = -Infinity, maxDD = 0;
  for (const p of equityCurve) { peak = Math.max(peak, p.nav); maxDD = Math.max(maxDD, (peak - p.nav) / peak); }

  // Daily returns.
  const rets = [];
  for (let i = 1; i < n; i++) rets.push(equityCurve[i].nav / equityCurve[i - 1].nav - 1);
  const rMean = mean(rets), rStd = std(rets);
  const downside = rets.filter((r) => r < 0);
  const dStd = downside.length >= 2 ? Math.sqrt(downside.reduce((a, r) => a + r * r, 0) / downside.length) : null;
  // When std=0 (perfectly consistent returns): theoretically infinite; cap at ±9999.
  const sharpe =
    rStd == null  ? null :
    rStd === 0    ? (rMean > 0 ? 9999 : rMean < 0 ? -9999 : 0) :
                    (rMean / rStd) * Math.sqrt(252);
  const sortino = dStd ? (rMean / dStd) * Math.sqrt(252) : null;

  // Trade stats.
  const p = ledger.map((t) => t.profitPct);
  const wins = p.filter((x) => x > 0), losses = p.filter((x) => x <= 0);
  const grossW = wins.reduce((a, b) => a + b, 0), grossL = Math.abs(losses.reduce((a, b) => a + b, 0));

  // Exposure + cash.
  const inCash = equityCurve.filter((e) => e.invested === 0).length;
  const avgExposure = mean(equityCurve.map((e) => (e.nav > 0 ? e.invested / e.nav : 0)));

  // Turnover (one-sided): Σ buy notional / avg equity / years. Buy notional ≈
  // entry value per ledger trade.
  const buyNotional = ledger.reduce((a, t) => a + t.entry * t.shares, 0);
  const avgEquity = mean(equityCurve.map((e) => e.nav)) ?? startEquity;
  const annualTurnover = avgEquity > 0 && years > 0 ? buyNotional / avgEquity / years : null;

  // Cost drag as % of gross return.
  const totalCost = ledger.reduce((a, t) => a + (t.costPaid ?? 0), 0);
  const grossReturn$ = navEnd - navStart + totalCost;
  const costDragPct = grossReturn$ > 0 ? (totalCost / grossReturn$) * 100 : null;

  // Worst losing streak (consecutive losing trades by exitDate).
  const ordered = [...ledger].sort((a, b) => String(a.exitDate).localeCompare(String(b.exitDate)));
  let streak = 0, worst = 0;
  for (const t of ordered) { if (t.profitPct <= 0) { streak += 1; worst = Math.max(worst, streak); } else streak = 0; }

  const totalReturnPct = navStart > 0 ? (navEnd / navStart - 1) * 100 : null;
  const returnPerInvested = avgExposure > 0 && totalReturnPct != null ? totalReturnPct / avgExposure : null;

  return {
    cagr: round(cagr), maxDrawdown: round(maxDD * 100), sharpe: round(sharpe), sortino: round(sortino),
    winRate: round(p.length ? (wins.length / p.length) * 100 : null), avgWin: round(mean(wins)), avgLoss: round(mean(losses)),
    expectancy: round(mean(p)), profitFactor: grossL > 0 ? round(grossW / grossL) : null,
    annualTurnover: round(annualTurnover), avgHoldingDays: round(mean(ledger.map((t) => t.daysHeld))),
    costDragPct: round(costDragPct), pctTimeInCash: round(n ? (inCash / n) * 100 : null),
    worstLosingStreak: worst, avgExposure: round(avgExposure), returnPerInvested: round(returnPerInvested),
    nTrades: ledger.length, finalNav: round(navEnd),
  };
}
