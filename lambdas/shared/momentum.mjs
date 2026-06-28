// momentum.mjs — the deterministic momentum score for gp-momentum-1.0.0.
// MATH DECIDES. Pure: no I/O, no randomness. Same input → same output.
//
// This is Clenow's "Stocks on the Move" volatility-adjusted momentum, the number
// the strategy ranks on (see docs/Strategy-v1.md §3):
//
//   1. Fit a least-squares line to ln(close) over the last `lookback` (90) bars.
//   2. Annualize the per-day log-slope by exp-compounding over a trading year
//      (`tradingDaysPerYear` = 252):  annualized = exp(slope)^252 − 1.
//   3. Multiply by the regression R²:  momentum = annualized × R².
//
// The × R² term is the whole point: it rewards trends that are strong AND smooth —
// a steep but choppy chart (low R²) scores below a steady climber. Higher = better.
//
// Step-1 scope (build order): this module produces the per-name score only. The
// cross-sectional rank / rankPct (top-N portfolio construction) is computed across
// the whole universe in the scanner, not here. We reuse the indicators already in
// marketdata.mjs for everything else (SMA/ATR/dollar-volume/gap) — the only new
// math here is the log-price regression, which has no equivalent there.

// Frozen tunables for the score. The annualization constant is 252 (the standard
// US trading-day count) — confirmed with the human; Strategy-v1 §8 fixes the
// 90-day lookback. Both are overridable via opts only for tests/robustness sweeps.
export const MOMENTUM_DEFAULTS = {
  lookback: 90,
  tradingDaysPerYear: 252,
};

// Least-squares linear regression of `ys` against the integer index x = 0..n-1.
// Pure. Returns { slope, intercept, r2 } or null if there are <2 points or x has
// zero variance (impossible for x = 0..n-1 with n>=2, but guarded defensively).
//
// R² is the coefficient of determination. For a constant `ys` (zero variance) the
// ratio is undefined; we return r2 = 1, the perfect-fit value for the zero-slope
// line that exactly matches a flat series (and momentum is 0 regardless, since the
// slope is 0).
export function linearRegression(ys) {
  const n = ys.length;
  if (n < 2) return null;

  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const x = i;
    const y = ys[i];
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
  }

  const denomX = n * sxx - sx * sx; // n² · var(x)
  if (denomX === 0) return null;

  const slope = (n * sxy - sx * sy) / denomX;
  const intercept = (sy - slope * sx) / n;

  const denomY = n * syy - sy * sy; // n² · var(y)
  let r2;
  if (denomY === 0) {
    r2 = 1; // flat series → perfect fit by the zero-slope line
  } else {
    const r = (n * sxy - sx * sy) / Math.sqrt(denomX * denomY);
    r2 = r * r;
  }

  return { slope, intercept, r2 };
}

// momentumScore(closes, opts?) → { momentum, slope, r2, annualized, lookback }
// or null when the score cannot be computed honestly.
//
//   closes : array of adjusted daily closes, oldest → newest. Only the last
//            `lookback` entries are used.
//   opts   : { lookback, tradingDaysPerYear } — default to MOMENTUM_DEFAULTS.
//
// Returns null (never a garbage number) when:
//   - there are fewer than `lookback` bars (insufficient history — mirrors the
//     NO_DATA discipline), or
//   - any close in the window is non-finite or ≤ 0 (ln undefined → not tradeable
//     data).
// Full precision is preserved; rounding happens only at the persistence/display
// boundary (matching marketdata.mjs), never before the ranking decision.
export function momentumScore(closes, opts = {}) {
  const lookback = opts.lookback ?? MOMENTUM_DEFAULTS.lookback;
  const tradingDaysPerYear = opts.tradingDaysPerYear ?? MOMENTUM_DEFAULTS.tradingDaysPerYear;

  if (!Array.isArray(closes) || closes.length < lookback) return null;

  const window = closes.slice(closes.length - lookback);
  const logs = new Array(lookback);
  for (let i = 0; i < lookback; i++) {
    const c = window[i];
    if (typeof c !== "number" || !Number.isFinite(c) || c <= 0) return null;
    logs[i] = Math.log(c);
  }

  const reg = linearRegression(logs);
  if (!reg) return null;

  const { slope, r2 } = reg;
  // Annualize the per-day log-slope by exp-compounding over a trading year.
  const annualized = Math.exp(slope) ** tradingDaysPerYear - 1;
  const momentum = annualized * r2;

  return { momentum, slope, r2, annualized, lookback };
}
