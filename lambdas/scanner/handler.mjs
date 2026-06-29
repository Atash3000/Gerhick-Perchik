// scanner/handler.mjs — the momentum daily scan (gp-momentum-1.0.0).
//
// Flow: read tunables (gp-config) → SPY regime (close vs regimeMa, + context) →
// gather the UNION of enabled watchlist + open-position tickers → build each name's
// momentum view + eligibility → cross-sectional rank → planScan (pure decisions:
// exits-first, governor, construct) → executePlan (persist; snapshotsOnly gates
// outcomes/alerts). Math decides; this handler only orchestrates I/O.
//
// OBSERVE mode only. The risk governor is wired but INERT in observe (no real
// equity curve yet — it never blocks; real breakers belong to the step-5 backtest).

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

import { getActiveConfig } from "../shared/config.mjs";
import { getDailyBars, buildMomentumData, KEY_PATHS } from "../shared/marketdata.mjs";
import { isRegimeOn, isEligible, rankByMomentum, riskGovernor } from "../shared/portfolio.mjs";
import { createStore, momentumParams } from "../shared/store.mjs";
import { sendTelegram } from "../shared/telegram.mjs";
import { STRATEGY_VERSION } from "../shared/version.mjs";
import { planScan, executePlan } from "./orchestrate.mjs";

const REGIME_TICKER = "SPY";
export const COVERAGE_MIN_PCT = 50;

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// #4 (the load-bearing handler contract): gather the UNION of enabled-watchlist
// tickers and open-position tickers. A position you've since DISABLED on the
// watchlist (or that fell off it) is still HELD — it must keep being managed
// (exits checked, trailing stop refreshed), so it can never silently strand.
// Enabled rows win on sector; open-only tickers are added with their stored sector.
// Pure.
export function unionTickers(enabledWatchlist, openOutcomes) {
  const map = new Map();
  for (const w of enabledWatchlist ?? []) map.set(w.ticker, { ticker: w.ticker, sector: w.sector ?? null });
  for (const o of openOutcomes ?? []) {
    if (!map.has(o.ticker)) map.set(o.ticker, { ticker: o.ticker, sector: o.sector ?? null });
  }
  return [...map.values()];
}

// The held book the momentum scanner manages: every MOMENTUM-FAMILY open outcome
// (gp-momentum-*), so a future momentum version bump never strands a position from
// its trailing-stop refresh / exits. Legacy NON-momentum outcomes (e.g. gp-2.0.0)
// are EXCLUDED — they lack peakClose and would be wrongly closed as `data_error` by
// the momentum exit logic; the (unchanged) labeler handles their fixed stop/target.
// Cross-version wind-down policy is tracked in issue #84. Pure.
export function momentumFamilyOpen(outcomes) {
  return (outcomes ?? []).filter((o) => String(o.strategyVersion ?? "").startsWith("gp-momentum"));
}

// Fetch bars + build the momentum view + eligibility for each ticker. `fetchBars`
// is injectable for tests. A per-ticker fetch error becomes a NO_DATA row (kept in
// the universe so the snapshot table preserves the full day), never a thrown scan.
export async function gatherUniverse(tickers, config, { fetchBars, now }) {
  const out = [];
  for (const t of tickers) {
    try {
      const bars = await fetchBars(t.ticker);
      const md = buildMomentumData(t.ticker, bars, config, { now });
      const eligibility = md.fresh
        ? isEligible(bars, config)
        : { eligible: false, insufficientHistory: md.insufficientHistory === true, checks: null };
      out.push({ ticker: t.ticker, sector: t.sector, md, eligibility });
    } catch (err) {
      console.error(`gp_scan_failed: ${t.ticker}: ${err.message}`);
      out.push({
        ticker: t.ticker, sector: t.sector,
        md: { fresh: false, reason: `fetch error: ${err.message}`, dataAsOf: null },
        eligibility: { eligible: false, insufficientHistory: false, checks: null },
        fetchError: true,
      });
    }
  }
  return out;
}

