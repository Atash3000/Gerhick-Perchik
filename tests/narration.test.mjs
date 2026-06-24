import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPayload,
  buildAnthropicRequest,
  narrate,
  composeMessage,
  composeRichMessage,
  buildBullets,
  qualityTier,
  trendText,
  targetTypeBadge,
  buildWhyScoredHigh,
  buildRiskBullets,
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
  assert.match(msg, /Score: 81\.0\/100 • 🅰️ Tier A\+/); // score 81 → A+
  assert.match(msg, /Market Cap: \$4\.36T/);
  assert.match(msg, /52W Range: \$86\.62 – \$195\.95/);
  assert.match(msg, /Entry: \$178\.40/);
  assert.match(msg, /Target: \$198\.00 \(\+11\.0%\)/);     // Trade Plan, no inline R:R
  assert.match(msg, /Risk\/Reward: 2\.7 : 1/);             // R:R own line, 1-decimal
  assert.match(msg, /Size: 13 shares ≈ \$2319\.20 • Risk: \$93\.60 \(1%\)/);
  assert.match(msg, /💡 Thesis\nConstructive setup\./);
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
    const m = msg.match(new RegExp(`^${l}: ([\\d.]+) /`, "m"));
    return m ? Number(m[1]) : null;
  });
}

test("composeRichMessage v2: all factors present render with correct formatting", () => {
  const msg = composeRichMessage(FACTOR_RESULT, FACTOR_MD, RICH_CFG, "observe", "x", FACTOR_EXTRAS);
  assert.match(msg, /📊 Score Factors/);
  assert.match(msg, /RS Rank: 87\/99/);
  assert.match(msg, /EPS Growth YoY: \+42\.0%/);
  assert.match(msg, /Revenue Growth YoY: \+18\.0%/);
  assert.match(msg, /Sector Strength: 78\/99/);
  assert.match(msg, /📋 Factor Breakdown/);
  assert.doesNotMatch(msg, /Target Type:/); // moved to the Gerchik Level badge
});

test("composeRichMessage v2: factor section sits between Technicals and Thesis", () => {
  const msg = composeRichMessage(FACTOR_RESULT, FACTOR_MD, RICH_CFG, "observe", "x", FACTOR_EXTRAS);
  assert.ok(msg.indexOf("📈 Technicals") < msg.indexOf("📊 Score Factors"));
  assert.ok(msg.indexOf("📊 Score Factors") < msg.indexOf("💡 Thesis"));
});

test("composeRichMessage v2: missing factors all render N/A and components show 0.0", () => {
  const noBreakdown = { ...FACTOR_RESULT, targetType: null, breakdown: null };
  const noRsMd = { ...RICH_MD }; // no rsRank
  const msg = composeRichMessage(noBreakdown, noRsMd, RICH_CFG, "observe", "x"); // no extras
  assert.match(msg, /RS Rank: N\/A/);
  assert.match(msg, /EPS Growth YoY: N\/A/);
  assert.match(msg, /Revenue Growth YoY: N\/A/);
  assert.match(msg, /Sector Strength: N\/A/);
  assert.match(msg, /^Trend: 0\.0 \/ 15/m);
  assert.match(msg, /^Empirical Edge: 0\.0 \/ 15/m);
});

test("composeRichMessage v2: 1-decimal breakdown rows still sum to result.score", () => {
  const msg = composeRichMessage(FACTOR_RESULT, FACTOR_MD, RICH_CFG, "observe", "x", FACTOR_EXTRAS);
  const rows = parseBreakdownRows(msg);
  assert.ok(rows.every((v) => v !== null), "all 9 rows present");
  const sum = rows.reduce((a, b) => a + b, 0);
  // displayed values are 1-decimal, so they sum to the score within rounding
  assert.ok(Math.abs(sum - FACTOR_RESULT.score) <= 0.5, `displayed sum ${sum} ≈ ${FACTOR_RESULT.score}`);
});

