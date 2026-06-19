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
  "- One sentence, plain text, no emoji, no preamble, under 200 characters.",
  "- The exact numbers are shown to the user separately, so do not list them all;",
  "  just describe the setup qualitatively (e.g. trend, momentum).",
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
