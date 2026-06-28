// config.mjs — reads the single live tunables row from gp-config at the start of
// every run. Tunables are NEVER hardcoded in the Lambdas (see CLAUDE.md); this is
// the only place they enter the system.
//
// NOTE: the gp-config table is created and seeded in Phase 3. This reader is
// written now but only exercised from Phase 4 onward. Phase 2 scoring takes the
// config object as an injected argument and stays a pure function.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

// The tunable keys expected on the ACTIVE row (gp-momentum-1.0.0). Listed for
// documentation/validation only — values come from DynamoDB, never from here.
// These are the frozen Strategy-v1 §8 parameters + the §1 liquidity gate + §9
// costs + operational knobs. NOTHING is hardcoded in the Lambdas (CLAUDE.md);
// this is the only place tunables enter the system.
export const TUNABLE_KEYS = [
  "alertMode", // observe | live — a human flips to live, never the agent
  // Eligibility / liquidity gate (§1)
  "minPrice", // min share price to be tradeable
  "minDollarVol", // min 20-day avg dollar volume
  // Trend / regime MAs (§2, §3)
  "regimeMa", // SPY regime SMA period (200)
  "trendMa", // per-stock uptrend SMA period (100)
  // Momentum score + candidate filters (§3)
  "momentumLookback", // exp-regression window in trading days (90)
  "gapFilterPct", // exclude names with a single-day gap >= this % ...
  "gapFilterWindow", // ... within this many trailing days
  "entryRankPct", // buy from the top this % of the ranking (20)
  "exitRankPct", // rank exit below the top this % — hysteresis vs entry (30)
  // Sizing + exits (§4, §5)
  "atrPeriod", // ATR window for sizing/stops (20)
  "kStop", // ATR stop multiple (2.5)
  "riskPctPerTrade", // % of account risked per position (0.75)
  "targetPositions", // portfolio target slot count (15)
  "maxPositions", // hard cap on slots (20)
  "positionCapPct", // max % of account in any one position (15)
  // Risk governor circuit breakers (§6)
  "weeklyDdLimit", // weekly drawdown % that halts new buys (8)
  "monthlyDdLimit", // monthly drawdown % that halts new entries (15)
  "maxDdLimit", // peak-to-trough % that halts all new trading (25)
  // Costs (§9) — the labeler subtracts these per side
  "feeBps", // commissions, basis points
  "slippageBps", // slippage, basis points (~0.1%/side)
  // Operational
  "timeoutTradingDays", // labeler backstop: max trading days held before TIMEOUT
  "accountSize", // sizing base (notional account value)
];

// Pure: which TUNABLE_KEYS are absent from `item`. A null/undefined row counts as
// fully missing. Used by getActiveConfig (a run must never proceed on partial
// tunables) and unit-tested directly. Presence only — range/type validation is
// tracked separately (issue #52).
export function missingTunables(item) {
  if (!item) return [...TUNABLE_KEYS];
  return TUNABLE_KEYS.filter((k) => item[k] === undefined);
}

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
  const missing = missingTunables(item);
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
