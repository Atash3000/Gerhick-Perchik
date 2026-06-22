// Quality backtest (ANALYSIS ONLY — no scoring/threshold/gate change, not deployed).
//
// Replays the CURRENT deterministic scoring weekly over the watchlist history,
// SIMULATES the outcome of each candidate (and of key rejected sets) with the real
// labeler, and reports QUALITY metrics — expectancy, win/loss, profit factor,
// alpha vs SPY, max drawdown — NOT trade frequency. It also probes "false
// negatives": do the gates that reject names actually avoid losers, or block
// winners?
//
// HEAVY CAVEATS (read before trusting any number):
//  - Survivorship bias: today's 43 names are current leaders → results OPTIMISTIC.
//  - Earnings/correlation/news gates not modeled → entered set slightly larger.
//  - Trades overlap (weekly re-entry of the same name) → samples are correlated and
//    max-drawdown is approximate.
//  - One watchlist, recent regime, modest sample → exploratory, NOT conclusive.
//  - This backtests the FILTER, not real accumulated outcomes (still the goal).

import { readFile } from "node:fs/promises";
import {
  getDailyBars, sma, maSlopePct, atrWilder, rsiWilder,
  computeLevels, returnPct, range52w, PARAMS,
} from "../lambdas/shared/marketdata.mjs";
import { score, DECISION } from "../lambdas/shared/scoring.mjs";
import { labelSignal, spyBenchmark } from "../lambdas/shared/labeling.mjs";
import { getActiveConfig } from "../lambdas/shared/config.mjs";

