import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setAlertMode, TUNABLE_KEYS, missingTunables } from "../lambdas/shared/config.mjs";

function fakeClient() {
  const sent = [];
  return { sent, async send(cmd) { sent.push(cmd.input); return {}; } };
}

const SEED = JSON.parse(readFileSync(new URL("../seed/config.json", import.meta.url), "utf8"));

// --- momentum tunables (gp-momentum-1.0.0) ---------------------------------

test("TUNABLE_KEYS is the momentum tunable set", () => {
  // The frozen Strategy-v1 §8 parameters + liquidity gate + costs + operational.
  const expected = [
    "alertMode",
    "minPrice", "minDollarVol",
    "regimeMa", "trendMa",
    "momentumLookback",
    "gapFilterPct", "gapFilterWindow",
    "entryRankPct", "exitRankPct",
    "atrPeriod", "kStop",
    "riskPctPerTrade",
    "targetPositions", "maxPositions",
    "positionCapPct",
    "weeklyDdLimit", "monthlyDdLimit", "maxDdLimit",
    "feeBps", "slippageBps", "timeoutTradingDays",
    "accountSize",
  ];
  assert.deepEqual([...TUNABLE_KEYS].sort(), [...expected].sort());
});

test("TUNABLE_KEYS drops the retired gp-2.0.0 gate-and-score knobs", () => {
  for (const old of ["buyScoreThreshold", "atrStopMultiple", "minRiskReward", "targetAtrMultiple", "maxCorrelatedPositions"]) {
    assert.ok(!TUNABLE_KEYS.includes(old), `TUNABLE_KEYS should not include retired key ${old}`);
  }
});

// --- missingTunables (pure validation helper) ------------------------------

test("missingTunables returns [] for a complete row", () => {
  const row = Object.fromEntries(TUNABLE_KEYS.map((k) => [k, 1]));
  assert.deepEqual(missingTunables(row), []);
});

test("missingTunables lists exactly the absent keys", () => {
  const row = Object.fromEntries(TUNABLE_KEYS.map((k) => [k, 1]));
  delete row.kStop;
  delete row.maxDdLimit;
  assert.deepEqual(missingTunables(row).sort(), ["kStop", "maxDdLimit"].sort());
});

test("missingTunables treats a null/undefined row as fully missing", () => {
  assert.deepEqual(missingTunables(null).sort(), [...TUNABLE_KEYS].sort());
  assert.deepEqual(missingTunables(undefined).sort(), [...TUNABLE_KEYS].sort());
});

// --- the seed satisfies the config contract --------------------------------

test("seed/config.json provides every tunable the reader requires", () => {
  assert.deepEqual(missingTunables(SEED), []);
});

test("seed starts in observe mode and is stamped the momentum version", () => {
  assert.equal(SEED.alertMode, "observe"); // a human flips to live, never the seed
  assert.equal(SEED.strategyVersion, "gp-momentum-1.0.0");
  assert.equal(SEED.pk, "CONFIG");
  assert.equal(SEED.sk, "ACTIVE");
});

test("seed carries the frozen Strategy-v1 §8 parameter values exactly", () => {
  assert.equal(SEED.minPrice, 5);
  assert.equal(SEED.minDollarVol, 10_000_000);
  assert.equal(SEED.regimeMa, 200);
  assert.equal(SEED.trendMa, 100);
  assert.equal(SEED.momentumLookback, 90);
  assert.equal(SEED.gapFilterPct, 15);
  assert.equal(SEED.gapFilterWindow, 90);
  assert.equal(SEED.entryRankPct, 20);
  assert.equal(SEED.exitRankPct, 30);
  assert.equal(SEED.atrPeriod, 20);
  assert.equal(SEED.kStop, 2.5);
  assert.equal(SEED.riskPctPerTrade, 0.75);
  assert.equal(SEED.targetPositions, 15);
  assert.equal(SEED.maxPositions, 20);
  assert.equal(SEED.positionCapPct, 15);
  assert.equal(SEED.weeklyDdLimit, 8);
  assert.equal(SEED.monthlyDdLimit, 15);
  assert.equal(SEED.maxDdLimit, 25);
});

// --- setAlertMode (unchanged behavior) -------------------------------------

test("setAlertMode updates the ACTIVE row with a guard", async () => {
  const client = fakeClient();
  const res = await setAlertMode("live", { client, tableName: "T-config" });
  assert.deepEqual(res, { alertMode: "live" });
  const inp = client.sent[0];
  assert.equal(inp.TableName, "T-config");
  assert.deepEqual(inp.Key, { pk: "CONFIG", sk: "ACTIVE" });
  assert.match(inp.UpdateExpression, /SET alertMode = :m/);
  assert.equal(inp.ExpressionAttributeValues[":m"], "live");
  assert.equal(inp.ConditionExpression, "attribute_exists(pk)");
});

test("setAlertMode rejects invalid modes", async () => {
  await assert.rejects(() => setAlertMode("yolo", { client: fakeClient() }), /invalid alertMode/);
});
