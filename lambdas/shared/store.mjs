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
  ScanCommand,
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

// Build a store bound to a DynamoDB document client + table names. Pass a fake
// client in tests; in the Lambda, defaults read the env + a real client.
export function createStore({ client, snapshotsTable, outcomesTable } = {}) {
  const doc = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const snapTable = snapshotsTable ?? process.env.SNAPSHOTS_TABLE;
  const outTable = outcomesTable ?? process.env.OUTCOMES_TABLE;

  return {
    // One daily snapshot per scored name. `asOf` (YYYY-MM-DD) is the trading day
    // the row is keyed to — the data's dataAsOf, with a caller-supplied fallback
    // for the NO_DATA case where the result has none.
    async writeSnapshot(result, { asOf, sector = null } = {}) {
      const day = result.dataAsOf ?? asOf;
      if (!day) throw new Error(`cannot snapshot ${result.ticker}: no as-of date`);
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
        gates: result.gates ?? null,
        sector,
        scannedAt: new Date().toISOString(),
      };
      await doc.send(new PutCommand({ TableName: snapTable, Item: item }));
      return { table: snapTable, pk: item.pk, sk: item.sk };
    },

    // Open an outcome row for a BUY_CANDIDATE. Created once only: the conditional
    // put fails (silently, here) if the signal already exists, so re-running the
    // scan can't reset or overwrite a labeled outcome.
    async openOutcome(result, { sector = null } = {}) {
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
  };
}
