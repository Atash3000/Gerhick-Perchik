// scanner/handler.mjs — the daily scan.
//
// Flow: read tunables (gp-config) → establish the market regime (SPY vs 200MA;
// abort if SPY data is stale) → load the enabled watchlist → for every name:
// score with the deterministic engine, snapshot it, open an outcome row for each
// BUY_CANDIDATE, and send an OBSERVE-mode Telegram alert.
//
// Two-pass: pass 1 gathers market data + fundamentals for the whole universe so
// relative-strength rank can be computed CROSS-SECTIONALLY (it needs every name);
// pass 2 scores, persists, and alerts. RS is CAPTURE-ONLY — recorded on the
// snapshot/outcome, never used in scoring/gates/threshold.
//
// Discipline (CLAUDE.md): tunables come from gp-config; a stale feed is never
// scored as current; math decides — this handler only orchestrates.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

import { getActiveConfig } from "../shared/config.mjs";
import { getMarketData, KEY_PATHS } from "../shared/marketdata.mjs";
import { getFundamentals } from "../shared/fundamentals.mjs";
import { rsRaw, rsVsSpy, rankPercentiles } from "../shared/rs.mjs";
import { score, DECISION } from "../shared/scoring.mjs";
import { createStore } from "../shared/store.mjs";
import { buildPayload, narrate, composeRichMessage, FALLBACK_NARRATION } from "../shared/narration.mjs";
import { sendTelegram } from "../shared/telegram.mjs";
import { STRATEGY_VERSION } from "../shared/version.mjs";

const REGIME_TICKER = "SPY"; // broad-market proxy for the regime gate

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Health check for a completed scan (pure). A run can return ok:true yet be a
// silent data failure — e.g. the feed rate-limits every name, so 0 snapshots are
// written. Flag those so the ops alarm (keyed on `gp_scan_failed`) pages us.
// `errorCount` = per-ticker fetch errors + per-ticker persist errors.
// `freshDataCount` = names that returned fresh market data (drives coverage).
export const COVERAGE_MIN_PCT = 50;
export function assessScanHealth({ expectedCount, snapshotsWritten, errorCount, freshDataCount }) {
  if (!expectedCount) return { healthy: true, reason: null }; // nothing to scan
  if (snapshotsWritten === 0) {
    return { healthy: false, reason: `no snapshots written across ${expectedCount} names` };
  }
  const errRate = errorCount / expectedCount;
  if (errRate >= 0.5) {
    return { healthy: false, reason: `high error rate ${Math.round(errRate * 100)}% (${errorCount}/${expectedCount})` };
  }
  if (typeof freshDataCount === "number") {
    const cov = (freshDataCount / expectedCount) * 100;
    if (cov < COVERAGE_MIN_PCT) {
      return { healthy: false, reason: `low coverage ${Math.round(cov)}% (${freshDataCount}/${expectedCount} fresh)` };
    }
  }
  return { healthy: true, reason: null };
}

// Read the enabled watchlist rows. Small table → a Scan with a filter is fine.
// Each row: { pk: "TICKER#<t>", ticker, sector, enabled, qualityTier }.
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

  // Normalise: prefer an explicit `ticker` attribute, else derive from the pk.
  return items.map((row) => ({
    ticker: row.ticker ?? String(row.pk).replace(/^TICKER#/, ""),
    sector: row.sector ?? null,
    qualityTier: row.qualityTier ?? null,
  }));
}

// SPY below its own 200MA → risk-off regime (a hard gate in scoring). Returns
// { spyBelow200ma, asOf, spyReturn126d } or null when SPY data is stale/short
// (→ abort run). spyReturn126d feeds the (capture-only) rsVsSpy alpha.
async function getMarketRegime() {
  const spy = await getMarketData(REGIME_TICKER);
  if (!spy || spy.fresh === false || typeof spy.ma200 !== "number") {
    return null;
  }
  // asOf is the canonical scan trading day, reused to key snapshots whose own
  // data may be missing (NO_DATA names).
  return {
    spyBelow200ma: spy.close < spy.ma200,
    asOf: spy.dataAsOf,
    spyReturn126d: spy.return126d ?? null,
  };
}

