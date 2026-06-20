// scoring.mjs — the deterministic engine. MATH DECIDES. This function alone
// produces the signal and every number (entry/stop/target/R:R/score/breakdown).
// No AI, no randomness, no I/O. Given the same inputs it returns the same result.
//
// Contract:
//   score(marketData, config, marketContext) -> result
//
//   marketData    : output of getMarketData() (or NO_DATA shape with fresh:false)
//   config        : the gp-config ACTIVE row (tunables) — injected, never hardcoded
//   marketContext : run-level context the scanner supplies:
//                     { spyBelow200ma:boolean, correlatedPositions:number,
//                       newsLevel:'none'|'low'|'medium'|'high' }
//
// Pipeline: freshness/validation -> gates (reject, don't score) -> derive
// stop/target/R:R -> score 0..100 with per-component breakdown.

import { STRATEGY_VERSION } from "./version.mjs";

export const DECISION = {
  NO_DATA: "NO_DATA",
  NO_SIGNAL: "NO_SIGNAL",
  BUY_CANDIDATE: "BUY_CANDIDATE",
};

// Max points per component. empiricalEdge stays at a fixed neutral 15 until real
// gp-outcomes data fills it (Phase 8), so the achievable ceiling now is 85, not
// 100. buyScoreThreshold is PROVISIONAL and must account for this.
export const WEIGHTS = {
  empiricalEdge: 30,
  trend: 20,
  setup: 20,
  momentum: 15,
  volume: 10,
  news: 5,
};
export const NEUTRAL_EMPIRICAL_EDGE = 15;

// RSI "healthy" momentum band (v1, signed off).
const RSI_HEALTHY_LOW = 40;
const RSI_HEALTHY_HIGH = 70;

const REQUIRED_NUMERIC = ["close", "ma50", "ma200", "atr", "rsi", "volume", "avgVolume30"];
// Fields that must be strictly positive (a 0/negative here means bad data, not a
// tradeable state). ATR=0 would also be caught later by the validRisk gate, but
// rejecting up front gives a clearer reason.
const REQUIRED_POSITIVE = ["close", "ma50", "ma200", "atr", "avgVolume30"];
const REQUIRED_CONFIG = ["atrStopMultiple", "minRiskReward", "maxCorrelatedPositions", "buyScoreThreshold"];

function noData(marketData, reason) {
  return {
    ticker: marketData?.ticker ?? null,
    decision: DECISION.NO_DATA,
    reason,
    strategyVersion: STRATEGY_VERSION,
    dataAsOf: marketData?.dataAsOf ?? null,
    score: null,
    breakdown: null,
    entry: null,
    stop: null,
    target: null,
    riskReward: null,
    gates: null,
  };
}

function noSignal(marketData, derived, gates, reason) {
  return {
    ticker: marketData.ticker,
    decision: DECISION.NO_SIGNAL,
    reason,
    strategyVersion: STRATEGY_VERSION,
    dataAsOf: marketData.dataAsOf ?? null,
    score: derived?.score ?? null,
    breakdown: derived?.breakdown ?? null,
    entry: derived?.entry ?? null,
    stop: derived?.stop ?? null,
    target: derived?.target ?? null,
    riskReward: derived?.riskReward ?? null,
    gates,
  };
}

