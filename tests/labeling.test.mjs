import { test } from "node:test";
import assert from "node:assert/strict";
import { labelSignal, OUTCOME, spyBenchmark } from "../lambdas/shared/labeling.mjs";

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

test("gap-open ABOVE target then same-day dip to stop → TARGET (resting sell fills at the open)", () => {
  // Open 112 is above target 110: a resting target sell fills at the open before
  // any intraday move, so this is a TARGET, not a STOP — even though the same bar
  // later trades down through the stop. Exit at target (no favorable-gap credit).
  const bars = [b("2026-06-19", 112, 113, 96, 100)]; // open>target AND low<stop
  const r = labelSignal(SIGNAL, bars, CONFIG);
  assert.equal(r.outcome, OUTCOME.TARGET);
  assert.equal(r.hitTargetFirst, true);
  assert.equal(r.exitPrice, 110); // target, not the 112 gap-open
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

// --- Split-safe re-anchoring (B5) ---------------------------------------------

test("no-split regression: entry bar present, scaleFactor 1, behavior unchanged", () => {
  const bars = [
    b("2026-06-18", 100, 100, 99, 100), // entry bar — adjClose == storedEntry
    b("2026-06-19", 101, 103, 99, 100),
    b("2026-06-22", 99, 100, 97, 98), // low touches stop → STOP
  ];
  const r = labelSignal(SIGNAL, bars, CONFIG);
  assert.equal(r.outcome, OUTCOME.STOP);
  assert.equal(r.scaleFactor, 1);
  assert.equal(r.splitAdjusted, false);
  assert.equal(r.entryBarMissing, false);
  assert.equal(r.entryAdjAtLabel, 100);
  assert.equal(r.exitPrice, 97);
  assert.equal(r.profitPct, -3.3); // identical to the un-anchored STOP case
});

test("2:1 split after entry → STOP labeled correctly (not an instant false stop)", () => {
  // Stored at scan time: entry 200 / stop 194 / target 220. A 2:1 split halves
  // the whole adjusted series, so the entry bar now shows ~100.
  const signal = { entry: 200, stop: 194, target: 220, entryDate: "2026-06-18" };
  const bars = [
    b("2026-06-18", 100, 101, 99, 100), // entry bar, adjusted (was ~200)
    b("2026-06-19", 98, 100, 96, 99), // adjusted low 96 ≤ scaled stop 97 → STOP
  ];
  const r = labelSignal(signal, bars, CONFIG);
  assert.equal(r.scaleFactor, 0.5); // 100 / 200
  assert.equal(r.splitAdjusted, true);
  assert.equal(r.entryAdjAtLabel, 100);
  assert.equal(r.outcome, OUTCOME.STOP);
  assert.equal(r.exitPrice, 97); // min(scaled stop 97, open 98)
  // Same after-cost return as the equivalent unsplit -3% stop: NOT a false -50%.
  assert.equal(r.profitPct, -3.3);
});

test("2:1 split after entry → TARGET labeled correctly", () => {
  const signal = { entry: 200, stop: 194, target: 220, entryDate: "2026-06-18" };
  const bars = [
    b("2026-06-18", 100, 101, 99, 100), // entry bar
    b("2026-06-19", 101, 112, 100, 111), // high 112 ≥ scaled target 110 → TARGET
  ];
  const r = labelSignal(signal, bars, CONFIG);
  assert.equal(r.scaleFactor, 0.5);
  assert.equal(r.splitAdjusted, true);
  assert.equal(r.outcome, OUTCOME.TARGET);
  assert.equal(r.exitPrice, 110); // scaled target, no gap-up credit
  assert.equal(r.profitPct, 9.7); // +10% − 0.30% cost (split-invariant)
});

test("small dividend adjustment: scaled but splitAdjusted=false (under threshold)", () => {
  // Entry bar adjusts to 99 vs stored 100 → scaleFactor 0.99 (a dividend, not a split).
  const bars = [
    b("2026-06-18", 99, 99, 98, 99), // entry bar slightly adjusted
    b("2026-06-19", 100, 109, 99, 108), // high 109 ≥ scaled target 108.9 → TARGET
  ];
  const r = labelSignal(SIGNAL, bars, CONFIG);
  assert.equal(r.scaleFactor, 0.99);
  assert.equal(r.splitAdjusted, false); // |0.99 − 1| = 0.01 < 0.02
  assert.equal(r.outcome, OUTCOME.TARGET);
  assert.equal(r.exitPrice, 108.9); // 110 × 0.99
  assert.equal(r.profitPct, 9.7); // (108.9/99 − 1)*100 − 0.30 = +9.7
});

test("entry bar missing: falls back to scaleFactor 1 and flags entryBarMissing", () => {
  const bars = [
    b("2026-06-19", 101, 103, 99, 100), // no entry-date bar present
    b("2026-06-22", 99, 100, 97, 98),
  ];
  const r = labelSignal(SIGNAL, bars, CONFIG);
  assert.equal(r.entryBarMissing, true);
  assert.equal(r.scaleFactor, 1);
  assert.equal(r.entryAdjAtLabel, null);
  assert.equal(r.outcome, OUTCOME.STOP); // unchanged behavior on the fallback path
  assert.equal(r.exitPrice, 97);
});

// --- SPY benchmark (B6) -------------------------------------------------------

test("spyBenchmark computes SPY buy-hold return over the window (adjusted)", () => {
  const spy = [
    { date: "2026-06-17", close: 500 },
    { date: "2026-06-18", close: 510 }, // entry
    { date: "2026-06-19", close: 515 },
    { date: "2026-06-22", close: 530 }, // exit
  ];
  const r = spyBenchmark(spy, "2026-06-18", "2026-06-22");
  assert.equal(r.spyEntry, 510);
  assert.equal(r.spyExit, 530);
  assert.equal(r.spyReturnPct, round4(((530 / 510) - 1) * 100)); // ~3.9216
});

test("spyBenchmark uses last bar on/before a date when exact date missing", () => {
  const spy = [
    { date: "2026-06-18", close: 510 }, // entry
    { date: "2026-06-19", close: 520 }, // last <= 2026-06-21 (exit date is a gap)
  ];
  const r = spyBenchmark(spy, "2026-06-18", "2026-06-21");
  assert.equal(r.spyEntry, 510);
  assert.equal(r.spyExit, 520);
});

test("spyBenchmark returns nulls when SPY data is unavailable", () => {
  const r = spyBenchmark(null, "2026-06-18", "2026-06-22");
  assert.deepEqual(r, { spyEntry: null, spyExit: null, spyReturnPct: null });
});

function round4(n) { return Math.round(n * 1e4) / 1e4; }
