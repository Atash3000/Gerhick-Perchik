// Opportunity backtest (ANALYSIS ONLY — no scoring change, not deployed).
// Replays the CURRENT deterministic scoring over the last ~6 months for the
// watchlist, at a weekly cadence, to estimate candidate flow + gate bottlenecks.
//
// Point-in-time: for each weekly checkpoint we slice each ticker's bars up to that
// day and recompute indicators/levels with the SAME pure functions the scanner
// uses, then run score().
//
// CAVEATS (stated in output): earnings-blackout and correlation gates are NOT
// backtestable accurately (forward earnings calendar / path-dependent positions),
// so they're neutralized here and excluded from rejection counts. News is inert
// (stubbed). Survivorship bias: today's 43 names are current leaders, so candidate
// rates here are likely OPTIMISTIC vs a real historical universe.

import { readFile } from "node:fs/promises";
import {
  getDailyBars, sma, smaLagged, maSlopePct, atrWilder, rsiWilder,
  computeLevels, returnPct, range52w, PARAMS,
} from "../lambdas/shared/marketdata.mjs";
import { score, DECISION } from "../lambdas/shared/scoring.mjs";
import { getActiveConfig } from "../lambdas/shared/config.mjs";

const MONTHS = 6;
const CHECKPOINT_EVERY = 5; // ~weekly (trading days)

function round(n, dp = 2) { return n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp; }

// Rebuild the marketData object as-of `idx` (inclusive) from a full bars array,
// mirroring getMarketData but on a historical slice. daysToEarnings is set
// non-blocking (99) because the forward calendar can't be reconstructed.
function marketDataAsOf(ticker, sector, bars, idx) {
  const slice = bars.slice(0, idx + 1);
  const minBars = Math.max(PARAMS.maLong, PARAMS.pivotLookback) + 1;
  if (slice.length < minBars) return { ticker, fresh: false, reason: "short" };
  const closes = slice.map((b) => b.close);
  const vols = slice.map((b) => b.volume);
  const last = slice[slice.length - 1];
  const atr = atrWilder(slice, PARAMS.atrPeriod);
  const avgVolume30 = sma(vols, PARAMS.avgVolumeWindow);
  const { nearestSupport, nearestResistance } = computeLevels(slice, atr, last.close, avgVolume30, PARAMS);
  const { low52, high52 } = range52w(slice);
  return {
    ticker, sector,
    close: round(last.close, 2),
    ma50: round(sma(closes, PARAMS.maShort), 2),
    ma150: round(sma(closes, PARAMS.maMid), 2),
    ma200: round(sma(closes, PARAMS.maLong), 2),
    ma200SlopePct: maSlopePct(closes, PARAMS.maLong, PARAMS.maSlopeLag),
    atr: round(atr, 2),
    rsi: round(rsiWilder(closes, PARAMS.rsiPeriod), 2),
    volume: Math.round(last.volume),
    avgVolume30: Math.round(avgVolume30),
    low52, high52,
    return63d: returnPct(slice, 63),
    return126d: returnPct(slice, 126),
    return252d: returnPct(slice, 252),
    nearestSupport, nearestResistance,
    daysToEarnings: 99, // non-blocking (earnings gate not backtestable)
    sector,
    dataAsOf: last.date,
    fresh: true,
  };
}

function categorize(result) {
  if (result.decision === DECISION.BUY_CANDIDATE) return "CANDIDATE";
  if (result.decision === DECISION.NO_DATA) return "no_data";
  const r = result.reason || "";
  if (/SPY below 200MA/.test(r)) return "market_regime";
  if (/not above 200MA/.test(r)) return "below_200MA";
  if (/no resistance above price/.test(r)) return "no_target(resistance)";
  if (/target not above entry/.test(r)) return "no_target(resistance)";
  if (/R:R/.test(r)) return "rr_too_low";
  if (/non-positive risk/.test(r)) return "bad_risk";
  if (/score .* < threshold/.test(r)) return "below_threshold";
  return "other:" + r.slice(0, 30);
}

const watchlist = JSON.parse(await readFile(new URL("../seed/watchlist.json", import.meta.url)));
const config = await getActiveConfig();
console.log(`config: threshold=${config.buyScoreThreshold} atrMult=${config.atrStopMultiple} minRR=${config.minRiskReward}`);
console.log(`watchlist: ${watchlist.length} names\n`);