const CHECKPOINT_EVERY = 5;   // ~weekly
const LOOKBACK_CHECKPOINTS = 65;
const round = (n, dp = 2) => (n == null || Number.isNaN(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function marketDataAsOf(ticker, sector, bars, idx) {
  const slice = bars.slice(0, idx + 1);
  if (slice.length < Math.max(PARAMS.maLong, PARAMS.pivotLookback) + 1) return { ticker, fresh: false };
  const closes = slice.map((b) => b.close);
  const vols = slice.map((b) => b.volume);
  const last = slice[slice.length - 1];
  const atr = atrWilder(slice, PARAMS.atrPeriod);
  const avgVolume30 = sma(vols, PARAMS.avgVolumeWindow);
  const { nearestSupport, nearestResistance } = computeLevels(slice, atr, last.close, avgVolume30, PARAMS);
  const { low52, high52 } = range52w(slice);
  return {
    ticker, sector, close: round(last.close, 2),
    ma50: round(sma(closes, PARAMS.maShort), 2), ma150: round(sma(closes, PARAMS.maMid), 2),
    ma200: round(sma(closes, PARAMS.maLong), 2), ma200SlopePct: maSlopePct(closes, PARAMS.maLong, PARAMS.maSlopeLag),
    atr: round(atr, 2), rsi: round(rsiWilder(closes, PARAMS.rsiPeriod), 2),
    volume: Math.round(last.volume), avgVolume30: Math.round(avgVolume30), low52, high52,
    return63d: returnPct(slice, 63), return126d: returnPct(slice, 126), return252d: returnPct(slice, 252),
    nearestSupport, nearestResistance, daysToEarnings: 99, dataAsOf: last.date, fresh: true,
  };
}

function category(result) {
  if (result.decision === DECISION.BUY_CANDIDATE) return "CANDIDATE";
  if (result.decision === DECISION.NO_DATA) return "no_data";
  const r = result.reason || "";
  if (/SPY below 200MA/.test(r)) return "market_regime";
  if (/not above 200MA/.test(r)) return "below_200MA";
  if (/no resistance|target not above/.test(r)) return "no_target";
  if (/R:R/.test(r)) return "rr_too_low";
  if (/non-positive risk/.test(r)) return "bad_risk";
  if (/score .* < threshold/.test(r)) return "below_threshold";
  return "other";
}

// Simulate a trade with derived levels forward; null if unresolved/levels missing.
function simulate(ticker, bars, idx, result, config, spyBars) {
  if (!(result.entry > 0) || !(result.stop > 0) || !(result.target > 0)) return null;
  const entryDate = bars[idx].date;
  const fwd = bars.slice(idx); // entry bar + forward (for re-anchor)
  const label = labelSignal(
    { entry: result.entry, stop: result.stop, target: result.target, entryDate },
    fwd,
    { feeBps: config.feeBps, slippageBps: config.slippageBps, timeoutTradingDays: config.timeoutTradingDays }
  );
  if (!label) return null; // not enough forward data yet
  const bench = spyBenchmark(spyBars, entryDate, label.exitDate);
  const alpha = typeof bench.spyReturnPct === "number" ? round(label.profitPct - bench.spyReturnPct, 2) : null;
  return { ticker, entryDate, exitDate: label.exitDate, outcome: label.outcome, profitPct: label.profitPct, score: result.score, alpha };
}

function summarize(trades) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const p = trades.map((t) => t.profitPct);
  const wins = p.filter((x) => x > 0), losses = p.filter((x) => x <= 0);
  const grossW = wins.reduce((a, b) => a + b, 0), grossL = Math.abs(losses.reduce((a, b) => a + b, 0));
  const alphas = trades.map((t) => t.alpha).filter((x) => typeof x === "number");
  const ordered = [...trades].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  let eq = 1, peak = 1, maxDD = 0;
  for (const t of ordered) { eq *= 1 + t.profitPct / 100; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, (peak - eq) / peak); }
  return {
    n, winRate: round((wins.length / n) * 100, 1),
    avgWin: round(mean(wins), 2), avgLoss: round(mean(losses), 2),
    winLossRatio: wins.length && losses.length ? round(mean(wins) / Math.abs(mean(losses)), 2) : null,
    expectancyPct: round(mean(p), 2), profitFactor: grossL > 0 ? round(grossW / grossL, 2) : null,
    avgAlphaPct: alphas.length ? round(mean(alphas), 2) : null,
    posAlphaPct: alphas.length ? round((alphas.filter((a) => a > 0).length / alphas.length) * 100, 1) : null,
    maxDrawdownPct: round(maxDD * 100, 1),
    target: trades.filter((t) => t.outcome === "TARGET").length,
    stop: trades.filter((t) => t.outcome === "STOP").length,
    timeout: trades.filter((t) => t.outcome === "TIMEOUT").length,
  };
}
const show = (label, s) => {
  if (!s.n) { console.log(`  ${label}: (no resolvable trades)`); return; }
  console.log(`  ${label}: n=${s.n} win=${s.winRate}% EV=${s.expectancyPct}% PF=${s.profitFactor} ` +
    `W/L=${s.winLossRatio} avgW=${s.avgWin}% avgL=${s.avgLoss}% alpha=${s.avgAlphaPct}% posAlpha=${s.posAlphaPct}% ` +
    `maxDD=${s.maxDrawdownPct}% (${s.target}T/${s.stop}S/${s.timeout}O)`);
};

// --- data
const watchlist = JSON.parse(await readFile(new URL("../seed/watchlist.json", import.meta.url)));
const config = await getActiveConfig();
console.log(`config: threshold=${config.buyScoreThreshold} atrMult=${config.atrStopMultiple} minRR=${config.minRiskReward} timeout=${config.timeoutTradingDays}`);
const start = new Date(); start.setUTCFullYear(start.getUTCFullYear() - 3);
const startDate = start.toISOString().slice(0, 10);
const fetchBars = async (t) => { try { await new Promise((r) => setTimeout(r, 250)); return await getDailyBars(t, { startDate }); } catch (e) { console.error(`  ! ${t}: ${e.message}`); return null; } };

const spyBars = await fetchBars("SPY");
if (!spyBars) { console.error("FATAL: no SPY"); process.exit(1); }
const barsByTicker = {};
let fetched = 0;
for (const w of watchlist) { const b = await fetchBars(w.ticker); if (b) { barsByTicker[w.ticker] = b; fetched++; } }
console.log(`fetched ${fetched}/${watchlist.length} names\n`);

