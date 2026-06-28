// store.mjs — DynamoDB persistence for the scanner (Phase 4) and, later, the
// labeler (Phase 5). Keeps all table-shape knowledge in one place so the handler
// stays orchestration-only and the writes are unit-testable.
//
// Two writes:
//   - writeSnapshot: every scored name gets ONE daily row in gp-snapshots
//     (idempotent per trading day — a re-run overwrites the same key).
//   - openOutcome: each BUY_CANDIDATE opens ONE row in gp-outcomes, created only
//     once (conditional put) so a re-run never clobbers an already-open or
//     already-labeled outcome.
//
// Every row carries strategyVersion and the data's as-of date. Keys are unique
// per record (see CLAUDE.md: never write two different records under one key).

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { STRATEGY_VERSION } from "./version.mjs";

// Whole days since the Unix epoch for a YYYY-MM-DD date (UTC). Used as the
// gp-snapshots sort key → one snapshot per ticker per trading day.
export function epochDay(dateStr) {
  return Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / 86_400_000);
}

// Epoch milliseconds for midnight UTC of a YYYY-MM-DD date. gp-outcomes sort key.
export function epochMs(dateStr) {
  return Date.parse(`${dateStr}T00:00:00Z`);
}

// Extract the raw market-data inputs worth keeping on a snapshot for later
// tuning/backtest analysis. Tolerates a partial/NO_DATA marketData object.
export function snapshotMetrics(md) {
  const m = md ?? {};
  // marketData now carries full-precision decision fields; round here, at the
  // persistence boundary, so stored snapshots stay clean (display-only rounding).
  const r2 = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : v ?? null);
  // Serialize a support/resistance level for storage: price (2dp) + the full Gerchik
  // structure (touches, strength, brokenSupport). Missing sub-fields → null (never
  // undefined, which DynamoDB rejects). No level → null.
  const r4 = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);
  const level = (lv) =>
    lv && typeof lv.price === "number"
      ? {
          price: r2(lv.price),
          touches: typeof lv.touches === "number" ? lv.touches : null,
          strength: r4(lv.strength),
          brokenSupport: typeof lv.brokenSupport === "boolean" ? lv.brokenSupport : null,
        }
      : null;
  const volumeRatio =
    typeof m.volume === "number" && m.avgVolume30 > 0
      ? Math.round((m.volume / m.avgVolume30) * 100) / 100
      : null;
  // Derived v2 signals (captured for Phase 8 analysis; NOT yet scored). Booleans
  // are null when an input MA/level is unavailable (insufficient history).
  const minerviniAligned =
    typeof m.ma50 === "number" && typeof m.ma150 === "number" && typeof m.ma200 === "number"
      ? m.ma50 > m.ma150 && m.ma150 > m.ma200
      : null;
  const ma200Rising = typeof m.ma200SlopePct === "number" ? m.ma200SlopePct > 0 : null;
  const breakout20 =
    typeof m.high20d === "number" && typeof m.close === "number" ? m.close > m.high20d : null;
  const breakout55 =
    typeof m.high55d === "number" && typeof m.close === "number" ? m.close > m.high55d : null;

  // Level distances in ATR units (capture-only, Phase 8 analysis). Positive =
  // support below / resistance above price. null when the level or a valid ATR is
  // absent (e.g. resistance is null for an all-time-high breakout — itself a signal).
  const r3 = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
  const atrPos = typeof m.atr === "number" && m.atr > 0;
  const distanceToSupportAtr =
    atrPos && typeof m.close === "number" && typeof m.nearestSupport?.price === "number"
      ? r3((m.close - m.nearestSupport.price) / m.atr)
      : null;
  const distanceToResistanceAtr =
    atrPos && typeof m.close === "number" && typeof m.nearestResistance?.price === "number"
      ? r3((m.nearestResistance.price - m.close) / m.atr)
      : null;

  return {
    rsi: r2(m.rsi),
    ma50: r2(m.ma50),
    ma150: r2(m.ma150),
    ma200: r2(m.ma200),
    ma200SlopePct: m.ma200SlopePct ?? null,
    atr: r2(m.atr),
    volume: m.volume ?? null,
    avgVolume30: m.avgVolume30 ?? null,
    volumeRatio,
    high20d: m.high20d ?? null,
    high55d: m.high55d ?? null,
    // Raw relative-strength inputs (RS rank computed later, cross-sectionally):
    return21d: m.return21d ?? null,
    return63d: m.return63d ?? null,
    return126d: m.return126d ?? null,
    return252d: m.return252d ?? null,
    // Relative strength (capture-only, cross-sectional; not scored):
    rsRaw: m.rsRaw ?? null,
    rsRank: m.rsRank ?? null,
    rsVsSpy: m.rsVsSpy ?? null, // back-compat alias for rs126VsSpy
    // Per-period relative strength vs SPY (capture-only; attached in scanner pass 1).
    rs21VsSpy: m.rs21VsSpy ?? null,
    rs63VsSpy: m.rs63VsSpy ?? null,
    rs126VsSpy: m.rs126VsSpy ?? null,
    rs252VsSpy: m.rs252VsSpy ?? null,
    // Store the FULL level, not just the price — touches/strength/brokenSupport are
    // the most "Gerchik" signal (touch count especially) and are needed for both the
    // alert's Gerchik Level line and Phase 8 outcome analysis. null when no level.
    nearestSupport: level(m.nearestSupport),
    nearestResistance: level(m.nearestResistance),
    daysToEarnings: m.daysToEarnings ?? null,
    // Derived booleans for tuning analysis:
    minerviniAligned, // 50>150>200
    ma200Rising,
    breakout20, // close > prior 20-day high
    breakout55, // close > prior 55-day high
    distanceToSupportAtr, // (close − support) / ATR; null if no support/ATR
    distanceToResistanceAtr, // (resistance − close) / ATR; null if no resistance (ATH) / ATR
  };
}

