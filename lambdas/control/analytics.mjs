// analytics.mjs — Phase 8 analysis harness (pure). Turns accumulated CLOSED
// gp-outcomes into the numbers needed to TUNE thresholds/weights:
//   - profit factor, avg win / avg loss, expectancy
//   - performance by score bucket
//   - component-predictor edge: for each scoring component, does a HIGH value
//     actually separate winners from losers? (the input to v2 re-weighting)
//
// This computes; it does NOT tune. A human reviews the output and decides weight
// changes (a STRATEGY_VERSION bump). "Math decides. AI only explains."
//
// IMPORTANT: only compare within one strategyVersion — win-rates across versions
// are not comparable.

const round = (n, dp = 2) => (n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function closedRows(outcomes, { strategyVersion, sinceEpochMs } = {}) {
  return outcomes.filter(
    (o) =>
      o.status === "CLOSED" &&
      (!strategyVersion || o.strategyVersion === strategyVersion) &&
      (!sinceEpochMs || (typeof o.sk === "number" && o.sk >= sinceEpochMs))
  );
}

// Core performance stats over a set of closed outcomes.
export function performance(rows) {
  const n = rows.length;
  if (n === 0) return { n: 0 };
  // Rate/expectancy must share ONE denominator: the rows with a usable profitPct.
  // Dividing win-rate by all rows while averaging only valid profits would bias the
  // stats whenever a closed row is missing profitPct. Report both counts so a gap
  // is visible rather than silently absorbed.
  const profits = rows.map((o) => o.profitPct).filter((x) => typeof x === "number" && Number.isFinite(x));
  const nValid = profits.length;
  const invalidProfitCount = n - nValid;
  if (nValid === 0) return { n, nValid: 0, invalidProfitCount };
  const wins = profits.filter((p) => p > 0);
  const losses = profits.filter((p) => p <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  return {
    n,
    nValid,
    invalidProfitCount,
    winRate: round((wins.length / nValid) * 100, 1),
    avgWinPct: round(mean(wins), 2),
    avgLossPct: round(mean(losses), 2),
    expectancyPct: round(mean(profits), 2), // avg P&L per signal, after cost
    // profitFactor: gross wins / gross losses. null if no losses yet (undefined ratio).
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 2) : null,
    stops: rows.filter((o) => o.outcome === "STOP").length,
    exits: rows.filter((o) => o.outcome === "EXIT").length, // scanner rank/trend close
    timeouts: rows.filter((o) => o.outcome === "TIMEOUT").length,
  };
}

// Performance grouped by rank PERCENTILE band (gp-2.0.0's `score` is gone). This is
// momentum's predictor question: do the strongest-ranked names actually win more?
export function byRankBucket(rows) {
  const buckets = {};
  for (const o of rows) {
    const lo = typeof o.rankPct === "number" && Number.isFinite(o.rankPct) ? Math.min(80, Math.floor(o.rankPct / 20) * 20) : null;
    const k = lo == null ? "n/a" : `${lo}-${lo + 20}%`;
    (buckets[k] ??= []).push(o);
  }
  const out = {};
  for (const [k, set] of Object.entries(buckets)) out[k] = performance(set);
  return out;
}

// Full analysis bundle. NO component-predictor edge: momentum has no score
// `breakdown`, so the rank-bucket split IS the v1 predictor question. (The one
// pre-registered v2 experiment — a fundamental quality factor — is separate.)
export function analyze(outcomes, opts = {}) {
  const rows = closedRows(outcomes, opts);
  return {
    strategyVersion: opts.strategyVersion ?? null,
    overall: performance(rows),
    byRankBucket: byRankBucket(rows),
  };
}

export function formatAnalysis(a, label) {
  const o = a.overall;
  const lines = [`🔬 Analysis${label ? ` (${label})` : ""} — ${a.strategyVersion ?? "all"}`];
  if (!o.n) {
    lines.push(
      "No closed outcomes yet — Phase 8 needs accumulated data before tuning.",
      "(Tuning thresholds/weights on no data is forbidden by design.)"
    );
    return lines.join("\n");
  }
  lines.push(
    `Overall: ${o.n} closed · win ${o.winRate}% · PF ${o.profitFactor ?? "—"} · ` +
      `exp ${o.expectancyPct}%/trade`
  );
  lines.push(`avg win ${o.avgWinPct}% · avg loss ${o.avgLossPct}% · ` +
    `(${o.stops} stop / ${o.exits} exit / ${o.timeouts} timeout)`);

  const bk = Object.keys(a.byRankBucket).sort();
  if (bk.length) {
    lines.push("By rank %:");
    for (const k of bk) {
      const b = a.byRankBucket[k];
      lines.push(`  ${k}: ${b.n} · win ${b.winRate}% · exp ${b.expectancyPct}%`);
    }
  }
  return lines.join("\n");
}
