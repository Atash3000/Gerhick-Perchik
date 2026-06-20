// Manual test ONLY (not deployed). Sends a sample OBSERVE-mode signal to the
// dedicated Telegram channel using the exact production path:
//   buildPayload -> narrate (real Anthropic, locked prompt) -> composeMessage
//   -> sendTelegram. The numbers are deterministic; the LLM only adds one line.
//
//   node scripts/send-mock-alert.mjs

import { STRATEGY_VERSION } from "../lambdas/shared/version.mjs";
import { buildPayload, narrate, composeMessage, FALLBACK_NARRATION } from "../lambdas/shared/narration.mjs";
import { sendTelegram } from "../lambdas/shared/telegram.mjs";

// A plausible passing setup (mock — not a real scan result).
const result = {
  ticker: "NVDA",
  decision: "BUY_CANDIDATE",
  score: 81,
  entry: 178.40,
  stop: 171.20,
  target: 198.00,
  riskReward: 2.72,
  dataAsOf: "2026-06-18",
  strategyVersion: STRATEGY_VERSION,
};
const marketData = { sector: "Technology", rsi: 58 };

const payload = buildPayload(result, marketData, "observe");

let flavor;
try {
  flavor = await narrate(payload);
  console.log("narration:", flavor);
} catch (e) {
  flavor = FALLBACK_NARRATION;
  console.log("narration failed, using fallback:", e.message);
}

const message = composeMessage(payload, flavor);
console.log("\n--- message to be sent ---\n" + message + "\n--------------------------");

const res = await sendTelegram(message);
console.log("\nsent:", JSON.stringify(res?.result?.message_id ?? res));