// Health check for a completed scan (pure). 0 snapshots, a high error rate, or low
// fresh coverage is a silent data failure even when the Lambda "succeeded".
export function assessScanHealth({ expectedCount, snapshotsWritten, errorCount, freshDataCount }) {
  if (!expectedCount) return { healthy: true, reason: null };
  if (snapshotsWritten === 0) return { healthy: false, reason: `no snapshots written across ${expectedCount} names` };
  const errRate = errorCount / expectedCount;
  if (errRate >= 0.5) return { healthy: false, reason: `high error rate ${Math.round(errRate * 100)}% (${errorCount}/${expectedCount})` };
  if (typeof freshDataCount === "number") {
    const cov = (freshDataCount / expectedCount) * 100;
    if (cov < COVERAGE_MIN_PCT) return { healthy: false, reason: `low coverage ${Math.round(cov)}% (${freshDataCount}/${expectedCount} fresh)` };
  }
  return { healthy: true, reason: null };
}

// SPY regime + capture-only context. Returns { regimeOn, asOf, spy } or null when
// SPY data is stale/short (→ abort: never score on an untrustworthy regime).
async function getRegime(config, now) {
  let bars;
  try {
    bars = await getDailyBars(REGIME_TICKER, { now });
  } catch (err) {
    console.error(`gp_scan_failed: SPY regime fetch — ${err.message}`);
    return null;
  }
  const md = buildMomentumData(REGIME_TICKER, bars, config, { now });
  if (!md.fresh) return null;
  const on = isRegimeOn(bars.map((b) => b.close), config);
  if (on == null) return null;
  return {
    regimeOn: on,
    asOf: md.dataAsOf,
    spy: {
      spyBelow200ma: !on,
      asOf: md.dataAsOf,
      close: md.close,
      ma200: md.ma200,
      return63d: md.return63d,
      return126d: md.return126d,
      return252d: md.return252d,
    },
  };
}

async function loadEnabledWatchlist(tableName) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const out = await doc.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: "#en = :true",
        ExpressionAttributeNames: { "#en": "enabled" },
        ExpressionAttributeValues: { ":true": true },
        ExclusiveStartKey,
      })
    );
    items.push(...(out.Items ?? []));
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items.map((row) => ({
    ticker: row.ticker ?? String(row.pk).replace(/^TICKER#/, ""),
    sector: row.sector ?? null,
  }));
}

// A plain OBSERVE-mode momentum buy notification (no LLM; rich narration is a later
// polish). Never says "BUY" outside live mode.
function momentumAlert(buy, alertMode) {
  const r = buy.result;
  const prefix = alertMode === "live"
    ? "🟢 MOMENTUM ENTRY"
    : "📋 OBSERVE — tracking only, not a recommendation";
  return [
    prefix,
    `${r.ticker}  rank #${r.rank} (momentum ${r.momentum?.toFixed?.(3) ?? r.momentum})`,
    `entry ${r.entry}  stop ${r.stop}  shares ${r.shares}  risk ${r.initialRiskPct}%`,
  ].join("\n");
}