test("composeRichMessage v2: Empirical Edge row + neutral note", () => {
  const msg = composeRichMessage(FACTOR_RESULT, FACTOR_MD, RICH_CFG, "observe", "x", FACTOR_EXTRAS);
  assert.match(msg, /Empirical Edge: 7\.5 \/ 15/);
  assert.match(msg, /Empirical Edge remains neutral until enough real outcomes accumulate\./);
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

// === Alert v2.1: trader's-briefing redesign + dynamic trend-line bug fix ===

test("qualityTier: score → letter+emoji bands", () => {
  assert.deepEqual(qualityTier(81), { letter: "A+", emoji: "🅰️" });
  assert.deepEqual(qualityTier(77.3), { letter: "A", emoji: "🅰️" });
  assert.deepEqual(qualityTier(65), { letter: "B", emoji: "🅱️" });
  assert.deepEqual(qualityTier(55), { letter: "C", emoji: "🅲" });
});

test("trendText is DERIVED, not hardcoded (the bug fix)", () => {
  // above both
  assert.equal(trendText({ close: 239.63, ma50: 232.21, ma200: 177.41 }), "Above 50MA & 200MA ✓");
  // WBD real case: above 200MA, BELOW 50MA — must NOT claim above 50MA
  assert.equal(trendText({ close: 26.88, ma50: 27.01, ma200: 25.30 }), "Above 200MA ✓ · below 50MA ⚠️");
  assert.match(trendText({ close: 1, ma50: null, ma200: 2 }), /unavailable/);
});

test("targetTypeBadge maps each type to an emoji label", () => {
  assert.equal(targetTypeBadge("RESISTANCE"), "🟢 Resistance");
  assert.equal(targetTypeBadge("PROJECTED_ATR"), "🟡 Projected ATR");
  assert.equal(targetTypeBadge("RESISTANCE_FLOORED_BY_PROJECTED_ATR"), "🟠 ATR Floor");
});

test("buildWhyScoredHigh fires bullets only for strong factors", () => {
  const md = { close: 178, ma50: 160, ma200: 140, volume: 1_500_000, avgVolume30: 1_000_000 };
  const why = buildWhyScoredHigh({}, { ...md, rsRank: 91 }, { fundamentals: { epsGrowthQtr: 383.8, salesGrowthQtr: 21.3 }, sectorStrengthPct: 75 });
  assert.ok(why.some((b) => /Top-decile RS Rank \(91\)/.test(b)));
  assert.ok(why.some((b) => /Exceptional EPS growth \(\+383\.8%\)/.test(b)));
  assert.ok(why.some((b) => /Strong revenue growth \(\+21\.3%\)/.test(b)));
  assert.ok(why.some((b) => /Strong sector participation/.test(b)));
  assert.ok(why.some((b) => /Price above 50MA & 200MA/.test(b)));
  assert.ok(why.some((b) => /Elevated volume/.test(b)));
});

test("buildWhyScoredHigh falls back when nothing is strong", () => {
  const why = buildWhyScoredHigh({}, { close: 10, ma50: 9, ma200: 8, volume: 1, avgVolume30: 10, rsRank: 20 }, {});
  // trend still fires (above both); but with weak everything else, ensure non-empty
  assert.ok(why.length >= 1);
  const why2 = buildWhyScoredHigh({}, { close: 8, ma50: 9, ma200: 10, rsRank: 20 }, {});
  assert.deepEqual(why2, ["Passed all entry gates"]);
});

test("buildRiskBullets: moderate RSI, projected-ATR no-resistance, always stop-gap", () => {
  const risks = buildRiskBullets(
    { targetType: "PROJECTED_ATR" },
    { rsi: 45.4, daysToEarnings: 39, nearestSupport: { price: 1, touches: 2 } },
    { minRiskReward: 2 }
  );
  assert.ok(risks.some((r) => /RSI momentum is only moderate/.test(r)));
  assert.ok(risks.some((r) => /No nearby chart resistance available/.test(r)));
  assert.ok(risks.some((r) => /ATR-based stop may gap through overnight/.test(r)));
  assert.ok(!risks.some((r) => /Earnings/.test(r))); // 39d
});

test("composeRichMessage v2.1: header tier, Gerchik Level, 1-decimal breakdown", () => {
  const result = {
    ticker: "NUE", score: 77.32, entry: 239.63, stop: 227.90, target: 263.10, riskReward: 2,
    dataAsOf: "2026-06-23", strategyVersion: "gp-2.0.0", targetType: "PROJECTED_ATR",
    breakdown: { trend: 15, setup: 11, rsRank: 11.03, growthQuality: 13, sectorStrength: 3.79, momentum: 6, volume: 8, news: 2, empiricalEdge: 7.5 },
    sizing: { shares: 157, notional: 4220.16, riskAmount: 99.65, riskPct: 1 },
  };
  const md = {
    name: "Nucor Corp", marketCapMillions: 55_800, close: 239.63, low52: 120.99, high52: 270.90,
    ma50: 232.21, ma200: 177.41, atr: 7.82, rsi: 45.41, volume: 2_283_791, avgVolume30: 1_646_763,
    nearestSupport: { price: 235.44, touches: 2, brokenSupport: false }, sector: "Materials", rsRank: 91,
  };
  const extras = { fundamentals: { epsGrowthQtr: 383.77, salesGrowthQtr: 21.28 }, sectorStrengthPct: 75 };
  const msg = composeRichMessage(result, md, { minRiskReward: 2 }, "observe", "NUE strong uptrend.", extras);

  assert.match(msg, /Score: 77\.3\/100 • 🅰️ Tier A/);
  assert.match(msg, /🎯 Gerchik Level/);
  assert.match(msg, /Support: \$235\.44 \(2 touches\)/);
  assert.match(msg, /Target: \$263\.10 \(🟡 Projected ATR\)/);
  assert.match(msg, /📈 Technicals\nTrend: Above 50MA & 200MA ✓/);
  assert.match(msg, /📋 Factor Breakdown/);
  assert.match(msg, /Trend: 15\.0 \/ 15/);
  assert.match(msg, /Sector: 3\.8 \/ 5/);
  assert.match(msg, /Risk\/Reward: 2\.0 : 1/);
  assert.match(msg, /Size: 157 shares ≈ \$4220\.16/);
  assert.match(msg, /💡 Why It Scored High/);
  assert.doesNotMatch(msg, /\bBUY\b/);
});

test("composeRichMessage v2.1: support with no touch count never prints 'undefined'", () => {
  const result = { ticker: "X", score: 60, entry: 10, stop: 9, target: 12, riskReward: 2, dataAsOf: "2026-06-23", strategyVersion: "gp-2.0.0", targetType: "PROJECTED_ATR", breakdown: null, sizing: null };
  const md = { close: 10, ma50: 9, ma200: 8, atr: 0.5, rsi: 60, nearestSupport: { price: 9.5 } }; // touches missing
  const msg = composeRichMessage(result, md, { minRiskReward: 2 }, "observe", "x", {});
  assert.match(msg, /Support: \$9\.50/);
  assert.doesNotMatch(msg, /undefined/);
});
