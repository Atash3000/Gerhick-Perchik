// report.mjs — render the Scorecard run as markdown + JSON. PURE. The §3 PASS/
// FAIL checks are computed but rendered under a loud PRELIMINARY banner: nothing
// here is a verdict until the step-7 survivorship-free re-run.
const fmt = (v) => (v == null ? "—" : String(v));

function passFail(s, spy) {
  const checks = [];
  const cagrOk = s.cagr != null && spy.cagr != null && s.cagr >= spy.cagr - 2;
  checks.push({ criterion: "After-cost CAGR ≥ SPY − 2 pts", strategy: s.cagr, spy: spy.cagr, pass: cagrOk });
  const ddOk = s.maxDrawdown != null && spy.maxDrawdown != null && s.maxDrawdown <= 0.65 * spy.maxDrawdown;
  checks.push({ criterion: "Max drawdown ≤ 0.65 × SPY", strategy: s.maxDrawdown, spy: spy.maxDrawdown, pass: ddOk });
  const sortOk = s.sortino != null && spy.sortino != null && s.sortino > spy.sortino && s.sharpe >= spy.sharpe;
  checks.push({ criterion: "Sortino > SPY and Sharpe ≥ SPY", strategy: `${s.sortino}/${s.sharpe}`, spy: `${spy.sortino}/${spy.sharpe}`, pass: sortOk });
  return checks;
}

const METRIC_ROWS = [
  ["After-cost CAGR %", "cagr"], ["Max drawdown %", "maxDrawdown"], ["Sharpe (rf=0)", "sharpe"],
  ["Sortino (rf=0)", "sortino"], ["Win rate %", "winRate"], ["Avg win %", "avgWin"], ["Avg loss %", "avgLoss"],
  ["Expectancy %/trade", "expectancy"], ["Profit factor", "profitFactor"], ["Annual turnover", "annualTurnover"],
  ["Avg holding days", "avgHoldingDays"], ["Cost drag %", "costDragPct"], ["% time in cash", "pctTimeInCash"],
  ["Worst losing streak", "worstLosingStreak"], ["Avg exposure", "avgExposure"], ["Return / invested $", "returnPerInvested"],
  ["# trades", "nTrades"], ["Final NAV", "finalNav"],
];

export function buildReport(ctx) {
  const { strategy: s, spy, coverage = [], warnings = [], tests = {} } = ctx;
  const checks = passFail(s, spy);
  const json = { ...ctx, passFail: checks };

  const lines = [];
  lines.push(`# Validation Scorecard Run — ${ctx.strategyVersion}`);
  lines.push("");
  lines.push(`> **PRELIMINARY — survivorship-biased, NOT a verdict until step 7.** Run on the hand-curated watchlist; absolute numbers are optimistic. Structural tests (A/B/C/E/G/J) are read for structure, not for a verdict.`);
  lines.push("");
  lines.push(`- **git SHA:** \`${ctx.gitSha}\`  •  **run:** ${ctx.runTimestamp}`);
  lines.push(`- **period:** ${ctx.period.start} → ${ctx.period.end}  •  **universe:** ${ctx.universeSize} names`);
  lines.push(`- **Sharpe/Sortino computed with rf = 0** (both strategy and SPY, so the comparison cancels).`);
  lines.push(`- **params:** \`${JSON.stringify(ctx.params)}\``);
  lines.push("");
  lines.push(`## §1 Metrics — strategy vs SPY buy-and-hold`);
  lines.push("");
  lines.push(`| Metric | Strategy | SPY |`);
  lines.push(`|---|---|---|`);
  for (const [label, key] of METRIC_ROWS) lines.push(`| ${label} | ${fmt(s[key])} | ${fmt(spy[key])} |`);
  lines.push("");
  lines.push(`## §3 PASS/FAIL — PRELIMINARY (not a verdict)`);
  lines.push("");
  lines.push(`| Criterion | Strategy | SPY | Pass? |`);
  lines.push(`|---|---|---|---|`);
  for (const c of checks) lines.push(`| ${c.criterion} | ${fmt(c.strategy)} | ${fmt(c.spy)} | ${c.pass ? "✅" : "❌"} |`);
  lines.push("");
  lines.push(`## Survivorship coverage (quantified)`);
  lines.push("");
  for (const cov of coverage) lines.push(`- **${cov.window}: ${cov.namesWithData}/${cov.total}** names had full data over this window.`);
  if (warnings.length) {
    lines.push("");
    lines.push(`### ⚠️ Data warnings`);
    for (const w of warnings) lines.push(`- ${w}`);
  }
  // Structural test sections (rendered only when present).
  for (const [name, body] of Object.entries(tests)) {
    if (body == null) continue;
    lines.push("");
    lines.push(`## Robustness — ${name}`);
    lines.push("```json");
    lines.push(JSON.stringify(body, null, 2));
    lines.push("```");
  }
  return { markdown: lines.join("\n"), json };
}
