// narration.mjs — turn a LOCKED signal payload into a Telegram message (Phase 6).
//
// "Math decides. AI only explains." The numbers in the final message come from a
// deterministic facts block built here from the payload — NOT from the model. The
// LLM only writes a short flavor sentence; if it misbehaves (or is down), the
// numbers are still correct and the message still sends. The model can never
// choose a trade, change a number, or invent data.
//
// Narration uses the Haiku tier (cheap/fast, sufficient for one-sentence phrasing)
// via the Anthropic Messages API over fetch. Key read by path from SSM.

import { getParameter } from "./ssm.mjs";

export const ANTHROPIC_KEY_PATH = "/edge-hunter/anthropic/api_key";
export const NARRATION_MODEL = "claude-haiku-4-5";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export const OBSERVE_PREFIX = "📋 OBSERVE — tracking only, not a recommendation";

// Used when the model call fails — the alert still goes out with correct numbers.
export const FALLBACK_NARRATION = "Technical setup flagged by the scoring model.";

// The narration prompt is LOCKED. The model may only rephrase; it must not add or
// change any number, give financial advice, or imply certainty.
export const LOCKED_SYSTEM_PROMPT = [
  "You write a single short sentence to accompany an automated technical-analysis",
  "trading SIGNAL (not advice). You are given a locked JSON payload.",
  "",
  "Rules — follow exactly:",
  "- Use ONLY the data in the JSON. Invent nothing. Do not add or change any number.",
  "- Do NOT give financial advice. Do NOT say 'buy', 'sell', or 'guaranteed'.",
  "- Frame it as a 'possible setup', never a recommendation or a sure thing.",
  "- 1-3 short sentences, plain text, no emoji, no preamble, under 400 characters.",
  "- The exact numbers are shown to the user separately, so do not list them all;",
  "  just describe the setup qualitatively (trend, momentum, support/resistance).",
].join("\n");

// The minimal payload the model is allowed to see. Pure.
export function buildPayload(result, marketData, mode) {
  return {
    mode, // 'observe' | 'live'
    ticker: result.ticker,
    score: result.score,
    entry: result.entry,
    stop: result.stop,
    target: result.target,
    riskReward: result.riskReward,
    sector: marketData?.sector ?? null,
    rsi: marketData?.rsi ?? null,
    dataAsOf: result.dataAsOf,
    strategyVersion: result.strategyVersion,
  };
}

// Build the Anthropic Messages API request BODY (pure — no secret, unit-testable).
export function buildAnthropicRequest(payload, opts = {}) {
  return {
    url: ANTHROPIC_URL,
    body: {
      model: opts.model ?? NARRATION_MODEL,
      max_tokens: opts.maxTokens ?? 200,
      system: LOCKED_SYSTEM_PROMPT,
      messages: [
        { role: "user", content: `Signal JSON:\n${JSON.stringify(payload)}` },
      ],
    },
  };
}

