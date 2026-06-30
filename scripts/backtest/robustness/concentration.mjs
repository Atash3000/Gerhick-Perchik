// B — edge concentration: strip the best k% of MONTHS and recompute a return
// proxy (compounded monthly returns). A real edge survives losing its best months.
export function runConcentration(equityCurve) {
  const monthly = monthlyReturns(equityCurve);
  const proxy = (rs) => (rs.reduce((acc, r) => acc * (1 + r), 1) - 1) * 100;
  const sorted = [...monthly].sort((a, b) => b - a); // best first
  const strip = (pct) => proxy(sorted.slice(Math.ceil((pct / 100) * sorted.length)));
  return { full: proxy(monthly), strip5: strip(5), strip10: strip(10), strip20: strip(20) };
}

function monthlyReturns(curve) {
  const byMonth = new Map();
  for (const p of curve) {
    const m = String(p.date).slice(0, 7);
    byMonth.set(m, p.nav); // last nav of each month
  }
  const navs = [...byMonth.values()];
  const rs = [];
  for (let i = 1; i < navs.length; i++) rs.push(navs[i] / navs[i - 1] - 1);
  return rs;
}
