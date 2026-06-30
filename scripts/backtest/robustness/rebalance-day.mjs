// C — rebalance-day stability: same verdict across Mon–Fri; CAGR spread ≤ 3 pts.
export function runRebalanceDays(baseInputs, runMetrics) {
  const rows = [1, 2, 3, 4, 5].map((wd) => ({
    weekday: wd,
    ...sel(runMetrics(baseInputs, { rebalanceWeekday: wd })),
  }));
  const cagrs = rows.map((r) => r.cagr).filter((x) => x != null);
  const cagrSpread = cagrs.length ? Math.max(...cagrs) - Math.min(...cagrs) : null;
  return { rows, cagrSpread, sameVerdict: cagrSpread != null && cagrSpread <= 3 };
}

function sel(m) {
  return { cagr: m.cagr, maxDrawdown: m.maxDrawdown };
}
