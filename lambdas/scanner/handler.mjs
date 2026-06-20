// scanner/handler.mjs — the daily scan (SKELETON, Phase 3).
//
// What it does TODAY (Phase 3): reads the live tunables (gp-config), loads the
// enabled watchlist (gp-watchlist), establishes the market regime (SPY vs its
// 200MA), then scores every enabled ticker with the deterministic engine and logs
// a structured summary.
//
// What it deliberately does NOT do yet:
//   - Phase 4: write a gp-snapshots row per ticker (+ strategyVersion, dataAsOf)
//             and open a gp-outcomes row for each BUY_CANDIDATE.
//   - Phase 6: send any Telegram message / narration.
// Those points are marked `// PHASE 4` / `// PHASE 6` below.
//
// Discipline carried from CLAUDE.md:
//   - Tunables come from gp-config, never from code/env.
//   - A stale feed is never scored as current. If the market-regime feed (SPY) is
//     stale, we abort the whole run rather than score on bad context.
//   - Math decides; this handler only orchestrates reads and the scoring call.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

import { getActiveConfig } from "../shared/config.mjs";
import { getMarketData } from "../shared/marketdata.mjs";
import { score, DECISION } from "../shared/scoring.mjs";
import { createStore } from "../shared/store.mjs";
import { buildPayload, narrate, composeMessage, FALLBACK_NARRATION } from "../shared/narration.mjs";
import { sendTelegram } from "../shared/telegram.mjs";
import { STRATEGY_VERSION } from "../shared/version.mjs";

const REGIME_TICKER = "SPY"; // broad-market proxy for the regime gate

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

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
// { spyBelow200ma } or null when SPY data is stale/insufficient (→ abort run).
async function getMarketRegime() {
  const spy = await getMarketData(REGIME_TICKER);
  if (!spy || spy.fresh === false || typeof spy.ma200 !== "number") {
    return null;
  }
  // asOf is the canonical scan trading day, reused to key snapshots whose own
  // data may be missing (NO_DATA names).
  return { spyBelow200ma: spy.close < spy.ma200, asOf: spy.dataAsOf };
}

export async function handler() {
  const startedAt = new Date().toISOString();

  // 1) Tunables (gp-config ACTIVE row) — the only source of thresholds/costs.
  const config = await getActiveConfig(process.env.CONFIG_TABLE);

  // 2) Market regime. A stale SPY feed means we cannot trust the regime gate, so
  //    we score nothing rather than risk scoring on bad context.
  const regime = await getMarketRegime();
  if (!regime) {
    // `gp_scan_failed` is the ops keyword wired to the CloudWatch alarm (Phase 6).
    console.error("gp_scan_failed: SPY regime data stale/unavailable; aborting scan");
    return { ok: false, reason: "regime_data_stale", strategyVersion: STRATEGY_VERSION };
  }

  // 3) Universe.
  const watchlist = await loadEnabledWatchlist(process.env.WATCHLIST_TABLE);

  // 4) Score + persist each name. Per-ticker failures must not abort the scan.
  const store = createStore();
  const tally = { BUY_CANDIDATE: 0, NO_SIGNAL: 0, NO_DATA: 0, ERROR: 0 };
  let snapshotsWritten = 0;
  let outcomesOpened = 0;
  let writeErrors = 0;
  let alertsSent = 0;
  let alertErrors = 0;
  const candidates = [];

  for (const entry of watchlist) {
    try {
      const md = await getMarketData(entry.ticker);

      const marketContext = {
        spyBelow200ma: regime.spyBelow200ma,
        // PHASE 5: real count of open outcomes in this sector. 0 until then.
        correlatedPositions: 0,
        // PHASE (later): real news classification. Clean tape until then.
        newsLevel: "none",
        sector: entry.sector,
      };

      const result = score(md, config, marketContext);
      tally[result.decision] = (tally[result.decision] ?? 0) + 1;

      // Persist: one daily snapshot per scored name; open an outcome row for each
      // BUY_CANDIDATE (idempotent). A write failure for one name is logged and
      // skipped — it must not sink the scan. Still NO alerts (that's Phase 6).
      try {
        await store.writeSnapshot(result, { asOf: regime.asOf, sector: entry.sector });
        snapshotsWritten += 1;
        if (result.decision === DECISION.BUY_CANDIDATE) {
          const opened = await store.openOutcome(result, { sector: entry.sector });
          if (opened.opened) outcomesOpened += 1;
        }
      } catch (werr) {
        writeErrors += 1;
        console.error(`gp_scan_failed: persist ${entry.ticker}: ${werr.message}`);
      }

      if (result.decision === DECISION.BUY_CANDIDATE) {
        candidates.push({ ticker: entry.ticker, score: result.score, rr: result.riskReward });

        // OBSERVE-mode Telegram alert. Numbers are built deterministically from
        // the result; the LLM only adds a flavor sentence (and on failure we use
        // a fixed fallback, so the alert still sends). alertMode comes from config
        // (observe by default) — going live is a human act, never set here.
        try {
          const payload = buildPayload(result, md, config.alertMode);
          let flavor;
          try {
            flavor = await narrate(payload);
          } catch (nerr) {
            flavor = FALLBACK_NARRATION;
            console.error(`gp_scan_failed: narrate ${entry.ticker}: ${nerr.message}`);
          }
          await sendTelegram(composeMessage(payload, flavor));
          alertsSent += 1;
        } catch (aerr) {
          alertErrors += 1;
          console.error(`gp_scan_failed: alert ${entry.ticker}: ${aerr.message}`);
        }
      }
    } catch (err) {
      tally.ERROR += 1;
      // Log and continue — one bad ticker should not sink the run.
      console.error(`gp_scan_failed: ${entry.ticker}: ${err.message}`);
    }
  }

  const summary = {
    ok: true,
    strategyVersion: STRATEGY_VERSION,
    startedAt,
    finishedAt: new Date().toISOString(),
    scanned: watchlist.length,
    tally,
    snapshotsWritten,
    outcomesOpened,
    writeErrors,
    alertsSent,
    alertErrors,
    candidates,
    alertMode: config.alertMode, // observe (default) / live — live is a human act
  };
  console.log("gp_scan_summary", JSON.stringify(summary));
  return summary;
}
