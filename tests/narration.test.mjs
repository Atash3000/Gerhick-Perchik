import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPayload,
  buildAnthropicRequest,
  narrate,
  composeMessage,
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
