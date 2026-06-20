// Manual format preview ONLY (not deployed). Sends a sample signal through the
// REAL production composer (composeRichMessage) so the preview matches live.
//   node scripts/send-styled-sample.mjs

import { STRATEGY_VERSION } from "../lambdas/shared/version.mjs";
import { buildPayload, narrate, composeRichMessage, FALLBACK_NARRATION } from "../lambdas/shared/narration.mjs";
import { sendTelegram } from "../lambdas/shared/telegram.mjs";

// Mock scoring result (numbers as the scorer would derive them).
const result = {
  ticker: "NVDA",
  decision: "BUY_CANDIDATE",
  score: 81,
  entry: 178.4,
  stop: 171.2,
  target: 198.0,
  riskReward: 2.72,
  dataAsOf: "2026-06-18",
  strategyVersion: STRATEGY_VERSION,
  // accountSize 10000 × 1% = $100 budget ÷ $7.20 per-share risk = 13 shares
  sizing: { shares: 13, notional: 2319.2, riskAmount: 93.6, riskPct: 1 },
};

// Mock marketData (as getMarketData would return it).
const md = {
  name: "NVIDIA CORP",
  marketCapMillions: 4_360_000,
  close: 178.4,
  pctChange: 0.9,
  low52: 86.62,
  high52: 195.95,
  ma50: 160,
  ma200: 140,
  atr: 7.2,
  rsi: 58,
  volume: 1_500_000,
  avgVolume30: 1_000_000,
  nearestSupport: { price: 171.2, touches: 3, brokenSupport: false },
  nearestResistance: { price: 198.0 },
  daysToEarnings: 39,
  sector: "Technology",
};

const config = { minRiskReward: 2.0 };

let thesis;
try {
  thesis = await narrate(buildPayload(result, md, "observe"));
} catch {
  thesis = FALLBACK_NARRATION;
}

const msg = composeRichMessage(result, md, config, "observe", thesis);
console.log(msg);
const res = await sendTelegram(msg);
console.log("\nsent message_id:", res?.result?.message_id ?? JSON.stringify(res));