// REFUSE to run on low symbol coverage — results would be unreliable (e.g. Tiingo
// monthly 500-symbol quota exhausted on the shared key). Better no answer than a
// misleading one.
const MIN_COVERAGE = 0.9;
if (fetched / watchlist.length < MIN_COVERAGE) {
  console.error(
    `\nABORT: only ${fetched}/${watchlist.length} symbols fetched ` +
      `(< ${MIN_COVERAGE * 100}%). Likely the Tiingo free-tier 500-symbol/month ` +
      `quota on the shared /edge-hunter key. Backtest needs the full universe to be ` +
      `meaningful — refusing to produce unreliable numbers. See docs / the dedicated-key issue.`
  );
  process.exit(2);
}

// checkpoints: weekly, each with >= timeout+2 forward bars
const lastUsable = spyBars.length - 1 - (config.timeoutTradingDays + 2);
const checkpoints = [];
for (let i = lastUsable; i >= 0 && checkpoints.length < LOOKBACK_CHECKPOINTS; i -= CHECKPOINT_EVERY) checkpoints.unshift(spyBars[i].date);
const tickerIdx = (bars, date) => { let lo = -1; for (let i = 0; i < bars.length; i++) { if (bars[i].date <= date) lo = i; else break; } return lo; };
const spyIdx = new Map(spyBars.map((b, i) => [b.date, i]));

const cat = {};
const entered = [], rrRejected = [], belowThreshold = [];
const fwd60 = { entered: [], below200: [] };
const byBucket = {};

for (const date of checkpoints) {
  const spyMd = marketDataAsOf("SPY", null, spyBars, spyIdx.get(date));
  const spyBelow200ma = spyMd.fresh ? spyMd.close < spyMd.ma200 : false;
  for (const w of watchlist) {
    const bars = barsByTicker[w.ticker]; if (!bars) continue;
    const idx = tickerIdx(bars, date); if (idx < 0) continue;
    const md = marketDataAsOf(w.ticker, w.sector, bars, idx);
    const result = score(md, config, { spyBelow200ma, correlatedPositions: 0, newsLevel: "none" });
    const c = category(result); cat[c] = (cat[c] ?? 0) + 1;
    const f60 = bars[idx + 60] ? round((bars[idx + 60].close / bars[idx].close - 1) * 100, 2) : null;
    if (c === "CANDIDATE") {
      const t = simulate(w.ticker, bars, idx, result, config, spyBars);
      if (t) entered.push(t);
      if (f60 != null) fwd60.entered.push(f60);
    } else if (c === "rr_too_low") {
      const t = simulate(w.ticker, bars, idx, result, config, spyBars); if (t) rrRejected.push(t);
    } else if (c === "below_threshold") {
      const t = simulate(w.ticker, bars, idx, result, config, spyBars);
      if (t) { belowThreshold.push(t); const b = `${Math.floor(result.score / 10) * 10}s`; (byBucket[b] ??= []).push(t); }
    } else if (c === "below_200MA") {
      if (f60 != null) fwd60.below200.push(f60);
    }
  }
}

console.log(`=== ${checkpoints.length} weekly checkpoints, ${checkpoints[0]} → ${checkpoints[checkpoints.length - 1]} ===\n`);
console.log("QUALITY of ENTERED candidates (what the live filter would trade):");
show("entered", summarize(entered));
console.log("\nFALSE-NEGATIVE PROBES (would-be outcomes of REJECTED names):");
show("rr_too_low rejects ", summarize(rrRejected));
show("below_threshold    ", summarize(belowThreshold));
console.log("  below_threshold by score bucket:");
for (const k of Object.keys(byBucket).sort()) show(`    ${k}`, summarize(byBucket[k]));
console.log("\nTREND GATE check — forward 60-day raw return (proxy):");
console.log(`  entered (>200MA):    avg ${round(mean(fwd60.entered), 2)}%  n=${fwd60.entered.length}`);
console.log(`  rejected (<200MA):   avg ${round(mean(fwd60.below200), 2)}%  n=${fwd60.below200.length}`);

console.log("\n=== gate rejection breakdown (every week x ticker eval) ===");
const total = Object.values(cat).reduce((a, b) => a + b, 0);
for (const [k, v] of Object.entries(cat).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(k).padEnd(18)} ${String(v).padStart(5)}  ${round((v / total) * 100, 1)}%`);
}
