import { test } from "node:test";
import assert from "node:assert/strict";
import { labelSignal, OUTCOME } from "../lambdas/shared/labeling.mjs";

const SIGNAL = { entry: 100, stop: 97, target: 110, entryDate: "2026-06-18" };
const CONFIG = { feeBps: 10, slippageBps: 5, timeoutTradingDays: 5 };
// Cost per round trip = 2 * (10 + 5) bps = 30 bps = 0.30%.

const b = (date, open, high, low, close) => ({ date, open, high, low, close });

test("STOP: low touches stop, exit at stop when no gap, after-cost P&L", () => {
  const bars = [
    b("2026-06-19", 101, 103, 99, 100), // no touch
    b("2026-06-22", 99, 100, 97, 98),   // low == stop → STOP, open above stop
  ];
  const r = labelSignal(SIGNAL, bars, CONFIG);
  assert.equal(r.outcome, OUTCOME.STOP);
  assert.equal(r.hitStopFirst, true);
  assert.equal(r.exitPrice, 97); // min(stop 97, open 99)
  assert.equal(r.exitDate, "2026-06-22");
  assert.equal(r.daysHeld, 2);
  assert.equal(r.profitPct, -3.3); // (97/100-1)*100 - 0.30
});

test("STOP gap-through: exit at the worse of stop vs open", () => {
  const bars = [b("2026-06-19", 95, 96, 94, 95)]; // gaps open below stop
  const r = labelSignal(SIGNAL, bars, CONFIG);
  assert.equal(r.outcome, OUTCOME.STOP);
  assert.equal(r.exitPrice, 95); // min(97, 95) → the gap fill
  assert.equal(r.profitPct, -5.3); // -5 - 0.30
});

test("TARGET: high touches target, exit at target (no gap-up credit)", () => {
  const bars = [
    b("2026-06-19", 101, 105, 100, 104), // no touch
    b("2026-06-22", 106, 112, 105, 111), // high >= target; opened above target
  ];
  const r = labelSignal(SIGNAL, bars, CONFIG);
  assert.equal(r.outcome, OUTCOME.TARGET);
  assert.equal(r.hitTargetFirst, true);
  assert.equal(r.exitPrice, 110); // target, not the 106 open
  assert.equal(r.profitPct, 9.7); // 10 - 0.30
});

test("same day both hit → STOP wins (pessimistic)", () => {
  const bars = [b("2026-06-19", 100, 111, 96, 105)]; // low<stop AND high>target
  const r = labelSignal(SIGNAL, bars, CONFIG);
  assert.equal(r.outcome, OUTCOME.STOP);
  assert.equal(r.hitStopFirst, true);
  assert.equal(r.exitPrice, 97); // min(97, open 100)
});

test("TIMEOUT: no touch within window → exit at the timeout day's close", () => {
  const bars = [
    b("2026-06-19", 100, 105, 99, 101),
    b("2026-06-22", 101, 106, 100, 102),
    b("2026-06-23", 102, 107, 100, 103),
    b("2026-06-24", 103, 108, 101, 104),
    b("2026-06-25", 104, 109, 102, 103), // day 5 == timeout
  ];
  const r = labelSignal(SIGNAL, bars, CONFIG);
  assert.equal(r.outcome, OUTCOME.TIMEOUT);
  assert.equal(r.exitDate, "2026-06-25");
  assert.equal(r.exitPrice, 103); // close of the timeout day
  assert.equal(r.daysHeld, 5);
  assert.equal(r.profitPct, 2.7); // 3 - 0.30
});

test("unresolved: no touch and fewer than timeout bars → null (stay OPEN)", () => {
  const bars = [
    b("2026-06-19", 100, 105, 99, 101),
    b("2026-06-22", 101, 106, 100, 102),
  ];
  assert.equal(labelSignal(SIGNAL, bars, CONFIG), null);
});

test("the entry bar itself is never counted (only days after entry)", () => {
  const bars = [
    b("2026-06-18", 100, 100, 90, 100), // entry day low pierces stop — must be IGNORED
    b("2026-06-19", 100, 105, 99, 101),
    b("2026-06-22", 101, 106, 100, 102),
    b("2026-06-23", 102, 107, 100, 103),
    b("2026-06-24", 103, 108, 101, 104),
    b("2026-06-25", 104, 109, 102, 103),
  ];
  const r = labelSignal(SIGNAL, bars, CONFIG);
  assert.equal(r.outcome, OUTCOME.TIMEOUT); // NOT stop from the entry-day low
  assert.equal(r.daysHeld, 5);
});
