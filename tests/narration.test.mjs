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

// --- Alert v2: visibility-only Score Factors section ---
// A full 9-key breakdown (gp-2.0.0). Values are the engine's round(,2) outputs and
// sum exactly to `score` (the scoring invariant), so the displayed rows must too.
const FACTOR_BREAKDOWN = {
  empiricalEdge: 7.5, setup: 17.3, trend: 15, momentum: 7,
  volume: 5, news: 2, rsRank: 10, growthQuality: 9, sectorStrength: 4,
};
const FACTOR_SCORE = Object.values(FACTOR_BREAKDOWN).reduce((a, b) => a + b, 0); // 76.8
const FACTOR_RESULT = {
  ...RICH_RESULT, score: FACTOR_SCORE,
  targetType: "PROJECTED_ATR", breakdown: FACTOR_BREAKDOWN,
};
// RICH_MD + cross-sectional rsRank that the scanner attaches.
const FACTOR_MD = { ...RICH_MD, rsRank: 87 };
const FACTOR_EXTRAS = {
  fundamentals: { epsGrowthQtr: 42, salesGrowthQtr: 18 },
  sectorStrengthPct: 78,
};

// Parse the numerators from the displayed "Label: value/max" breakdown rows.
function parseBreakdownRows(msg) {
  const labels = ["Trend", "Setup", "RS", "Growth", "Sector", "Momentum", "Volume", "News", "Empirical Edge"];
  return labels.map((l) => {
    const m = msg.match(new RegExp(`^${l}: ([\\d.]+)/`, "m"));
    return m ? Number(m[1]) : null;
  });
}

test("composeRichMessage v2: all factors present render with correct formatting", () => {
  const msg = composeRichMessage(FACTOR_RESULT, FACTOR_MD, RICH_CFG, "observe", "x", FACTOR_EXTRAS);
  assert.match(msg, /📊 Score Factors:/);
  assert.match(msg, /RS Rank: 87\/99/);
  assert.match(msg, /EPS Growth YoY: \+42\.0%/);
  assert.match(msg, /Revenue Growth YoY: \+18\.0%/);
  assert.match(msg, /Sector Strength: 78\/99/);
  assert.match(msg, /Target Type: Projected ATR target/);
  assert.match(msg, /Factor Breakdown:/);
});

test("composeRichMessage v2: factor section sits between Technicals and Thesis", () => {
  const msg = composeRichMessage(FACTOR_RESULT, FACTOR_MD, RICH_CFG, "observe", "x", FACTOR_EXTRAS);
  assert.ok(msg.indexOf("📈 Technicals:") < msg.indexOf("📊 Score Factors:"));
  assert.ok(msg.indexOf("📊 Score Factors:") < msg.indexOf("💡 Thesis:"));
});

test("composeRichMessage v2: missing factors all render N/A and components show 0", () => {
  const noBreakdown = { ...FACTOR_RESULT, targetType: null, breakdown: null };
  const noRsMd = { ...RICH_MD }; // no rsRank
  const msg = composeRichMessage(noBreakdown, noRsMd, RICH_CFG, "observe", "x"); // no extras
  assert.match(msg, /RS Rank: N\/A/);
  assert.match(msg, /EPS Growth YoY: N\/A/);
  assert.match(msg, /Revenue Growth YoY: N\/A/);
  assert.match(msg, /Sector Strength: N\/A/);
  assert.match(msg, /Target Type: N\/A/);
  assert.match(msg, /^Trend: 0\/15/m);
  assert.match(msg, /^Empirical Edge: 0\/15/m);
});

test("composeRichMessage v2: all three target types map to human labels", () => {
  const mk = (tt) => composeRichMessage({ ...FACTOR_RESULT, targetType: tt }, FACTOR_MD, RICH_CFG, "observe", "x", FACTOR_EXTRAS);
  assert.match(mk("RESISTANCE"), /Target Type: Resistance target/);
  assert.match(mk("PROJECTED_ATR"), /Target Type: Projected ATR target/);
  assert.match(mk("RESISTANCE_FLOORED_BY_PROJECTED_ATR"), /Target Type: Resistance too close → ATR floor/);
});

test("composeRichMessage v2: displayed breakdown rows sum to result.score", () => {
  const msg = composeRichMessage(FACTOR_RESULT, FACTOR_MD, RICH_CFG, "observe", "x", FACTOR_EXTRAS);
  const rows = parseBreakdownRows(msg);
  assert.ok(rows.every((v) => v !== null), "all 9 rows present");
  const sum = rows.reduce((a, b) => a + b, 0);
  assert.equal(Math.round(sum * 100) / 100, FACTOR_RESULT.score);
});

test("composeRichMessage v2: Empirical Edge row labeled neutral, with note", () => {
  const msg = composeRichMessage(FACTOR_RESULT, FACTOR_MD, RICH_CFG, "observe", "x", FACTOR_EXTRAS);
  assert.match(msg, /Empirical Edge: 7\.5\/15 \(neutral\)/);
  assert.match(msg, /Empirical Edge is neutral until enough outcomes exist\./);
});

test("composeRichMessage v2: Technicals block carries distance/ATR line", () => {
  const msg = composeRichMessage(FACTOR_RESULT, FACTOR_MD, RICH_CFG, "observe", "x", FACTOR_EXTRAS);
  // close 178.40, ma200 140 → +27.4%; ma50 160 → +11.5%; atr 7.20/178.40 → 4.0%
  assert.match(msg, /Distance >200MA: \+27\.4%/);
  assert.match(msg, />50MA: \+11\.5%/);
  assert.match(msg, /ATR\/Price: 4\.0%/);
});

test("composeRichMessage v2: negative growth renders signed", () => {
  const extras = { fundamentals: { epsGrowthQtr: -5, salesGrowthQtr: 0 }, sectorStrengthPct: null };
  const msg = composeRichMessage(FACTOR_RESULT, FACTOR_MD, RICH_CFG, "observe", "x", extras);
  assert.match(msg, /EPS Growth YoY: -5\.0%/);
  assert.match(msg, /Revenue Growth YoY: \+0\.0%/);
  assert.match(msg, /Sector Strength: N\/A/);
});
