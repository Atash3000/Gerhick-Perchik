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
import { getMarketData, getCompanyProfile, KEY_PATHS } from "../shared/marketdata.mjs";
import { getFundamentals } from "../shared/fundamentals.mjs";
import { rsRaw, rsVsSpy, rsDelta, spyContext, rankPercentiles, sectorStrengthPercentiles } from "../shared/rs.mjs";
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
// Open a new outcome only for a BUY_CANDIDATE whose ticker has no OPEN outcome.
// Prevents a name that qualifies many days running from opening overlapping,
// correlated near-duplicate trades. Pure.
export function shouldOpenOutcome(decision, ticker, openTickers) {
  return decision === DECISION.BUY_CANDIDATE && !openTickers.has(ticker);
}

// Per-sector open-position counter for the correlation gate. Seeded from the
// outcomes already OPEN at scan start, then add()ed as new outcomes open WITHIN
// the same scan — so multiple same-sector candidates in one run accrue toward
// maxCorrelatedPositions instead of all reading a stale start-of-scan count
// (which let a single scan push a sector past the cap). null/undefined sector →
// "unknown". Pure.
export function createSectorCounter(openOutcomes = []) {
  const key = (sector) => sector ?? "unknown";
  const counts = {};
  for (const o of openOutcomes) {
    const k = key(o.sector);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return {
    count(sector) {
      return counts[key(sector)] ?? 0;
    },
    add(sector) {
      const k = key(sector);
      counts[k] = (counts[k] ?? 0) + 1;
    },
  };
}

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
  // A rate-limit (429) or any fetch error on SPY must NOT crash the scan — catch
  // it and return null so the caller aborts cleanly (the worst bug: an uncaught
  // 429 here killed the whole run). Tiingo retries are bounded inside getDailyBars.
  let spy;
  try {
    spy = await getMarketData(REGIME_TICKER);
  } catch (err) {
    console.error(`gp_scan_failed: SPY regime fetch failed — ${err.message}`);
    return null;
  }
  if (!spy || spy.fresh === false || typeof spy.ma200 !== "number") {
    return null;
  }
  // asOf is the canonical scan trading day, reused to key snapshots whose own
  // data may be missing (NO_DATA names).
  return {
    spyBelow200ma: spy.close < spy.ma200,
    asOf: spy.dataAsOf,
    spyReturn126d: spy.return126d ?? null,
    // Full capture-only SPY context (trend state + all return windows) stored on
    // every snapshot, and the source for the per-period rs{N}VsSpy deltas below.
    spy: spyContext(spy),
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

  // Open outcomes at scan start drive two things: the correlation gate (count by
  // sector) and de-duplication (one OPEN outcome per ticker at a time — a name
  // that qualifies many days running must NOT open a new overlapping trade each
  // day, which would flood /analyze with correlated near-duplicates).
  const openOutcomes = await store.listOpenOutcomes();
  const sectorCounter = createSectorCounter(openOutcomes); // grows as outcomes open this scan
  const openTickers = new Set(openOutcomes.map((o) => o.ticker));

  const tally = { BUY_CANDIDATE: 0, NO_SIGNAL: 0, NO_DATA: 0, ERROR: 0 };
  let snapshotsWritten = 0;
  let outcomesOpened = 0;
  let reEntriesSkipped = 0; // BUY_CANDIDATEs with a position already open
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
    g.md.rsVsSpy = rsVsSpy(g.md, regime.spyReturn126d); // back-compat alias (== rs126VsSpy)
    // Per-period relative strength vs SPY (capture-only): the name's return minus
    // SPY's over each window. Both halves already computed; this is the subtraction.
    g.md.rs21VsSpy = rsDelta(g.md.return21d, regime.spy?.return21d);
    g.md.rs63VsSpy = rsDelta(g.md.return63d, regime.spy?.return63d);
    g.md.rs126VsSpy = rsDelta(g.md.return126d, regime.spy?.return126d);
    g.md.rs252VsSpy = rsDelta(g.md.return252d, regime.spy?.return252d);
  }
  const rsRankMap = rankPercentiles(gathered.map((g) => ({ key: g.entry.ticker, value: g.md.rsRaw })));
  for (const g of gathered) g.md.rsRank = rsRankMap.get(g.entry.ticker) ?? null;

  // --- Sector strength (gp-2.0.0 score component, cross-sectional). Mean rsRaw per
  // sector, ranked across sectors; sectors with <3 names are not meaningful → null.
  const sectorPctMap = sectorStrengthPercentiles(
    gathered.map((g) => ({ sector: g.entry.sector, rsRaw: g.md.rsRaw }))
  );

  // --- Pass 2: score, persist, alert.
  for (const { entry, md, fundamentals } of gathered) {
    const marketContext = {
      spyBelow200ma: regime.spyBelow200ma,
      correlatedPositions: sectorCounter.count(entry.sector),
      // PHASE (later): real news classification (issue #1). Clean tape until then.
      newsLevel: "none",
      sector: entry.sector,
      // gp-2.0.0 gradient inputs (neutral 0 inside score() when null):
      fundamentals, // growthQuality
      sectorStrengthPct: sectorPctMap.get(entry.sector) ?? null, // sectorStrength
    };

    const result = score(md, config, marketContext);
    tally[result.decision] = (tally[result.decision] ?? 0) + 1;

    // A BUY_CANDIDATE only opens a NEW position (and alerts) when the ticker has no
    // outcome already OPEN — otherwise it's a held position, not a fresh entry.
    const newEntry = shouldOpenOutcome(result.decision, entry.ticker, openTickers);
    if (result.decision === DECISION.BUY_CANDIDATE && !newEntry) reEntriesSkipped += 1;

    // Persist: one daily snapshot per scored name (always); open an outcome only
    // for a NEW entry. A write failure for one name is logged and skipped.
    try {
      await store.writeSnapshot(result, {
        asOf: regime.asOf, sector: entry.sector, marketData: md, fundamentals,
        sectorStrengthPct: marketContext.sectorStrengthPct, spy: regime.spy,
      });
      snapshotsWritten += 1;
      if (newEntry) {
        const opened = await store.openOutcome(result, {
          sector: entry.sector,
          rs: { rsRaw: md.rsRaw, rsRank: md.rsRank, rsVsSpy: md.rsVsSpy },
        });
        if (opened.opened) {
          outcomesOpened += 1;
          openTickers.add(entry.ticker); // guard against any same-scan re-open
          sectorCounter.add(entry.sector); // same-scan correlated exposure accrues toward the cap
        }
      }
    } catch (werr) {
      writeErrors += 1;
      console.error(`gp_scan_failed: persist ${entry.ticker}: ${werr.message}`);
    }

    // Alert only on a NEW entry — no daily re-alert for a position already held.
    if (newEntry) {
      candidates.push({ ticker: entry.ticker, score: result.score, rr: result.riskReward });

      // Lazily fetch the company profile (name + market cap) ONLY now — for a name
      // that's actually alerting — so the profile Finnhub call stays off the
      // per-ticker scan hot path (Step 2). Cosmetic: nulls if it fails.
      try {
        const prof = await getCompanyProfile(entry.ticker);
        md.name = prof.name;
        md.marketCapMillions = prof.marketCapMillions;
      } catch {
        /* alert proceeds without name/market cap */
      }

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
        await sendTelegram(
          composeRichMessage(result, md, config, config.alertMode, flavor, {
            fundamentals,
            sectorStrengthPct: marketContext.sectorStrengthPct,
          })
        );
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
    reEntriesSkipped,
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
