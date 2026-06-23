// handler.mjs — gp-funnel-report. READ-ONLY observability. Once per trading day it
// scans gp-snapshots + gp-outcomes, reads gp-config, builds the funnel report (pure
// report.mjs), and posts it to the existing Telegram channel. It writes nothing to
// any trading table and owns no writable resource (IAM is read-only on three tables
// + ssm:GetParameter on the two Telegram params + CloudWatch Logs).
//
// It NEVER changes config, opens/closes outcomes, invokes the scanner, or emits a
// buy/sell recommendation — it reports what the scanner already produced.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { buildFunnelReport } from "./report.mjs";
import { sendTelegram } from "../shared/telegram.mjs";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const SNAPSHOTS_TABLE = process.env.SNAPSHOTS_TABLE || "gp-snapshots";
const OUTCOMES_TABLE = process.env.OUTCOMES_TABLE || "gp-outcomes";
const CONFIG_TABLE = process.env.CONFIG_TABLE || "gp-config";

// Paginated full read of a small table (read-only).
async function scanAll(tableName) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const out = await doc.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey }));
    if (out.Items) items.push(...out.Items);
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

export async function handler() {
  const [snapshots, outcomes, configOut] = await Promise.all([
    scanAll(SNAPSHOTS_TABLE),
    scanAll(OUTCOMES_TABLE),
    doc.send(new GetCommand({ TableName: CONFIG_TABLE, Key: { pk: "CONFIG", sk: "ACTIVE" } })),
  ]);
  const config = configOut?.Item ?? {};

  const report = buildFunnelReport({ snapshots, outcomes, config, nowMs: Date.now() });

  // Structured log for CloudWatch (the only thing this Lambda "writes").
  console.log(
    JSON.stringify({
      msg: "gp_funnel_report",
      dataAsOf: report.dataAsOf,
      isFreshScan: report.isFreshScan,
      counts: report.counts,
    })
  );

  await sendTelegram(report.text);

  return { dataAsOf: report.dataAsOf, isFreshScan: report.isFreshScan };
}