// Momentum-v1 snapshot metrics. This is intentionally smaller than the legacy
// gp-2.0.0 metrics block: keep only fields used by Strategy-v1 or useful for
// momentum analysis, and drop level/breakout/fundamental DNA.
export function momentumSnapshotMetrics(md) {
  const m = md ?? {};
  const round2 = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
  const volumeRatio =
    typeof m.volume === "number" && m.avgVolume30 > 0
      ? Math.round((m.volume / m.avgVolume30) * 100) / 100
      : null;

  return {
    close: round2(m.close),
    ma50: round2(m.ma50),
    ma100: round2(m.ma100),
    ma200: round2(m.ma200),
    atr: round2(m.atr),
    avgVolume30: typeof m.avgVolume30 === "number" && Number.isFinite(m.avgVolume30) ? m.avgVolume30 : null,
    volumeRatio,
    return63d: typeof m.return63d === "number" && Number.isFinite(m.return63d) ? m.return63d : null,
    return126d: typeof m.return126d === "number" && Number.isFinite(m.return126d) ? m.return126d : null,
    return252d: typeof m.return252d === "number" && Number.isFinite(m.return252d) ? m.return252d : null,
  };
}

function nullableNumber(v, dp = null) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (dp == null) return v;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

function nullableBool(v) {
  return typeof v === "boolean" ? v : null;
}

function momentumChecks(checks) {
  return {
    price: nullableBool(checks?.price),
    dollarVol: nullableBool(checks?.dollarVol),
    trend: nullableBool(checks?.trend),
    noBigMove: nullableBool(checks?.noBigMove),
  };
}

// Persist one canonical momentum-v1 exit vocabulary. evaluateExits() emits compact
// internal constants; snapshots/outcomes store the schema's snake_case values.
export function normalizeMomentumExitReason(reason) {
  if (reason == null) return null;
  const map = {
    HARD_STOP: "hard_stop",
    hard_stop: "hard_stop",
    TRAIL: "trailing_stop",
    trailing_stop: "trailing_stop",
    TREND: "trend_exit",
    trend_exit: "trend_exit",
    RANK: "rank_exit",
    rank_exit: "rank_exit",
  };
  return map[reason] ?? null;
}