export async function handler(event) {
  const startMs = Date.now();
  console.log("gp_keypaths", JSON.stringify(KEY_PATHS));

  // Post-deploy SMOKE TEST: verify the handler LOADS + can reach config/watchlist,
  // without a full scan. (event {"smokeTest": true}.)
  if (event?.smokeTest) {
    const config = await getActiveConfig(process.env.CONFIG_TABLE);
    const watchlist = await loadEnabledWatchlist(process.env.WATCHLIST_TABLE);
    return { ok: true, smoke: true, configLoaded: !!config, watchlistCount: watchlist.length, strategyVersion: STRATEGY_VERSION };
  }

  // Dry-run flag: real-data scan that writes snapshots ONLY (no outcomes, no alerts)
  // — the manual real-data checkpoint before the schedule re-enables.
  const snapshotsOnly = event?.snapshotsOnly === true;
  const now = new Date();

  const config = await getActiveConfig(process.env.CONFIG_TABLE);

  const regime = await getRegime(config, now);
  if (!regime) {
    console.error("gp_scan_failed: SPY regime data stale/unavailable; aborting scan");
    return { ok: false, reason: "regime_data_stale", strategyVersion: STRATEGY_VERSION };
  }

  const store = createStore();
  const watchlist = await loadEnabledWatchlist(process.env.WATCHLIST_TABLE);
  // Held book = every MOMENTUM-FAMILY open position (NOT filtered to the EXACT
  // current version — that would strand prior-momentum positions across a version
  // bump, freezing their trail). strategyVersion governs row STAMPING + outcome
  // ANALYSIS, not management. Legacy non-momentum outcomes are excluded (they'd be
  // mis-closed as data_error) and left to the labeler's fixed exits. Today all open
  // positions are momentum, so this is exact. See #84.
  const openOutcomes = momentumFamilyOpen(await store.listOpenOutcomes());

  const tickers = unionTickers(watchlist, openOutcomes);
  const gathered = await gatherUniverse(tickers, config, { fetchBars: (t) => getDailyBars(t, { now }), now });

  const eligible = gathered.filter((g) => g.md.fresh && g.eligibility.eligible);
  const ranked = rankByMomentum(eligible.map((g) => ({ ticker: g.ticker, closes: g.md.bars.map((b) => b.close) })), config);

  // Risk governor — WIRED but INERT in observe: there is no real paper-equity curve
  // yet, so it's fed zeros and never blocks. Real circuit breakers run in the step-5
  // backtest (where equity is tracked). Do NOT mistake observe for having live breakers.
  const governor = riskGovernor({ weeklyPct: 0, monthlyPct: 0, fromPeakPct: 0 }, config);

  const plan = planScan({
    config, regimeOn: regime.regimeOn, asOf: regime.asOf,
    gathered, ranked, openOutcomes, governor,
    accountValue: config.accountSize, spy: regime.spy,
  });

  const scanId = `scan-${regime.asOf}-${Date.now().toString(36)}`;
  const sendAlert = snapshotsOnly ? null : async (buy) => { await sendTelegram(momentumAlert(buy, config.alertMode)); };

  let exec;
  try {
    exec = await executePlan(plan, { store, sendAlert, snapshotsOnly, scanId, params: momentumParams(config) });
  } catch (err) {
    console.error(`gp_scan_failed: executePlan — ${err.message}`);
    return { ok: false, reason: "execute_failed", error: err.message, strategyVersion: STRATEGY_VERSION };
  }

  const expectedCount = tickers.length;
  const freshDataCount = gathered.filter((g) => g.md.fresh === true).length;
  const errorCount = gathered.filter((g) => g.fetchError).length;
  const health = assessScanHealth({ expectedCount, snapshotsWritten: exec.snapshotsWritten, errorCount, freshDataCount });
  const coveragePct = expectedCount ? Math.round((freshDataCount / expectedCount) * 1000) / 10 : 0;

  const summary = {
    ok: true,
    degraded: !health.healthy,
    degradedReason: health.reason,
    snapshotsOnly,
    strategyVersion: STRATEGY_VERSION,
    scanId,
    asOf: regime.asOf,
    regimeOn: regime.regimeOn,
    durationMs: Date.now() - startMs,
    coverage: { expectedCount, freshDataCount, errorCount, coveragePct },
    decisions: tally(plan.snapshots),
    exits: exec.exitsClosed,
    refreshed: exec.refreshed,
    buys: plan.buys.length,
    outcomesOpened: exec.outcomesOpened,
    snapshotsWritten: exec.snapshotsWritten,
    alertsSent: exec.alertsSent,
    alertErrors: exec.alertErrors, // honest tally — tolerated alert failures (not a scan failure)
    alertMode: config.alertMode,
  };

  if (!health.healthy) {
    console.error(
      `gp_scan_failed: degraded scan — ${health.reason} — expected=${expectedCount} ` +
      `fresh=${freshDataCount} errors=${errorCount} snapshots=${exec.snapshotsWritten} coverage=${coveragePct}%`
    );
  }
  console.log("gp_scan_summary", JSON.stringify(summary));
  return summary;
}

function tally(snapshots) {
  const t = {};
  for (const s of snapshots) t[s.result.decision] = (t[s.result.decision] ?? 0) + 1;
  return t;
}
