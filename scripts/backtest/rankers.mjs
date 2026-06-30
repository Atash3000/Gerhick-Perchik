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

// --- test-A baseline rankers (scaffolding; NOT the production ranker) ---

// rankByScore: score all items with scoreFn(closes), sort descending, apply zones.
function rankByScore(items, scoreFn, config) {
  const scored = items
    .map((it) => ({ ticker: it.ticker, score: scoreFn(it.closes) }))
    .filter((s) => Number.isFinite(s.score))
    .sort((a, b) => b.score - a.score || a.ticker.localeCompare(b.ticker));
  return applyRankZones(scored, config);
}

// retOver: simple price return over a lookback window.
const retOver = (closes, lookback) => {
  if (closes.length <= lookback) return NaN;
  const a = closes[closes.length - 1 - lookback];
  const b = closes[closes.length - 1];
  return a > 0 ? b / a - 1 : NaN;
};

// logSlope: plain slope of log-price over momentumLookback (no R²), via simple
// least-squares. Faster/simpler than slope×R² — used to isolate R²'s contribution.
function logSlope(closes, lookback) {
  if (closes.length <= lookback) return NaN;
  const y = closes.slice(-lookback).map((c) => Math.log(c));
  const n = y.length;
  const mx = (n - 1) / 2;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (y[i] - my);
    den += (i - mx) ** 2;
  }
  return den > 0 ? num / den : NaN;
}

export const return126Ranker = (items, config) =>
  rankByScore(items, (c) => retOver(c, 126), config);

export const return189Ranker = (items, config) =>
  rankByScore(items, (c) => retOver(c, 189), config);

export const slopeRanker = (items, config) =>
  rankByScore(items, (c) => logSlope(c, config.momentumLookback), config);
