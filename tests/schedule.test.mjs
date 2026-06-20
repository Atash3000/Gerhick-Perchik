import { test } from "node:test";
import assert from "node:assert/strict";
import { setScheduleEnabled, SCHEDULE_RULES } from "../lambdas/shared/schedule.mjs";

function fakeClient() {
  const sent = [];
  return { sent, async send(cmd) { sent.push({ name: cmd.constructor.name, input: cmd.input }); return {}; } };
}

test("setScheduleEnabled(true) sends EnableRule for each rule", async () => {
  const client = fakeClient();
  const res = await setScheduleEnabled(true, { client });
  assert.equal(res.enabled, true);
  assert.equal(client.sent.length, SCHEDULE_RULES.length);
  assert.ok(client.sent.every((c) => c.name === "EnableRuleCommand"));
  assert.deepEqual(client.sent.map((c) => c.input.Name), SCHEDULE_RULES);
});

test("setScheduleEnabled(false) sends DisableRule for each rule", async () => {
  const client = fakeClient();
  await setScheduleEnabled(false, { client, rules: ["only-rule"] });
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].name, "DisableRuleCommand");
  assert.equal(client.sent[0].input.Name, "only-rule");
});
