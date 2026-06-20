// schedule.mjs — enable/disable the EventBridge schedule rules at runtime
// (Phase 7 control Lambda). This is the "/start" / "/stop" mechanism: runtime
// on/off via Telegram, not by redeploying. A redeploy resets the rules to the
// ScheduleEnabled template baseline (off), so /start must be re-issued after a
// deploy until the baseline is flipped on.

import {
  EventBridgeClient,
  EnableRuleCommand,
  DisableRuleCommand,
} from "@aws-sdk/client-eventbridge";

// Both pipeline rules toggle together — "/start" / "/stop" mean the whole bot.
export const SCHEDULE_RULES = ["gp-scanner-schedule", "gp-labeler-schedule"];

let _client;
function client() {
  if (!_client) _client = new EventBridgeClient({});
  return _client;
}

// Enable or disable the given rules. Injectable client for tests.
export async function setScheduleEnabled(enabled, opts = {}) {
  const c = opts.client ?? client();
  const rules = opts.rules ?? SCHEDULE_RULES;
  for (const Name of rules) {
    await c.send(enabled ? new EnableRuleCommand({ Name }) : new DisableRuleCommand({ Name }));
  }
  return { enabled, rules };
}