// Fetch ~3y of bars (enough prior history for ma200/return252 at the window start).
const start = new Date(); start.setUTCFullYear(start.getUTCFullYear() - 3);
const startDate = start.toISOString().slice(0, 10);

async function fetchBars(t) {
  try {
    await new Promise((r) => setTimeout(r, 250)); // gentle on Tiingo
    return await getDailyBars(t, { startDate });
  } catch (e) {
    console.error(`  ! ${t}: ${e.message}`);
    return null;
  }
}

const spyBars = await fetchBars("SPY");
if (!spyBars) { console.error("FATAL: no SPY data"); process.exit(1); }

const barsByTicker = {};
let fetched = 0;
for (const w of watchlist) {
  const b = await fetchBars(w.ticker);
  if (b) { barsByTicker[w.ticker] = b; fetched += 1; }
}
console.log(`fetched bars for ${fetched}/${watchlist.length} names\n`);

// Refuse on low symbol coverage (e.g. Tiingo monthly 500-symbol quota on the
// shared key) — partial-universe results would mislead.
if (fetched / watchlist.length < 0.9) {
  console.error(`ABORT: only ${fetched}/${watchlist.length} symbols fetched (<90%). Likely Tiingo monthly quota; refusing to produce unreliable numbers.`);
  process.exit(2);
}

// Checkpoints: weekly over the last MONTHS using SPY's trading calendar.
const cutoff = new Date(); cutoff.setUTCMonth(cutoff.getUTCMonth() - MONTHS);
const cutoffStr = cutoff.toISOString().slice(0, 10);
const spyDates = spyBars.map((b) => b.date).filter((d) => d >= cutoffStr);
const checkpoints = [];
for (let i = spyDates.length - 1; i >= 0; i -= CHECKPOINT_EVERY) checkpoints.unshift(spyDates[i]);

const spyIdxByDate = new Map(spyBars.map((b, i) => [b.date, i]));
const tickerIdx = (bars, date) => { // last bar with date <= checkpoint
  let lo = -1; for (let i = 0; i < bars.length; i++) { if (bars[i].date <= date) lo = i; else break; } return lo;
};

const cat = {};
const perCheckpoint = [];
for (const date of checkpoints) {
  const si = spyIdxByDate.get(date);
  const spyMd = marketDataAsOf("SPY", null, spyBars, si);
  const spyBelow200ma = spyMd.fresh ? spyMd.close < spyMd.ma200 : false;
  let candidates = 0;
  for (const w of watchlist) {
    const bars = barsByTicker[w.ticker];
    if (!bars) continue;
    const idx = tickerIdx(bars, date);
    if (idx < 0) continue;
    const md = marketDataAsOf(w.ticker, w.sector, bars, idx);
    const result = score(md, config, { spyBelow200ma, correlatedPositions: 0, newsLevel: "none" });
    const c = categorize(result);
    cat[c] = (cat[c] ?? 0) + 1;
    if (c === "CANDIDATE") candidates += 1;
  }
  perCheckpoint.push({ date, candidates, spyBelow200ma });
}

console.log(`=== ${checkpoints.length} weekly checkpoints over last ${MONTHS} months ===`);
const counts = perCheckpoint.map((p) => p.candidates);
const sum = counts.reduce((a, b) => a + b, 0);
console.log(`candidates/week: avg ${round(sum / counts.length, 2)} · min ${Math.min(...counts)} · max ${Math.max(...counts)}`);
const weeksWithAny = counts.filter((c) => c > 0).length;
console.log(`weeks with >=1 candidate: ${weeksWithAny}/${counts.length}`);
const riskOff = perCheckpoint.filter((p) => p.spyBelow200ma).length;
console.log(`risk-off weeks (SPY<200MA, everything gated): ${riskOff}/${counts.length}\n`);

console.log("per-week candidate counts:");
console.log(perCheckpoint.map((p) => `${p.date}:${p.candidates}${p.spyBelow200ma ? "*" : ""}`).join("  "));

console.log("\n=== outcome of every (week x ticker) evaluation ===");
const total = Object.values(cat).reduce((a, b) => a + b, 0);
for (const [k, v] of Object.entries(cat).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(k).padEnd(24)} ${String(v).padStart(5)}  ${round((v / total) * 100, 1)}%`);
}
console.log(`  ${"TOTAL".padEnd(24)} ${String(total).padStart(5)}`);
