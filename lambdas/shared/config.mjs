// config.mjs — reads the single live tunables row from gp-config at the start of
// every run. Tunables are NEVER hardcoded in the Lambdas (see CLAUDE.md); this is
// the only place they enter the system.
//
// NOTE: the gp-config table is created and seeded in Phase 3. This reader is
// written now but only exercised from Phase 4 onward. Phase 2 scoring takes the
// config object as an injected argument and stays a pure function.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

// The tunable keys expected on the ACTIVE row. Listed for documentation/validation
// only — values come from DynamoDB, never from here.
export const TUNABLE_KEYS = [
  "buyScoreThreshold",
  "atrStopMultiple",
  "minRiskReward",
  "maxCorrelatedPositions",
  "alertMode",
  "feeBps",
  "slippageBps",
  "timeoutTradingDays", // labeler: max trading days to hold before TIMEOUT
];

let _doc;
function docClient() {
  if (!_doc) {
    _doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }
  return _doc;
}

// Reads pk="CONFIG", sk="ACTIVE". Throws if the row is missing or incomplete —
// a run must never proceed on partial tunables.
export async function getActiveConfig(tableName = process.env.CONFIG_TABLE || "gp-config") {
  const out = await docClient().send(
    new GetCommand({ TableName: tableName, Key: { pk: "CONFIG", sk: "ACTIVE" } })
  );
  const item = out?.Item;
  if (!item) throw new Error(`gp-config ACTIVE row not found in ${tableName}`);
  const missing = TUNABLE_KEYS.filter((k) => item[k] === undefined);
  if (missing.length) {
    throw new Error(`gp-config ACTIVE row missing tunables: ${missing.join(", ")}`);
  }
  return item;
}

// Set alertMode on the ACTIVE row. Only 'observe' | 'live' are valid.
// IMPORTANT: this is invoked by the control Lambda in response to a HUMAN
// Telegram `/mode` command — that is the only sanctioned way to set 'live'. The
// agent must never call this with 'live' itself.
export async function setAlertMode(mode, opts = {}) {
  if (mode !== "observe" && mode !== "live") {
    throw new Error(`invalid alertMode: ${mode} (expected observe|live)`);
  }
  const client = opts.client ?? docClient();
  const tableName = opts.tableName ?? process.env.CONFIG_TABLE ?? "gp-config";
  await client.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { pk: "CONFIG", sk: "ACTIVE" },
      UpdateExpression: "SET alertMode = :m",
      ExpressionAttributeValues: { ":m": mode },
      ConditionExpression: "attribute_exists(pk)",
    })
  );
  return { alertMode: mode };
}
