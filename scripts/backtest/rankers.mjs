// rankers.mjs — ranking helpers for the backtest. The PRODUCTION ranker is
// rankByMomentum (portfolio.mjs) and is reused untouched via momentumRanker.
// applyRankZones mirrors rankByMomentum's entry/exit zone tagging so the
// test-A baseline rankers (alternative metrics) produce the same shape.
import { rankByMomentum } from "../../lambdas/shared/portfolio.mjs";

const round = (n, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

// scoredDesc: array already sorted strongest-first, each { ticker, score, ... }.
// Tags each element with { rank, rankPct, inEntryZone, inExitZone } — mirrors
// the zone math that rankByMomentum uses so alternative rankers produce the
// same shape.
export function applyRankZones(scoredDesc, config) {
  const n = scoredDesc.length;
  const entryCut = Math.ceil((config.entryRankPct / 100) * n);
  const exitCut  = Math.ceil((config.exitRankPct  / 100) * n);
  return scoredDesc.map((s, i) => {
    const rank    = i + 1;
    const rankPct = n > 1 ? round(((n - rank) / (n - 1)) * 100, 2) : 100;
    return {
      ...s,
      rank,
      rankPct,
      inEntryZone: rank <= entryCut,   // top entryRankPct → fresh-buy zone
      inExitZone:  rank >  exitCut,    // below top exitRankPct → rank-exit zone
    };
  });
}

// The production momentum ranker, reused as-is.
// items: [{ ticker, closes }] — post-eligibility set, closes ascending.
export function momentumRanker(items, config) {
  return rankByMomentum(items, config);
}
