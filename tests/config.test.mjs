import { test } from "node:test";
import assert from "node:assert/strict";
import { setAlertMode, TUNABLE_KEYS } from "../lambdas/shared/config.mjs";

function fakeClient() {
  const sent = [];
  return { sent, async send(cmd) { sent.push(cmd.input); return {}; } };
}

test("TUNABLE_KEYS includes timeoutTradingDays (Phase 5 addition)", () => {
  assert.ok(TUNABLE_KEYS.includes("timeoutTradingDays"));
});

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