// Call the model and return its one-sentence narration. Throws on I/O error; the
// caller falls back to FALLBACK_NARRATION so the alert still sends.
export async function narrate(payload, opts = {}) {
  const fetchFn = opts.fetchFn ?? fetch;
  const apiKey = opts.apiKey ?? (await getParameter(ANTHROPIC_KEY_PATH));
  const { url, body } = buildAnthropicRequest(payload, opts);

  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Anthropic narration failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const text = (data?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return text || FALLBACK_NARRATION;
}

// Assemble the final Telegram message DETERMINISTICALLY. The facts line is built
// from the payload, so the numbers are authoritative regardless of the model. In
// observe mode the OBSERVE disclaimer is always prepended. Never emits "BUY". Pure.
export function composeMessage(payload, narrationText) {
  const lines = [];
  if (payload.mode !== "live") lines.push(OBSERVE_PREFIX);
  const flavor = (narrationText ?? "").trim();
  if (flavor) lines.push(flavor);
  lines.push("");
  lines.push(`${payload.ticker} — possible setup`);
  lines.push(
    `Entry ${money(payload.entry)} · Stop ${money(payload.stop)} · ` +
      `Target ${money(payload.target)} · R:R ${payload.riskReward} · Score ${payload.score}`
  );
  lines.push(`as of ${payload.dataAsOf} · ${payload.strategyVersion}`);
  return lines.join("\n");
}

function money(n) {
  return typeof n === "number" ? n.toFixed(2) : String(n);
}

function signedPct(a, b) {
  if (!(b > 0) || typeof a !== "number") return "n/a";
  const p = (a / b - 1) * 100;
  return `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
}

function formatMarketCap(millions) {
  if (typeof millions !== "number" || millions <= 0) return "—";
  if (millions >= 1e6) return `$${(millions / 1e6).toFixed(2)}T`;
  if (millions >= 1e3) return `$${(millions / 1e3).toFixed(2)}B`;
  return `$${Math.round(millions)}M`;
}

// Deterministic bullish / risk bullets derived from the facts (NOT the AI).
export function buildBullets(result, md, config) {
  const bullish = [];
  const risks = [];
  const r = md.avgVolume30 > 0 ? md.volume / md.avgVolume30 : null;

  if (md.close > md.ma50 && md.close > md.ma200) {
    bullish.push("Price above both 50MA and 200MA — uptrend intact");
  } else if (md.close > md.ma200) {
    bullish.push("Price above the 200MA");
  }
  bullish.push(`R:R ${result.riskReward}:1 (min ${config.minRiskReward})`);
  if (md.nearestSupport && !md.nearestSupport.brokenSupport && md.nearestSupport.price < md.close) {
    const band = Math.min(0.03 * md.close, md.atr);
    if (md.close - md.nearestSupport.price <= band) {
      bullish.push(`Near support $${money(md.nearestSupport.price)} (${md.nearestSupport.touches} touches)`);
    }
  }
  if (r != null && r >= 1) bullish.push(`Volume ${r.toFixed(1)}× the 30-day average`);
  if (md.rsi >= 50 && md.rsi <= 65) bullish.push(`RSI ${md.rsi} — healthy momentum`);
  else if (md.rsi >= 40 && md.rsi <= 70) bullish.push(`RSI ${md.rsi} — constructive`);

  if (result.riskReward < config.minRiskReward * 1.5) {
    risks.push(`Reward room moderate (R:R ${result.riskReward})`);
  }
  if (typeof md.daysToEarnings === "number" && md.daysToEarnings <= 15) {
    risks.push(`Earnings in ${md.daysToEarnings} days`);
  }
  if (md.rsi > 70) risks.push(`RSI ${md.rsi} — extended/overbought`);
  if (!md.nearestSupport) risks.push("No nearby support below price — stop relies on ATR only");
  risks.push("ATR-based stop; an overnight gap can fill worse than planned");

  return { bullish, risks };
}

// Build the full richly-styled Telegram message DETERMINISTICALLY. Only `narration`
// (the thesis) is AI-written; every number and bullet is derived here. Pure.
export function composeRichMessage(result, md, config, mode, narration) {
  const m = md ?? {};
  const rangePct =
    typeof m.low52 === "number" && typeof m.high52 === "number" && m.high52 > m.low52
      ? Math.round(((m.close - m.low52) / (m.high52 - m.low52)) * 100)
      : null;
  const volR = m.avgVolume30 > 0 ? (m.volume / m.avgVolume30).toFixed(1) : "—";
  const { bullish, risks } = buildBullets(result, m, config);

  const lines = [
    "🟢 GERCHIK-PERCHIK SIGNAL",
    "━━━━━━━━━━━━━━━━━━━━",
  ];
  if (mode !== "live") lines.push(OBSERVE_PREFIX, "");
  else lines.push("");

  lines.push(`📊 ${result.ticker}${m.name ? ` — ${m.name}` : ""}`);
  lines.push(`⬆️ LONG • Score: ${result.score}/100`);
  if (m.sector) lines.push(`🏷 Sector: ${m.sector}`);

  lines.push("", "💰 Market Context:");
  lines.push(`Price: $${money(m.close)}${typeof m.pctChange === "number" ? ` (${m.pctChange >= 0 ? "+" : ""}${m.pctChange}%)` : ""}`);
  if (typeof m.low52 === "number" && typeof m.high52 === "number") {
    lines.push(`52w: $${money(m.low52)} – $${money(m.high52)}${rangePct != null ? ` (${rangePct}% of range)` : ""}`);
  }
  lines.push(`Market cap: ${formatMarketCap(m.marketCapMillions)}`);

  lines.push("", "📈 Technicals:");
  lines.push("Trend: above 50MA & 200MA ✓");
  lines.push(`RSI(14): ${m.rsi}`);
  if (m.nearestSupport) lines.push(`Support: $${money(m.nearestSupport.price)} (${m.nearestSupport.touches} touches)`);
  lines.push(`Resistance: $${money(result.target)} (target)`);
  lines.push(`ATR(14): $${money(m.atr)} • Vol: ${volR}× avg`);

  lines.push("", "💡 Thesis:", (narration ?? "").trim() || "Technical setup flagged by the scoring model.");

  lines.push("", "✅ Bullish:", ...bullish.map((b) => `• ${b}`));
  lines.push("", "⚠️ Risks:", ...risks.map((b) => `• ${b}`));

  lines.push("", "🎯 Trade Plan:");
  lines.push(`Entry: $${money(result.entry)}`);
  lines.push(`Stop: $${money(result.stop)} (${signedPct(result.stop, result.entry)})`);
  lines.push(`Target: $${money(result.target)} (${signedPct(result.target, result.entry)}, ${result.riskReward}:1 R:R)`);
  if (result.sizing) {
    lines.push(
      `Size: ${result.sizing.shares} shares ≈ $${money(result.sizing.notional)} • ` +
        `Risk: $${money(result.sizing.riskAmount)} (${result.sizing.riskPct}%)`
    );
  } else {
    lines.push("Size: — (position sizing not configured)");
  }

  lines.push("", `📅 as of ${result.dataAsOf} · ${result.strategyVersion}`);
  return lines.join("\n");
}
