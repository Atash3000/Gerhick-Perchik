import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sizePosition,
  updateTrailingStop,
  evaluateExits,
  riskGovernor,
} from "../lambdas/shared/portfolio.mjs";

// Frozen Strategy-v1 §4/§5/§6 values.
const CFG = {
  atrPeriod: 20,
  kStop: 2.5,
  riskPctPerTrade: 0.75,
  positionCapPct: 15,
  trendMa: 100,
  weeklyDdLimit: 8,
  monthlyDdLimit: 15,
  maxDdLimit: 25,
};

// --- sizePosition (§4) -----------------------------------------------------

test("sizePosition: equal risk → a more volatile name gets FEWER shares", () => {
  const acct = 100_000;
  const calm = sizePosition(100, 2, acct, CFG); // ATR 2 → per-share risk 5
  const wild = sizePosition(100, 4, acct, CFG); // ATR 4 → per-share risk 10 (2x)
  assert.ok(calm.shares > wild.shares);
  assert.equal(calm.shares, wild.shares * 2); // exactly half for 2x volatility
});

test("sizePosition: initial stop is entry − kStop×ATR and risk ≈ riskPctPerTrade of account", () => {
  const r = sizePosition(100, 2, 100_000, CFG);
  assert.equal(r.stop, 95); // 100 − 2.5*2
  // 0.75% of 100k = $750 risk budget; per-share risk $5 → 150 shares; risk = $750.
  assert.equal(r.shares, 150);
  assert.equal(r.riskAmount, 750);
  assert.equal(r.capped, false);
});

test("sizePosition: no position exceeds the positionCapPct concentration cap", () => {
  // Very low volatility → the risk formula wants a huge position; the 15% cap binds.
  const acct = 100_000;
  const r = sizePosition(100, 0.1, acct, CFG); // per-share risk 0.25 → ~3000 shares uncapped
  assert.equal(r.capped, true);
  assert.ok(r.notional <= acct * 0.15 + 1e-6); // <= $15,000
  assert.equal(r.shares, Math.floor((acct * 0.15) / 100)); // 150 shares
});

test("sizePosition: returns null on bad inputs (can't size a real position)", () => {
  assert.equal(sizePosition(0, 2, 100_000, CFG), null); // no price
  assert.equal(sizePosition(100, 0, 100_000, CFG), null); // no volatility
  assert.equal(sizePosition(100, 2, 0, CFG), null); // no account
  assert.equal(sizePosition(100, NaN, 100_000, CFG), null);
});

// --- updateTrailingStop (§5: chandelier, never lowered) --------------------

test("updateTrailingStop: ratchets UP on new highs, NEVER moves down", () => {
  const atr = 4; // kStop*atr = 10
  let pos = { entry: 100, stop: 90, peakClose: 100 };
  const stops = [];
  for (const close of [105, 110, 108, 107, 112]) {
    pos = updateTrailingStop(pos, close, atr, CFG);
    stops.push(pos.stop);
  }
  // 105→95, 110→100, 108→100(held, close fell), 107→100(held), 112→102.
  assert.deepEqual(stops, [95, 100, 100, 100, 102]);
  // strictly non-decreasing
  for (let i = 1; i < stops.length; i++) assert.ok(stops[i] >= stops[i - 1]);
});

// --- evaluateExits (§5) ----------------------------------------------------

const ctx = (over = {}) => ({ atr: 4, trendSma: 95, inExitZone: false, ...over });
const pos = (over = {}) => ({ entry: 100, stop: 90, peakClose: 100, ...over });

test("evaluateExits: a stop-out at/below entry is a HARD_STOP", () => {
  const r = evaluateExits(pos(), { high: 96, low: 89, close: 92 }, ctx(), CFG);
  assert.equal(r.exit, true);
  assert.equal(r.reason, "HARD_STOP"); // stop 90 <= entry 100
});

test("evaluateExits: a stop-out above entry (in profit) is a TRAIL exit", () => {
  // Already trailed up: peakClose 130 → trail 120; today's low pierces it.
  const r = evaluateExits(pos({ stop: 120, peakClose: 130 }), { high: 122, low: 119, close: 121 }, ctx({ trendSma: 110 }), CFG);
  assert.equal(r.exit, true);
  assert.equal(r.reason, "TRAIL"); // stop 120 > entry 100
});

test("evaluateExits: close below trendMa → TREND exit (no stop hit)", () => {
  const r = evaluateExits(pos(), { high: 96, low: 94, close: 94 }, ctx({ trendSma: 95 }), CFG);
  assert.equal(r.exit, true);
  assert.equal(r.reason, "TREND"); // 94 < trendSma 95, low 94 > stop 90
});

test("evaluateExits: name falls out of the top exitRankPct → RANK exit", () => {
  const r = evaluateExits(pos(), { high: 101, low: 99, close: 100 }, ctx({ inExitZone: true }), CFG);
  assert.equal(r.exit, true);
  assert.equal(r.reason, "RANK");
});

test("evaluateExits: STOP takes priority over TREND and RANK when several fire", () => {
  const r = evaluateExits(pos(), { high: 96, low: 88, close: 89 }, ctx({ trendSma: 95, inExitZone: true }), CFG);
  assert.equal(r.reason, "HARD_STOP"); // stop hit wins
});

test("evaluateExits: none fire → hold, and the trailing stop is still advanced", () => {
  const r = evaluateExits(pos(), { high: 112, low: 108, close: 110 }, ctx({ trendSma: 95 }), CFG);
  assert.equal(r.exit, false);
  assert.equal(r.reason, null);
  assert.equal(r.peakClose, 110); // peak advanced
  assert.equal(r.stop, 100); // 110 − 10, ratcheted up from 90
});

// --- riskGovernor (§6: block new risk only, NEVER force-sell) ---------------

test("riskGovernor: weekly drawdown breach blocks new buys (not a halt)", () => {
  const r = riskGovernor({ weeklyPct: 9, monthlyPct: 5, fromPeakPct: 9 }, CFG);
  assert.equal(r.blockNewBuys, true);
  assert.equal(r.haltAllNew, false);
});

test("riskGovernor: monthly drawdown breach blocks new entries this month", () => {
  const r = riskGovernor({ weeklyPct: 2, monthlyPct: 16, fromPeakPct: 16 }, CFG);
  assert.equal(r.blockNewBuys, true);
  assert.equal(r.haltAllNew, false);
});

test("riskGovernor: max drawdown from peak halts ALL new trading", () => {
  const r = riskGovernor({ weeklyPct: 3, monthlyPct: 10, fromPeakPct: 26 }, CFG);
  assert.equal(r.blockNewBuys, true);
  assert.equal(r.haltAllNew, true);
});

test("riskGovernor: within all limits → new buys allowed", () => {
  const r = riskGovernor({ weeklyPct: 4, monthlyPct: 7, fromPeakPct: 12 }, CFG);
  assert.equal(r.blockNewBuys, false);
  assert.equal(r.haltAllNew, false);
});

test("riskGovernor: NEVER emits a sell/close signal — it only gates new risk", () => {
  // The governor's whole contract is gating NEW buys; selling is evaluateExits's
  // job. Even at catastrophic drawdown the result must carry no sell instruction.
  const r = riskGovernor({ weeklyPct: 30, monthlyPct: 30, fromPeakPct: 40 }, CFG);
  assert.deepEqual(Object.keys(r).sort(), ["blockNewBuys", "haltAllNew", "reason"].sort());
});