export async function handler(event) {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  // Startup config check: log which SSM key PATHS are in use (never the values).
  console.log("gp_keypaths", JSON.stringify(KEY_PATHS));

  // Post-deploy SMOKE TEST: verify the handler LOADS and can reach its core
  // dependencies (config + watchlist reads) — without running a full scan,
  // fetching feeds, writing data, or sending alerts. Catches the deploy-time
  // failure class unit tests can't: ESM load crash, missing env vars, IAM
  // denials. Invoked by the deploy pipeline with {"smokeTest": true}.
  if (event?.smokeTest) {
    const config = await getActiveConfig(process.env.CONFIG_TABLE);
    const watchlist = await loadEnabledWatchlist(process.env.WATCHLIST_TABLE);
    return {
      ok: true,
      smoke: true,
      configLoaded: !!config,
      watchlistCount: watchlist.length,
      strategyVersion: STRATEGY_VERSION,
    };
  }

  // 1) Tunables (gp-config ACTIVE row) — the only source of thresholds/costs.
  const config = await getActiveConfig(process.env.CONFIG_TABLE);

  // 2) Market regime. A stale SPY feed means we cannot trust the regime gate, so
  //    we score nothing rather than risk scoring on bad context.
  const regime = await getMarketRegime();
  if (!regime) {
    // `gp_scan_failed` is the ops keyword wired to the CloudWatch alarm.
    console.error("gp_scan_failed: SPY regime data stale/unavailable; aborting scan");
    return { ok: false, reason: "regime_data_stale", strategyVersion: STRATEGY_VERSION };
  }

  // 3) Universe.
  const watchlist = await loadEnabledWatchlist(process.env.WATCHLIST_TABLE);
  const store = createStore();

  // Correlation gate input: count currently-OPEN outcomes per sector (measured at
  // scan start; new opens within this same scan are not retro-counted).
  const openBySector = {};
  for (const o of await store.listOpenOutcomes()) {
    const sec = o.sector ?? "unknown";
    openBySector[sec] = (openBySector[sec] ?? 0) + 1;
  }

  const tally = { BUY_CANDIDATE: 0, NO_SIGNAL: 0, NO_DATA: 0, ERROR: 0 };
  let snapshotsWritten = 0;
  let outcomesOpened = 0;
  let writeErrors = 0;
  let alertsSent = 0;
  let alertErrors = 0;
  const candidates = [];

  // --- Pass 1: gather market data + fundamentals for the whole universe.
  // Finnhub calls are throttled inside marketdata/fundamentals (see ratelimit.mjs).
  // A per-ticker fetch failure is logged and the name is dropped from this run.
  const gathered = [];
  for (const entry of watchlist) {
    try {
      const md = await getMarketData(entry.ticker);
      const fundamentals = await getFundamentals(entry.ticker); // best-effort, never throws
      gathered.push({ entry, md, fundamentals });
    } catch (err) {
      tally.ERROR += 1;
      console.error(`gp_scan_failed: ${entry.ticker}: ${err.message}`);
    }
  }

  // --- Relative strength (CAPTURE-ONLY, cross-sectional). Compute rsRaw + rsVsSpy
  // per name, then percentile-rank rsRaw across the gathered universe. Stored on
  // the snapshot/outcome for later analysis; NOT used in scoring.
  for (const g of gathered) {
    g.md.rsRaw = rsRaw(g.md);
    g.md.rsVsSpy = rsVsSpy(g.md, regime.spyReturn126d);
  }
  const rsRankMap = rankPercentiles(gathered.map((g) => ({ key: g.entry.ticker, value: g.md.rsRaw })));
  for (const g of gathered) g.md.rsRank = rsRankMap.get(g.entry.ticker) ?? null;

  // --- Pass 2: score, persist, alert.
  for (const { entry, md, fundamentals } of gathered) {
    const marketContext = {
      spyBelow200ma: regime.spyBelow200ma,
      correlatedPositions: openBySector[entry.sector ?? "unknown"] ?? 0,
      // PHASE (later): real news classification (issue #1). Clean tape until then.
      newsLevel: "none",
      sector: entry.sector,
    };

    const result = score(md, config, marketContext);
    tally[result.decision] = (tally[result.decision] ?? 0) + 1;

    // Persist: one daily snapshot per scored name; open an outcome row for each
    // BUY_CANDIDATE (idempotent). A write failure for one name is logged and
    // skipped — it must not sink the scan.
    try {
      await store.writeSnapshot(result, {
        asOf: regime.asOf, sector: entry.sector, marketData: md, fundamentals,
      });
      snapshotsWritten += 1;
      if (result.decision === DECISION.BUY_CANDIDATE) {
        const opened = await store.openOutcome(result, {
          sector: entry.sector,
          rs: { rsRaw: md.rsRaw, rsRank: md.rsRank, rsVsSpy: md.rsVsSpy },
        });
        if (opened.opened) outcomesOpened += 1;
      }
    } catch (werr) {
      writeErrors += 1;
      console.error(`gp_scan_failed: persist ${entry.ticker}: ${werr.message}`);
    }

    if (result.decision === DECISION.BUY_CANDIDATE) {
      candidates.push({ ticker: entry.ticker, score: result.score, rr: result.riskReward });

      // OBSERVE-mode Telegram alert. Numbers are built deterministically from the
      // result; the LLM only adds a flavor sentence (fixed fallback on failure).
      // alertMode comes from config (observe by default) — live is a human act.
      try {
        const payload = buildPayload(result, md, config.alertMode);
        let flavor;
        try {
          flavor = await narrate(payload);
        } catch (nerr) {
          flavor = FALLBACK_NARRATION;
          console.error(`gp_scan_failed: narrate ${entry.ticker}: ${nerr.message}`);
        }
        await sendTelegram(composeRichMessage(result, md, config, config.alertMode, flavor));
        alertsSent += 1;
      } catch (aerr) {
        alertErrors += 1;
        console.error(`gp_scan_failed: alert ${entry.ticker}: ${aerr.message}`);
      }
    }
  }

  // Coverage metric (B7) + bad-scan self-alarm. A run with 0 snapshots, a high
  // error rate, or low fresh-data coverage is a silent data failure even though
  // the Lambda "succeeded".
  const durationMs = Date.now() - startMs;
  const expectedCount = watchlist.length;
  const scannedCount = gathered.length; // got a data object (fresh or NO_DATA)
  const freshDataCount = gathered.filter((g) => g.md.fresh === true).length;
  const noDataCount = scannedCount - freshDataCount;
  const errorCount = tally.ERROR + writeErrors;
  const coveragePct = expectedCount ? Math.round((freshDataCount / expectedCount) * 1000) / 10 : 0;

  const health = assessScanHealth({ expectedCount, snapshotsWritten, errorCount, freshDataCount });

  const coverage = {
    expectedCount,
    scannedCount,
    snapshotsWritten,
    freshDataCount,
    noDataCount,
    errorCount,
    coveragePct,
  };

  const summary = {
    ok: true,
    degraded: !health.healthy,
    degradedReason: health.reason,
    strategyVersion: STRATEGY_VERSION,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs,
    coverage,
    tally,
    outcomesOpened,
    alertsSent,
    alertErrors,
    candidates,
    alertMode: config.alertMode, // observe (default) / live — live is a human act
  };

  // Emit gp_scan_failed (the alarm keyword) with the coverage summary inline so a
  // silent data failure pages us via the ops path and the log is self-describing.
  if (!health.healthy) {
    console.error(
      `gp_scan_failed: degraded scan — ${health.reason} — ` +
        `expected=${expectedCount} fresh=${freshDataCount} noData=${noDataCount} ` +
        `snapshots=${snapshotsWritten} errors=${errorCount} coverage=${coveragePct}% ` +
        `candidates=${candidates.length} durationMs=${durationMs}`
    );
  }

  console.log("gp_scan_summary", JSON.stringify(summary));
  return summary;
}
