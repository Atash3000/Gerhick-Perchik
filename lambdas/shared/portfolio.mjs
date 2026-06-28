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
  // Guard a missing/invalid config (e.g. a partial row): no regime → null, never
  // throw and never default to risk-on. (Full type/range validation is issue #52.)
  if (!config || !Number.isFinite(config.regimeMa)) return null;
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
    return { eligible: false, insufficientHistory: true, invalidData: false, checks: null, metrics: null };
  }

  // Malformed-data guard: every bar we actually use (the last `need`) must have a
  // finite, positive close and a finite, non-negative volume. A bad bar must yield
  // a clean invalid-data result — never NaN in checks/metrics that could later be
  // persisted or reported.
  for (const b of bars.slice(-need)) {
    if (!Number.isFinite(b.close) || b.close <= 0 || !Number.isFinite(b.volume) || b.volume < 0) {
      return { eligible: false, insufficientHistory: false, invalidData: true, checks: null, metrics: null };
    }
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
    invalidData: false,
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

  // Sort by momentum descending, with a deterministic ticker tiebreak so the
  // ranking never depends on watchlist/scan order (ties are rare with real
  // exp-regression floats, but possible with flat/rounded data).
  scored.sort((a, b) => b.momentum - a.momentum || a.ticker.localeCompare(b.ticker));

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

// ===========================================================================
// Step-3 sub-PR 2: position sizing (§4), exits (§5), risk governor (§6).
// Pure decision functions; the scanner orchestrates them in step 4. Reuses
// atrWilder (marketdata.mjs) for ATR at the call site — not re-implemented here.
// ===========================================================================

// Position sizing (§4): equal-risk, ATR-based. `entry` and `atr` are in price
// units (`atr` is ATR over config.atrPeriod, computed by the caller via atrWilder);
// `accountValue` is the sizing base. Returns
//   { shares, stop, perShareRisk, riskAmount, notional, capped }
// or null when a real position can't be sized (bad inputs / shares <= 0).
//   stop          = entry − kStop×ATR
//   shares        = floor( accountValue × riskPctPerTrade% / (kStop×ATR) )
//   capped        = true if the positionCapPct concentration cap bound the size
// Low-vol names get more shares, high-vol fewer — equal risk per position.
export function sizePosition(entry, atr, accountValue, config) {
  const { kStop, riskPctPerTrade, positionCapPct } = config ?? {};
  if (![entry, atr, accountValue, kStop, riskPctPerTrade, positionCapPct].every((v) => Number.isFinite(v))) {
    return null;
  }
  if (entry <= 0 || atr <= 0 || accountValue <= 0 || kStop <= 0) return null;

  const perShareRisk = kStop * atr;
  if (!(perShareRisk > 0)) return null;
  const stop = round(entry - perShareRisk, 4);
  if (stop <= 0) return null;

  const riskBudget = accountValue * (riskPctPerTrade / 100);
  let shares = Math.floor(riskBudget / perShareRisk);

  // §4 concentration cap: no single position may exceed positionCapPct% of account.
  const capShares = Math.floor((accountValue * (positionCapPct / 100)) / entry);
  let capped = false;
  if (shares > capShares) {
    shares = capShares;
    capped = true;
  }
  if (shares <= 0) return null;

  return {
    shares,
    stop,
    perShareRisk: round(perShareRisk, 4),
    riskAmount: round(shares * perShareRisk, 2),
    notional: round(shares * entry, 2),
    capped,
  };
}

// Chandelier trailing stop (§5): the stop ratchets UP only, never down.
//   peakClose = max(prior peak, today's close)
//   trail     = peakClose − kStop×ATR
//   stop      = max(prior stop, trail)        ← never lowered
// Returns the position with peakClose/stop advanced.
export function updateTrailingStop(position, close, atr, config) {
  const peakClose = Math.max(position.peakClose, close);
  const trail = peakClose - config.kStop * atr;
  const stop = round(Math.max(position.stop, trail), 4);
  return { ...position, peakClose, stop };
}

// Evaluate a held position at a review (§5). `bar` = today's { high, low, close };
// `context` = { atr, trendSma, inExitZone }. First advances the trailing stop, then
// fires the first applicable exit by priority:
//   STOP  — today's low <= the (advanced) stop. Reason HARD_STOP if the stop is
//           still at/below entry (catastrophe floor), else TRAIL (locking in profit).
//   TREND — close < trendSma (below the 100-day MA).
//   RANK  — the name has fallen out of the top exitRankPct (context.inExitZone).
// Stops are the daily check; trend/rank are weekly. Returns
//   { exit, reason, stop, peakClose }  (stop/peakClose updated for persistence).
export function evaluateExits(position, bar, context, config) {
  const { peakClose, stop } = updateTrailingStop(position, bar.close, context.atr, config);

  if (bar.low <= stop) {
    return { exit: true, reason: stop <= position.entry ? "HARD_STOP" : "TRAIL", stop, peakClose };
  }
  if (context.trendSma != null && bar.close < context.trendSma) {
    return { exit: true, reason: "TREND", stop, peakClose };
  }
  if (context.inExitZone) {
    return { exit: true, reason: "RANK", stop, peakClose };
  }
  return { exit: false, reason: null, stop, peakClose };
}

// Risk governor (§6): hard circuit breakers that BLOCK NEW RISK ONLY. It never
// sells — existing positions always keep their own stops (evaluateExits). `drawdowns`
// carries positive magnitudes in % (e.g. 9 = down 9%). Returns
//   { blockNewBuys, haltAllNew, reason }   ← no sell signal exists, by design.
//   weekly  >= weeklyDdLimit  → block new buys (until next week)
//   monthly >= monthlyDdLimit → block new entries (this month)
//   peak    >= maxDdLimit     → halt ALL new trading (full review)
export function riskGovernor(drawdowns, config) {
  const { weeklyDdLimit, monthlyDdLimit, maxDdLimit } = config;
  const wk = Number(drawdowns?.weeklyPct) || 0;
  const mo = Number(drawdowns?.monthlyPct) || 0;
  const peak = Number(drawdowns?.fromPeakPct) || 0;

  if (peak >= maxDdLimit) {
    return { blockNewBuys: true, haltAllNew: true, reason: `max drawdown ${peak}% >= ${maxDdLimit}%` };
  }
  if (mo >= monthlyDdLimit) {
    return { blockNewBuys: true, haltAllNew: false, reason: `monthly drawdown ${mo}% >= ${monthlyDdLimit}%` };
  }
  if (wk >= weeklyDdLimit) {
    return { blockNewBuys: true, haltAllNew: false, reason: `weekly drawdown ${wk}% >= ${weeklyDdLimit}%` };
  }
  return { blockNewBuys: false, haltAllNew: false, reason: null };
}