export function score(marketData, config, marketContext = {}) {
  // --- 0. Freshness + input validation -> NO_DATA (write nothing, score nothing).
  if (!marketData || marketData.fresh === false) {
    return noData(marketData, marketData?.reason ?? "stale or missing market data");
  }
  for (const k of REQUIRED_NUMERIC) {
    if (typeof marketData[k] !== "number" || !Number.isFinite(marketData[k])) {
      return noData(marketData, `missing/invalid field: ${k}`);
    }
  }
  for (const k of REQUIRED_POSITIVE) {
    if (marketData[k] <= 0) return noData(marketData, `non-positive ${k}`);
  }
  if (!config) return noData(marketData, "missing config");
  for (const k of REQUIRED_CONFIG) {
    if (typeof config[k] !== "number" || !Number.isFinite(config[k])) {
      return noData(marketData, `missing/invalid config: ${k}`);
    }
  }

  const {
    close, ma50, ma200, atr, rsi, volume, avgVolume30,
    nearestSupport, nearestResistance, daysToEarnings,
  } = marketData;

  const ctx = {
    spyBelow200ma: marketContext.spyBelow200ma ?? false,
    correlatedPositions: marketContext.correlatedPositions ?? 0,
    // Normalize so "HIGH"/"High" still trip the news gate.
    newsLevel: String(marketContext.newsLevel ?? "none").toLowerCase(),
  };

  const atrStopMultiple = config.atrStopMultiple;
  const minRiskReward = config.minRiskReward;
  const maxCorrelatedPositions = config.maxCorrelatedPositions;
  const buyScoreThreshold = config.buyScoreThreshold;

  // --- 1. Gates: reject, don't score. Fail any → no signal, full stop.
  const gates = {};

  gates.marketRegime = !ctx.spyBelow200ma;
  if (!gates.marketRegime) return noSignal(marketData, null, gates, "SPY below 200MA");

  gates.news = ctx.newsLevel !== "high";
  if (!gates.news) return noSignal(marketData, null, gates, "HIGH-impact news present");

  gates.earnings = !(typeof daysToEarnings === "number" && daysToEarnings >= 0 && daysToEarnings <= 3);
  if (!gates.earnings) return noSignal(marketData, null, gates, `earnings within 3 days (${daysToEarnings}d)`);

  gates.trend = close > ma200;
  if (!gates.trend) return noSignal(marketData, null, gates, "price not above 200MA");

  // Target = nearest resistance above price. No valid resistance → no tradeable target.
  gates.hasTarget = !!(nearestResistance && nearestResistance.price > close);
  if (!gates.hasTarget) return noSignal(marketData, null, gates, "no resistance above price for a target");

  // --- 2. Derive levels — never typed in. R:R is the RESULT, so it can't be gamed.
  const entry = close;
  const stop = round(entry - atrStopMultiple * atr, 4);
  const target = nearestResistance.price;
  const risk = entry - stop;
  gates.validRisk = risk > 0;
  if (!gates.validRisk) return noSignal(marketData, null, gates, "non-positive risk (bad ATR/stop)");
  const riskReward = round((target - entry) / risk, 3);

  gates.targetAbovePrice = target > entry;
  if (!gates.targetAbovePrice) {
    return noSignal(marketData, { entry, stop, target, riskReward }, gates, "target not above entry");
  }

  gates.riskReward = riskReward >= minRiskReward;
  if (!gates.riskReward) {
    return noSignal(marketData, { entry, stop, target, riskReward }, gates,
      `R:R ${riskReward} < min ${minRiskReward}`);
  }

  gates.correlation = ctx.correlatedPositions < maxCorrelatedPositions;
  if (!gates.correlation) {
    return noSignal(marketData, { entry, stop, target, riskReward }, gates,
      `correlated positions ${ctx.correlatedPositions} >= cap ${maxCorrelatedPositions}`);
  }

  // --- 3. Score 0..100 with breakdown (all gates passed).
  const breakdown = {
    empiricalEdge: NEUTRAL_EMPIRICAL_EDGE, // fixed neutral until Phase 8
    trend: scoreTrend(close, ma50, ma200),
    setup: scoreSetup(close, atr, nearestSupport, riskReward, minRiskReward),
    momentum: scoreMomentum(rsi),
    volume: scoreVolume(volume, avgVolume30),
    news: scoreNews(ctx.newsLevel),
  };
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);

  const decision = total >= buyScoreThreshold ? DECISION.BUY_CANDIDATE : DECISION.NO_SIGNAL;
  return {
    ticker: marketData.ticker,
    decision,
    reason: decision === DECISION.BUY_CANDIDATE
      ? "all gates passed; score at/above threshold"
      : `all gates passed; score ${total} < threshold ${buyScoreThreshold}`,
    strategyVersion: STRATEGY_VERSION,
    dataAsOf: marketData.dataAsOf ?? null,
    score: total,
    breakdown,
    entry: round(entry, 2),
    stop: round(stop, 2),
    target: round(target, 2),
    riskReward,
    gates,
  };
}

// --- Component scorers (each capped at its weight) -------------------------

// trend (20): stacking of price/MA alignment.
function scoreTrend(close, ma50, ma200) {
  let s = 0;
  if (close > ma200) s += 6;
  if (close > ma50) s += 7;
  if (ma50 > ma200) s += 7;
  return clamp(s, 0, WEIGHTS.trend);
}

// setup (20): entry quality near support + level strength + reward headroom.
function scoreSetup(close, atr, nearestSupport, riskReward, minRiskReward) {
  let s = 0;
  // Defensive: only credit a support that is genuinely below price (marketdata
  // guarantees this, but never award setup points for a mis-classified level).
  if (nearestSupport && !nearestSupport.brokenSupport && nearestSupport.price < close) {
    const dist = close - nearestSupport.price; // >0 since support is below price
    const band = Math.min(0.03 * close, 1.0 * atr); // "near" = min(3%, 1*ATR)
    if (dist <= band) s += 8;
    else if (dist <= 2 * band) s += 4;
    s += Math.round(6 * clamp(nearestSupport.strength, 0, 1)); // up to 6 for strength
  }
  // reward room beyond the minimum R:R, up to 6.
  s += Math.round(6 * clamp((riskReward - minRiskReward) / 2, 0, 1));
  return clamp(s, 0, WEIGHTS.setup);
}

// momentum (15): RSI healthy band 40..70, best in the 50..65 sweet spot.
function scoreMomentum(rsi) {
  if (rsi >= 50 && rsi <= 65) return 15;
  if (rsi >= RSI_HEALTHY_LOW && rsi <= RSI_HEALTHY_HIGH) return 9;
  if ((rsi >= 30 && rsi < RSI_HEALTHY_LOW) || (rsi > RSI_HEALTHY_HIGH && rsi <= 75)) return 4;
  return 0;
}

// volume (10): today's participation vs 30-day average.
function scoreVolume(volume, avgVolume30) {
  if (avgVolume30 <= 0) return 0;
  const r = volume / avgVolume30;
  if (r >= 1.0 && r <= 2.0) return 10; // healthy participation
  if (r > 2.0 && r <= 3.0) return 7;   // elevated
  if (r >= 0.7 && r < 1.0) return 6;   // a touch light
  if (r > 3.0) return 4;               // possibly climactic
  return 3;                            // thin
}

// news (5): clean tape scores full; HIGH is already gated out.
function scoreNews(newsLevel) {
  if (newsLevel === "none" || newsLevel === "low") return 5;
  if (newsLevel === "medium") return 2;
  return 0;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
