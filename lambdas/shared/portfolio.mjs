// portfolio.mjs — the momentum portfolio engine (gp-momentum-1.0.0). MATH DECIDES.
// Pure, deterministic: no I/O, no randomness. Implements Strategy-v1 exactly as
// frozen — regime gate, per-stock eligibility, and cross-sectional ranking.
//
// Step-3 scope (sub-PR 1): regime + eligibility + rank. Sizing, exits, and the
// risk governor land in sub-PR 2; the scanner is rewired to this module (and the
// legacy gate-and-score scoring.mjs is removed) in build-order step 4. Until then
// scoring.mjs stays untouched so the (paused) scanner still loads and deploys green.
//
// Indicators are REUSED from marketdata.mjs (sma) and momentum.mjs (momentumScore);
// nothing here is re-implemented.

import { sma } from "./marketdata.mjs";
import { momentumScore } from "./momentum.mjs";

// §1 liquidity uses a fixed 20-day average dollar-volume window. This is a frozen
// spec constant (§1), not a gp-config tunable — it never varies per run.
export const DOLLAR_VOL_WINDOW = 20;

// Regime gate (§2): new longs are allowed only when SPY closes ABOVE its regimeMa
// (200-day) SMA. `spyCloses` is ascending. Returns true/false, or null when there
// is too little history to compute the SMA — the caller must abort rather than
// guess the regime (a stale/short SPY feed is never scored as risk-on).
export function isRegimeOn(spyCloses, config) {
  if (!Array.isArray(spyCloses) || spyCloses.length < config.regimeMa) return null;
  const ma = sma(spyCloses, config.regimeMa);
  if (ma == null) return null;
  return spyCloses[spyCloses.length - 1] > ma;
}

function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// Eligibility (§1, §3) — a per-stock screen applied BEFORE ranking. `bars` is an
// ascending OHLCV array. A name is eligible only if ALL checks pass:
//   price      — last close >= minPrice                              (§1)
//   dollarVol  — 20-day avg (close*volume) >= minDollarVol           (§1)
//   trend      — last close > trendMa (100-day) SMA                  (§3.3)
//   noBigMove  — no single-day move >= gapFilterPct over the last    (§3.4)
//                gapFilterWindow days
//
// NOTE on `noBigMove`: §3 calls this "no single-day gap >= 15%". We implement it as
// a CLOSE-TO-CLOSE move (|close_i/close_{i-1} - 1|), which is the canonical Clenow
// reading and also catches violent intraday days, not just overnight gaps. The
// field is named for what it measures, not the spec's word "gap".
export function isEligible(bars, config) {
  const { minPrice, minDollarVol, trendMa, gapFilterPct: gapPct, gapFilterWindow: gapWindow } = config;

  const need = Math.max(trendMa, gapWindow + 1, DOLLAR_VOL_WINDOW);
  if (!Array.isArray(bars) || bars.length < need) {
    return { eligible: false, insufficientHistory: true, checks: null, metrics: null };
  }

  const closes = bars.map((b) => b.close);
  const price = bars[bars.length - 1].close;

  // 20-day average dollar volume (adjusted close * adjusted volume).
  const dv = bars.slice(-DOLLAR_VOL_WINDOW);
  const avgDollarVol = dv.reduce((s, b) => s + b.close * b.volume, 0) / dv.length;

  const trendSma = sma(closes, trendMa);

  // Largest |close-to-close| move over the last gapWindow days.
  const moves = closes.slice(-(gapWindow + 1));
  let maxMove = 0;
  for (let i = 1; i < moves.length; i++) {
    if (moves[i - 1] > 0) maxMove = Math.max(maxMove, Math.abs(moves[i] / moves[i - 1] - 1));
  }

  const checks = {
    price: price >= minPrice,
    dollarVol: avgDollarVol >= minDollarVol,
    trend: trendSma != null && price > trendSma,
    noBigMove: maxMove < gapPct / 100,
  };
  const eligible = checks.price && checks.dollarVol && checks.trend && checks.noBigMove;

  return {
    eligible,
    insufficientHistory: false,
    checks,
    metrics: {
      price,
      avgDollarVol: round(avgDollarVol, 0),
      trendSma: trendSma == null ? null : round(trendSma, 4),
      maxMovePct: round(maxMove * 100, 2),
    },
  };
}

// Rank eligible candidates by the momentum score (§3). `items` is a list of
// { ticker, closes } (closes ascending). For each, compute momentum via the step-1
// score (using config.momentumLookback); DROP names with too little history (null
// momentum). Sort by momentum descending (1 = strongest), and tag entry/exit zones
// with the §5 hysteresis:
//   inEntryZone — within the top entryRankPct of the ranking (fresh-buy zone)
//   inExitZone  — BELOW the top exitRankPct (rank-exit zone)
// Names between the two bands are held (neither freshly bought nor rank-exited).
//
// `items` is the post-eligibility set ("rank every eligible candidate", §3); the
// zones are relative to that ranked set.
export function rankByMomentum(items, config) {
  const scored = [];
  for (const it of items) {
    const m = momentumScore(it.closes, { lookback: config.momentumLookback });
    if (m) scored.push({ ticker: it.ticker, momentum: m.momentum, slope: m.slope, r2: m.r2 });
  }

  scored.sort((a, b) => b.momentum - a.momentum);

  const n = scored.length;
  const entryCut = Math.ceil((config.entryRankPct / 100) * n);
  const exitCut = Math.ceil((config.exitRankPct / 100) * n);

  return scored.map((s, i) => {
    const rank = i + 1; // 1 = strongest
    const rankPct = n > 1 ? round(((n - rank) / (n - 1)) * 100, 2) : 100;
    return {
      ...s,
      rank,
      rankPct,
      inEntryZone: rank <= entryCut, // top entryRankPct → buy
      inExitZone: rank > exitCut, // below top exitRankPct → rank exit (hysteresis)
    };
  });
}