// Build a store bound to a DynamoDB document client + table names. Pass a fake
// client in tests; in the Lambda, defaults read the env + a real client.
export function createStore({ client, snapshotsTable, outcomesTable, watchlistTable, positionsTable } = {}) {
  const doc = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const snapTable = snapshotsTable ?? process.env.SNAPSHOTS_TABLE;
  const outTable = outcomesTable ?? process.env.OUTCOMES_TABLE;
  const watchTable = watchlistTable ?? process.env.WATCHLIST_TABLE;
  const posTable = positionsTable ?? process.env.POSITIONS_TABLE;

  return {
    // One daily snapshot per scored name. `asOf` (YYYY-MM-DD) is the trading day
    // the row is keyed to — the data's dataAsOf, with a caller-supplied fallback
    // for the NO_DATA case where the result has none.
    async writeSnapshot(result, { asOf, sector = null, marketData = null, fundamentals = null, sectorStrengthPct = null, spy = null } = {}) {
      const day = result.dataAsOf ?? asOf;
      if (!day) throw new Error(`cannot snapshot ${result.ticker}: no as-of date`);
      // Per-share risk/reward in price terms (capture-only denormalization; R:R is
      // their ratio). null when levels weren't derived (a gate rejected pre-levels).
      const round2 = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
      const riskPerShare =
        typeof result.entry === "number" && typeof result.stop === "number"
          ? round2(result.entry - result.stop)
          : null;
      const rewardPerShare =
        typeof result.entry === "number" && typeof result.target === "number"
          ? round2(result.target - result.entry)
          : null;
      const item = {
        pk: `TICKER#${result.ticker}`,
        sk: epochDay(day),
        ticker: result.ticker,
        dataAsOf: result.dataAsOf ?? day,
        strategyVersion: result.strategyVersion ?? STRATEGY_VERSION,
        decision: result.decision,
        reason: result.reason ?? null,
        score: result.score ?? null,
        breakdown: result.breakdown ?? null,
        entry: result.entry ?? null,
        stop: result.stop ?? null,
        target: result.target ?? null,
        riskReward: result.riskReward ?? null,
        riskPerShare, // entry − stop (price); null if no levels
        rewardPerShare, // target − entry (price); null if no levels
        // gp-2.0.0 sectorStrength INPUT (the raw cross-sectional percentile, not the
        // scored component). Captured for Phase 8 analysis; null when sector < 3 names.
        sectorStrengthPct: typeof sectorStrengthPct === "number" ? sectorStrengthPct : null,
        // Target-derivation metadata (ATR-projected floor) for target-type analysis.
        targetType: result.targetType ?? null,
        projectedTarget: result.projectedTarget ?? null,
        resistanceTarget: result.resistanceTarget ?? null,
        targetAtrMultiple: result.targetAtrMultiple ?? null,
        gates: result.gates ?? null,
        // Raw inputs for Phase 8 analysis (recorded for EVERY decision, so we can
        // study what predicts outcomes even for gate-rejected names).
        metrics: snapshotMetrics(marketData),
        // Capture-only O'Neil fundamentals (not scored). null when unavailable.
        fundamentals: fundamentals ?? null,
        // Capture-only market context: SPY trend state + returns the day this name
        // was scored (same for every snapshot that day). Powers "is it stronger than
        // the market?" and regime-conditioned outcome analysis in Phase 8.
        spy: spy ?? null,
        sector,
        scannedAt: new Date().toISOString(),
      };
      await doc.send(new PutCommand({ TableName: snapTable, Item: item }));
      return { table: snapTable, pk: item.pk, sk: item.sk };
    },

    // Momentum-v1 snapshot shape. Same table/keys as legacy snapshots, but the item
    // body follows docs/Snapshot-Schema-momentum.md and drops gp-2.0.0 score/target
    // fields. Step 4b will switch the scanner to this writer.
    async writeMomentumSnapshot(result, { asOf, sector = null, marketData = null, spy = null } = {}) {
      const day = result.dataAsOf ?? asOf;
      if (!day) throw new Error(`cannot snapshot ${result.ticker}: no as-of date`);
      const item = {
        pk: `TICKER#${result.ticker}`,
        sk: epochDay(day),
        ticker: result.ticker,
        dataAsOf: result.dataAsOf ?? day,
        strategyVersion: result.strategyVersion ?? STRATEGY_VERSION,
        scannedAt: new Date().toISOString(),

        decision: result.decision,
        reason: result.reason ?? null,
        momentum: nullableNumber(result.momentum),
        slope: nullableNumber(result.slope),
        r2: nullableNumber(result.r2),
        rank: nullableNumber(result.rank),
        rankPct: nullableNumber(result.rankPct),
        inEntryZone: nullableBool(result.inEntryZone),
        inExitZone: nullableBool(result.inExitZone),

        eligible: result.eligible === true,
        checks: momentumChecks(result.checks),
        insufficientHistory: result.insufficientHistory === true,

        regimeOn: nullableBool(result.regimeOn),
        spy: spy ?? null,
        sector,
        metrics: momentumSnapshotMetrics(marketData),

        entry: nullableNumber(result.entry, 2),
        stop: nullableNumber(result.stop, 2),
        peakClose: nullableNumber(result.peakClose, 2),
        shares: nullableNumber(result.shares),
        exitReason: normalizeMomentumExitReason(result.exitReason),
      };
      await doc.send(new PutCommand({ TableName: snapTable, Item: item }));
      return { table: snapTable, pk: item.pk, sk: item.sk };
    },

    // Open an outcome row for a BUY_CANDIDATE. Created once only: the conditional
    // put fails (silently, here) if the signal already exists, so re-running the
    // scan can't reset or overwrite a labeled outcome.
    async openOutcome(result, { sector = null, rs = null } = {}) {
      const entryDate = result.dataAsOf;
      if (!entryDate) throw new Error(`cannot open outcome ${result.ticker}: no entry date`);
      const item = {
        pk: `SIGNAL#${result.ticker}#${entryDate}`,
        sk: epochMs(entryDate),
        ticker: result.ticker,
        sector,
        entryDate,
        status: "OPEN",
        strategyVersion: result.strategyVersion ?? STRATEGY_VERSION,
        score: result.score ?? null,
        breakdown: result.breakdown ?? null,
        entry: result.entry,
        stop: result.stop,
        target: result.target,
        riskReward: result.riskReward,
        // Target-derivation metadata at entry — lets closed-outcome analysis segment
        // by how the target was set (RESISTANCE | PROJECTED_ATR | *_FLOORED_*).
        targetType: result.targetType ?? null,
        projectedTarget: result.projectedTarget ?? null,
        resistanceTarget: result.resistanceTarget ?? null,
        targetAtrMultiple: result.targetAtrMultiple ?? null,
        // Relative strength at entry (capture-only, for /analyze by-RS-rank later):
        rsRaw: rs?.rsRaw ?? null,
        rsRank: rs?.rsRank ?? null,
        rsVsSpy: rs?.rsVsSpy ?? null,
        openedAt: new Date().toISOString(),
      };
      try {
        await doc.send(
          new PutCommand({
            TableName: outTable,
            Item: item,
            ConditionExpression: "attribute_not_exists(pk)",
          })
        );
        return { opened: true, pk: item.pk, sk: item.sk };
      } catch (err) {
        if (err?.name === "ConditionalCheckFailedException") {
          return { opened: false, reason: "already open", pk: item.pk };
        }
        throw err;
      }
    },

    // Momentum-v1 entry outcome. Same idempotent conditional put as openOutcome(),
    // but stores the momentum entry snapshot instead of gp-2.0.0 score/target data.
    async openMomentumOutcome(result, { sector = null } = {}) {
      const entryDate = result.dataAsOf;
      if (!entryDate) throw new Error(`cannot open outcome ${result.ticker}: no entry date`);
      const item = {
        pk: `SIGNAL#${result.ticker}#${entryDate}`,
        sk: epochMs(entryDate),
        ticker: result.ticker,
        sector,
        entryDate,
        status: "OPEN",
        strategyVersion: result.strategyVersion ?? STRATEGY_VERSION,
        entry: nullableNumber(result.entry),
        stop: nullableNumber(result.stop),
        momentum: nullableNumber(result.momentum),
        slope: nullableNumber(result.slope),
        r2: nullableNumber(result.r2),
        rank: nullableNumber(result.rank),
        rankPct: nullableNumber(result.rankPct),
        shares: nullableNumber(result.shares),
        exitReason: normalizeMomentumExitReason(result.exitReason),
        openedAt: new Date().toISOString(),
      };
      try {
        await doc.send(
          new PutCommand({
            TableName: outTable,
            Item: item,
            ConditionExpression: "attribute_not_exists(pk)",
          })
        );
        return { opened: true, pk: item.pk, sk: item.sk };
      } catch (err) {
        if (err?.name === "ConditionalCheckFailedException") {
          return { opened: false, reason: "already open", pk: item.pk };
        }
        throw err;
      }
    },

    // All OPEN outcome rows (the labeler's work queue). Small table → paginated
    // scan with a status filter.
    async listOpenOutcomes() {
      const items = [];
      let ExclusiveStartKey;
      do {
        const out = await doc.send(
          new ScanCommand({
            TableName: outTable,
            FilterExpression: "#s = :open",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":open": "OPEN" },
            ExclusiveStartKey,
          })
        );
        items.push(...(out.Items ?? []));
        ExclusiveStartKey = out.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return items;
    },

    // Close an outcome with its label fields. Guarded by status = OPEN so a
    // double-run (or a race) can't relabel an already-closed signal.
    async closeOutcome(pk, sk, fields) {
      const sets = ["#s = :closed", "labeledAt = :labeledAt"];
      const names = { "#s": "status" };
      const values = { ":closed": "CLOSED", ":labeledAt": new Date().toISOString(), ":open": "OPEN" };
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`#${k} = :${k}`);
        names[`#${k}`] = k;
        values[`:${k}`] = v;
      }
      try {
        await doc.send(
          new UpdateCommand({
            TableName: outTable,
            Key: { pk, sk },
            UpdateExpression: "SET " + sets.join(", "),
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ConditionExpression: "#s = :open",
          })
        );
        return { closed: true };
      } catch (err) {
        if (err?.name === "ConditionalCheckFailedException") {
          return { closed: false, reason: "not open" };
        }
        throw err;
      }
    },

    // Refresh the trailing stop + peak on an OPEN outcome — the scanner's weekly
    // exit maintenance (the split exit-ownership model: the scanner keeps the
    // trailing stop current; the unchanged labeler first-touches it daily). Guarded
    // by status = OPEN, so it can NEVER mutate a CLOSED/labeled outcome (the
    // open-once integrity guard, extended to updates). Only finite values are
    // written (no NaN/undefined into the row). Returns { updated } / { updated:false,
    // reason:"not open" } when the row isn't open.
    //
    // NOTE: this makes the trail WEEKLY-granular (frozen between runs) — a
    // deliberate, conservative under-trail. Step 5's backtester MUST model exits the
    // same way, or live observe and the backtest would measure differently.
    async updateOpenPosition(pk, sk, fields = {}) {
      const sets = ["reviewedAt = :reviewedAt"];
      const names = { "#s": "status" };
      const values = { ":reviewedAt": new Date().toISOString(), ":open": "OPEN" };
      for (const k of ["stop", "peakClose"]) {
        const v = fields[k];
        if (typeof v === "number" && Number.isFinite(v)) {
          sets.push(`#${k} = :${k}`);
          names[`#${k}`] = k;
          values[`:${k}`] = v;
        }
      }
      try {
        await doc.send(
          new UpdateCommand({
            TableName: outTable,
            Key: { pk, sk },
            UpdateExpression: "SET " + sets.join(", "),
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ConditionExpression: "#s = :open",
          })
        );
        return { updated: true };
      } catch (err) {
        if (err?.name === "ConditionalCheckFailedException") {
          return { updated: false, reason: "not open" };
        }
        throw err;
      }
    },

    // Flip `enabled` on a gp-watchlist row (control: /enable, /disable). Guarded
    // so we don't create a row for a ticker that isn't on the watchlist.
    async setWatchlistEnabled(ticker, enabled) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: watchTable,
            Key: { pk: `TICKER#${ticker}` },
            UpdateExpression: "SET #en = :e",
            ExpressionAttributeNames: { "#en": "enabled" },
            ExpressionAttributeValues: { ":e": enabled },
            ConditionExpression: "attribute_exists(pk)",
          })
        );
        return { ok: true, ticker, enabled };
      } catch (err) {
        if (err?.name === "ConditionalCheckFailedException") {
          return { ok: false, reason: "not on watchlist", ticker };
        }
        throw err;
      }
    },

    // Create or overwrite (upsert) a gp-watchlist row. For a future auto-refresh
    // universe Lambda — the static seed uses scripts/seed.mjs. Idempotent (Put
    // overwrites the same pk). setWatchlistEnabled can only flip an EXISTING row;
    // this is how a new ticker first enters the universe.
    async putWatchlistRow({ ticker, sector = null, enabled = true, qualityTier = null }) {
      if (!ticker) throw new Error("putWatchlistRow: ticker required");
      await doc.send(
        new PutCommand({
          TableName: watchTable,
          Item: { pk: `TICKER#${ticker}`, ticker, sector, enabled, qualityTier },
        })
      );
      return { ok: true, ticker };
    },

    // All outcome rows with a given status (paginated scan). Used by /stats.
    async listOutcomesByStatus(status) {
      const items = [];
      let ExclusiveStartKey;
      do {
        const out = await doc.send(
          new ScanCommand({
            TableName: outTable,
            FilterExpression: "#s = :st",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":st": status },
            ExclusiveStartKey,
          })
        );
        items.push(...(out.Items ?? []));
        ExclusiveStartKey = out.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return items;
    },

    // Latest OPEN research outcome for a ticker (used to link a manual /bought
    // position — or a /skip decision — to its source signal). Small table →
    // prefix+status scan; picks the highest sk.
    // TODO(#46): replace the scan with a TICKER#/STATUS# GSI Query if outcomes grow.
    async findLatestOpenOutcome(ticker) {
      const prefix = `SIGNAL#${ticker}#`;
      let best = null;
      let ExclusiveStartKey;
      do {
        const out = await doc.send(
          new ScanCommand({
            TableName: outTable,
            FilterExpression: "begins_with(pk, :p) AND #s = :open",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":p": prefix, ":open": "OPEN" },
            ExclusiveStartKey,
          })
        );
        for (const it of out.Items ?? []) {
          if (!best || it.sk > best.sk) best = it;
        }
        ExclusiveStartKey = out.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      if (!best) return null;
      return {
        pk: best.pk,
        sk: best.sk,
        strategyVersion: best.strategyVersion ?? null,
        stop: best.stop ?? null,
        entryDate: best.entryDate ?? null,
      };
    },

    // The single OPEN position header for a ticker (v1: at most one). null if none.
    async getOpenPosition(ticker) {
      // v1: at most one OPEN header per ticker and few events per pk, so a single
      // Query page suffices; revisit pagination if a ticker's POSITION# pk grows large.
      const out = await doc.send(
        new QueryCommand({
          TableName: posTable,
          KeyConditionExpression: "pk = :pk",
          FilterExpression: "recordType = :h AND #s = :open",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":pk": `POSITION#${ticker}`,
            ":h": "POSITION_HEADER",
            ":open": "OPEN",
          },
        })
      );
      return (out.Items ?? [])[0] ?? null;
    },

    // Create a position: header (conditional on key absence) + its first buy
    // event, atomically. The "one open per ticker" rule is enforced by the
    // caller (getOpenPosition check) before this runs.
    async createPosition(header, buyEvent) {
      await doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: posTable,
                Item: header,
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            { Put: { TableName: posTable, Item: buyEvent } },
          ],
        })
      );
      return { created: true, pk: header.pk, sk: header.sk };
    },

    // Record a sell: update the header (optimistic lock on remainingShares to
    // block a double-decrement) + put the SELL_EVENT, atomically. sellResult is
    // the object returned by positions.applySell.
    async recordSell(header, sellResult) {
      const { event, updatedFields } = sellResult;
      const sets = [];
      const names = {};
      const values = {};
      for (const [k, v] of Object.entries(updatedFields)) {
        sets.push(`#${k} = :${k}`);
        names[`#${k}`] = k;
        values[`:${k}`] = v;
      }
      // Seed the optimistic-lock sentinel AFTER the loop so an updatedFields key
      // named "expected" can never clobber it.
      values[":expected"] = header.remainingShares;
      await doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: posTable,
                Key: { pk: header.pk, sk: header.sk },
                UpdateExpression: "SET " + sets.join(", "),
                ExpressionAttributeNames: names,
                ExpressionAttributeValues: values,
                ConditionExpression: "remainingShares = :expected",
              },
            },
            { Put: { TableName: posTable, Item: event } },
          ],
        })
      );
      return { recorded: true };
    },

    // Record a /skip decision row.
    async recordDecision(decision) {
      await doc.send(new PutCommand({ TableName: posTable, Item: decision }));
      return { recorded: true };
    },

    // All OPEN position headers (for /positions). Small table → paginated scan.
    async listOpenPositions() {
      const items = [];
      let ExclusiveStartKey;
      do {
        const out = await doc.send(
          new ScanCommand({
            TableName: posTable,
            FilterExpression: "recordType = :h AND #s = :open",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":h": "POSITION_HEADER", ":open": "OPEN" },
            ExclusiveStartKey,
          })
        );
        items.push(...(out.Items ?? []));
        ExclusiveStartKey = out.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return items;
    },

    // Idempotency guard for mutating Telegram commands. Conditionally write a
    // MUTATION#<update_id> marker; a retried delivery fails the condition and is
    // dropped before any share math. ttlEpochSec auto-expires the marker.
    async claimUpdateId(updateId, ttlEpochSec) {
      try {
        await doc.send(
          new PutCommand({
            TableName: posTable,
            Item: {
              pk: `MUTATION#${updateId}`,
              sk: "claim",
              ttl: ttlEpochSec,
              claimedAt: new Date().toISOString(),
            },
            ConditionExpression: "attribute_not_exists(pk)",
          })
        );
        return { claimed: true };
      } catch (err) {
        if (err?.name === "ConditionalCheckFailedException") return { claimed: false };
        throw err;
      }
    },
  };
}
