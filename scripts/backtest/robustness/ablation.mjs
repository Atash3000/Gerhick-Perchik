// G — ablation: remove one rule at a time; read on risk-adjusted terms (removing
// the governor often RAISES CAGR while wrecking drawdown — expected, not a reason
// to drop it; see Scorecard §2-G).
const FLAGS = ["noRegime", "noRanking", "noAtrSizing", "noGovernor", "noTrend"];

export function runAblation(baseInputs, runMetrics) {
  const rows = [{ removed: "baseline", ...pick(runMetrics(baseInputs, {})) }];
  for (const f of FLAGS) {
    rows.push({ removed: f, ...pick(runMetrics(baseInputs, { ablation: { [f]: true } })) });
  }
  return rows;
}

function pick(m) {
  return { cagr: m.cagr, maxDrawdown: m.maxDrawdown, sharpe: m.sharpe };
}
