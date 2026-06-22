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
    targets: rows.filter((o) => o.outcome === "TARGET").length,
    stops: rows.filter((o) => o.outcome === "STOP").length,
    timeouts: rows.filter((o) => o.outcome === "TIMEOUT").length,
  };
}

// Performance grouped by 10-point score bucket.
export function byScoreBucket(rows) {
  const buckets = {};
  for (const o of rows) {
    const k = typeof o.score === "number" ? `${Math.floor(o.score / 10) * 10}s` : "n/a";
    (buckets[k] ??= []).push(o);
  }
  const out = {};
  for (const [k, set] of Object.entries(buckets)) out[k] = performance(set);
  return out;
}

// Component-predictor edge: for each key in the score `breakdown`, split closed
// outcomes at the component's MEDIAN and compare win-rate / expectancy of the
// high half vs the low half. A large positive `winRateEdge` means that component
// genuinely separates winners — i.e. it deserves weight in v2. A near-zero or
// negative edge means it doesn't (yet).
export function componentEdge(rows) {
  const withBreakdown = rows.filter((o) => o.breakdown && typeof o.breakdown === "object");
  if (withBreakdown.length < 4) return {}; // too few to split meaningfully
  const keys = Object.keys(withBreakdown[0].breakdown);
  const result = {};
  for (const key of keys) {
    const vals = withBreakdown
      .map((o) => o.breakdown[key])
      .filter((v) => typeof v === "number")
      .sort((a, b) => a - b);
    if (vals.length < 4) continue;
    const median = vals[Math.floor(vals.length / 2)];
    const high = withBreakdown.filter((o) => o.breakdown[key] >= median);
    const low = withBreakdown.filter((o) => o.breakdown[key] < median);
    if (high.length === 0 || low.length === 0) continue; // no spread in this component
    const hi = performance(high);
    const lo = performance(low);
    result[key] = {
      median,
      highWinRate: hi.winRate,
      lowWinRate: lo.winRate,
      winRateEdge: round((hi.winRate ?? 0) - (lo.winRate ?? 0), 1),
      highExpectancyPct: hi.expectancyPct,
      lowExpectancyPct: lo.expectancyPct,
      expectancyEdge: round((hi.expectancyPct ?? 0) - (lo.expectancyPct ?? 0), 2),
      nHigh: hi.n,
      nLow: lo.n,
    };
  }
  return result;
}

// Full Phase-8 analysis bundle.
export function analyze(outcomes, opts = {}) {
  const rows = closedRows(outcomes, opts);
  return {
    strategyVersion: opts.strategyVersion ?? null,
    overall: performance(rows),
    byScoreBucket: byScoreBucket(rows),
    componentEdge: componentEdge(rows),
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
    `(${o.targets} target / ${o.stops} stop / ${o.timeouts} timeout)`);

  const bk = Object.keys(a.byScoreBucket).sort();
  if (bk.length) {
    lines.push("By score bucket:");
    for (const k of bk) {
      const b = a.byScoreBucket[k];
      lines.push(`  ${k}: ${b.n} · win ${b.winRate}% · exp ${b.expectancyPct}%`);
    }
  }

  const ce = Object.entries(a.componentEdge);
  if (ce.length) {
    // Rank components by win-rate edge — the strongest predictors first.
    ce.sort((x, y) => (y[1].winRateEdge ?? 0) - (x[1].winRateEdge ?? 0));
    lines.push("Component predictors (high vs low half):");
    for (const [key, e] of ce) {
      lines.push(`  ${key}: win-rate edge ${e.winRateEdge >= 0 ? "+" : ""}${e.winRateEdge}pp · exp edge ${e.expectancyEdge >= 0 ? "+" : ""}${e.expectancyEdge}%`);
    }
  } else {
    lines.push("Component predictors: not enough data to split yet.");
  }
  return lines.join("\n");
}
