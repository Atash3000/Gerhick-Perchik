import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPayload,
  buildAnthropicRequest,
  narrate,
  composeMessage,
  composeRichMessage,
  buildBullets,
  LOCKED_SYSTEM_PROMPT,
  NARRATION_MODEL,
  OBSERVE_PREFIX,
  FALLBACK_NARRATION,
} from "../lambdas/shared/narration.mjs";

const RESULT = {
  ticker: "MSFT",
  score: 81,
  entry: 100,
  stop: 97,
  target: 110,
  riskReward: 3.333,
  dataAsOf: "2026-06-18",
  strategyVersion: "gp-1.0.0",
};
const MD = { sector: "Technology", rsi: 58 };

test("buildPayload carries only the locked fields the model may see", () => {
  const p = buildPayload(RESULT, MD, "observe");
  assert.equal(p.mode, "observe");
  assert.equal(p.ticker, "MSFT");
  assert.equal(p.score, 81);
  assert.equal(p.entry, 100);
  assert.equal(p.stop, 97);
  assert.equal(p.target, 110);
  assert.equal(p.riskReward, 3.333);
  assert.equal(p.sector, "Technology");
  assert.equal(p.strategyVersion, "gp-1.0.0");
});

test("buildAnthropicRequest uses the Haiku model, the locked prompt, and embeds the payload", () => {
  const p = buildPayload(RESULT, MD, "observe");
  const { url, body } = buildAnthropicRequest(p);
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(body.model, NARRATION_MODEL);
  assert.equal(body.system, LOCKED_SYSTEM_PROMPT);
  assert.match(body.messages[0].content, /"ticker":"MSFT"/);
  assert.ok(body.max_tokens > 0);
});

test("narrate returns the model's text via injected fetch", async () => {
  const fetchFn = async () => ({
    ok: true,
    json: async () => ({ content: [{ type: "text", text: "MSFT shows a constructive uptrend." }] }),
  });
  const text = await narrate(buildPayload(RESULT, MD, "observe"), { apiKey: "K", fetchFn });
  assert.equal(text, "MSFT shows a constructive uptrend.");
});

test("narrate falls back to a fixed string when the model returns no text", async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({ content: [] }) });
  const text = await narrate(buildPayload(RESULT, MD, "observe"), { apiKey: "K", fetchFn });
  assert.equal(text, FALLBACK_NARRATION);
});

test("narrate throws on a non-OK response (caller uses fallback)", async () => {
  const fetchFn = async () => ({ ok: false, status: 500, statusText: "err" });
  await assert.rejects(
    () => narrate(buildPayload(RESULT, MD, "observe"), { apiKey: "K", fetchFn }),
    /Anthropic narration failed/
  );
});

test("composeMessage (observe): OBSERVE prefix, deterministic numbers, never says BUY", () => {
  const msg = composeMessage(buildPayload(RESULT, MD, "observe"), "constructive uptrend");
  assert.ok(msg.startsWith(OBSERVE_PREFIX));
  assert.match(msg, /MSFT — possible setup/);
  assert.match(msg, /Entry 100\.00 · Stop 97\.00 · Target 110\.00 · R:R 3\.333 · Score 81/);
  assert.match(msg, /as of 2026-06-18 · gp-1\.0\.0/);
  assert.doesNotMatch(msg, /\bBUY\b/i);
});

test("composeMessage (live): no OBSERVE prefix", () => {
  const msg = composeMessage(buildPayload(RESULT, MD, "live"), "constructive uptrend");
  assert.ok(!msg.includes(OBSERVE_PREFIX));
  assert.match(msg, /MSFT — possible setup/);
});

test("composeMessage still carries correct numbers with empty narration", () => {
  const msg = composeMessage(buildPayload(RESULT, MD, "observe"), "");
  assert.match(msg, /Entry 100\.00 · Stop 97\.00 · Target 110\.00/);
});

// --- Rich message (Phase: richer alert format) ---
const RICH_RESULT = {
  ticker: "NVDA", decision: "BUY_CANDIDATE", score: 81,
  entry: 178.40, stop: 171.20, target: 198.00, riskReward: 2.72,
  dataAsOf: "2026-06-18", strategyVersion: "gp-1.0.0",
  sizing: { shares: 13, notional: 2319.2, riskAmount: 93.6, riskPct: 1 },
};
const RICH_MD = {
  name: "NVIDIA CORP", marketCapMillions: 4_360_000,
  close: 178.40, pctChange: 0.9, low52: 86.62, high52: 195.95,
  ma50: 160, ma200: 140, atr: 7.20, rsi: 58,
  volume: 1_500_000, avgVolume30: 1_000_000,
  nearestSupport: { price: 171.20, touches: 3, brokenSupport: false },
  nearestResistance: { price: 198.00 }, daysToEarnings: 39, sector: "Technology",
};
const RICH_CFG = { minRiskReward: 2.0 };

test("buildBullets derives deterministic bullish/risk points", () => {
  const { bullish, risks } = buildBullets(RICH_RESULT, RICH_MD, RICH_CFG);
  assert.ok(bullish.some((b) => /above both 50MA and 200MA/.test(b)));
  assert.ok(bullish.some((b) => /R:R 2\.72:1/.test(b)));
  assert.ok(bullish.some((b) => /RSI 58/.test(b)));
  assert.ok(risks.some((b) => /Reward room moderate/.test(b))); // 2.72 < 2.0×1.5
  assert.ok(risks.some((b) => /ATR-based stop/.test(b)));
  assert.ok(!risks.some((b) => /Earnings in/.test(b))); // 39d > 15d
});

test("composeRichMessage renders the full styled alert, numbers deterministic, no BUY", () => {
  const msg = composeRichMessage(RICH_RESULT, RICH_MD, RICH_CFG, "observe", "Constructive setup.");
  assert.match(msg, /GERCHIK-PERCHIK SIGNAL/);
  assert.ok(msg.startsWith("🟢"));
  assert.match(msg, new RegExp(OBSERVE_PREFIX));
  assert.match(msg, /NVDA — NVIDIA CORP/);
  assert.match(msg, /Score: 81\/100/);
  assert.match(msg, /Market cap: \$4\.36T/);
  assert.match(msg, /52w: \$86\.62 – \$195\.95 \(84% of range\)/);
  assert.match(msg, /Entry: \$178\.40/);
  assert.match(msg, /Target: \$198\.00 \(\+11\.0%, 2\.72:1 R:R\)/);
  assert.match(msg, /Size: 13 shares ≈ \$2319\.20 • Risk: \$93\.60 \(1%\)/);
  assert.match(msg, /💡 Thesis:\nConstructive setup\./);
  assert.doesNotMatch(msg, /\bBUY\b/);
});

test("composeRichMessage in live mode omits the OBSERVE prefix; null sizing shows placeholder", () => {
  const noSizing = { ...RICH_RESULT, sizing: null };
  const msg = composeRichMessage(noSizing, RICH_MD, RICH_CFG, "live", "x");
  assert.ok(!msg.includes(OBSERVE_PREFIX));
  assert.match(msg, /Size: — \(position sizing not configured\)/);
});
