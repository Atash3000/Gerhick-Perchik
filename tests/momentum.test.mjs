import { test } from "node:test";
import assert from "node:assert/strict";
import {
  linearRegression,
  momentumScore,
  MOMENTUM_DEFAULTS,
} from "../lambdas/shared/momentum.mjs";

// Helper: build a perfectly exponential close series of length n with per-day
// log-growth g, starting at p0. ln(close) is then exactly linear in the day
// index, so the regression must recover slope=g and R²=1.
function expSeries(n, g, p0 = 100) {
  return Array.from({ length: n }, (_, i) => p0 * Math.exp(g * i));
}

// --- linearRegression (the pure helper) -----------------------------------

test("linearRegression recovers a known line exactly (slope, intercept, R²)", () => {
  // y = 2x + 3 over x = 0..4 → perfect fit.
  const reg = linearRegression([3, 5, 7, 9, 11]);
  assert.ok(reg, "expected a regression result");
  assert.ok(Math.abs(reg.slope - 2) < 1e-12, `slope ${reg.slope} != 2`);
  assert.ok(Math.abs(reg.intercept - 3) < 1e-12, `intercept ${reg.intercept} != 3`);
  assert.ok(Math.abs(reg.r2 - 1) < 1e-12, `r2 ${reg.r2} != 1`);
});

test("linearRegression returns R² near 0 for a flat zig-zag (no linear trend)", () => {
  // Alternating around a constant mean → slope ~0, R² ~0.
  const ys = Array.from({ length: 90 }, (_, i) => (i % 2 === 0 ? 10 : 11));
  const reg = linearRegression(ys);
  assert.ok(Math.abs(reg.slope) < 1e-3, `slope ${reg.slope} not ~0`);
  assert.ok(reg.r2 < 0.05, `r2 ${reg.r2} not ~0`);
});

test("linearRegression returns null on degenerate input (<2 points)", () => {
  assert.equal(linearRegression([]), null);
  assert.equal(linearRegression([5]), null);
});

// --- momentumScore: defaults + exact math ----------------------------------

test("momentumScore exposes the locked defaults (90-day lookback, 252-day annualization)", () => {
  assert.equal(MOMENTUM_DEFAULTS.lookback, 90);
  assert.equal(MOMENTUM_DEFAULTS.tradingDaysPerYear, 252);
});

test("momentumScore matches the closed-form Clenow value on a perfect exponential", () => {
  // A clean exponential uptrend: ln(price) is exactly linear → R²=1, slope=g,
  // momentum = (exp(g)^252 - 1) * 1.
  const g = 0.001;
  const closes = expSeries(90, g);
  const r = momentumScore(closes);
  assert.ok(r, "expected a momentum result");
  assert.ok(Math.abs(r.slope - g) < 1e-9, `slope ${r.slope} != ${g}`);
  assert.ok(Math.abs(r.r2 - 1) < 1e-9, `r2 ${r.r2} != 1`);
  const expected = Math.exp(g) ** 252 - 1;
  assert.ok(Math.abs(r.annualized - expected) < 1e-9, `annualized ${r.annualized} != ${expected}`);
  assert.ok(Math.abs(r.momentum - expected) < 1e-9, `momentum ${r.momentum} != ${expected}`);
});

test("momentumScore: a clean uptrend scores HIGH with R² near 1", () => {
  const closes = expSeries(90, 0.002); // steady ~0.2%/day climb
  const r = momentumScore(closes);
  assert.ok(r.momentum > 0.3, `momentum ${r.momentum} should be strongly positive`);
  assert.ok(r.r2 > 0.99, `r2 ${r.r2} should be ~1 for a smooth trend`);
});

test("momentumScore: a choppy flat series scores near ZERO", () => {
  // Oscillates around 100 with no net trend → annualized ~0 → momentum ~0.
  const closes = Array.from({ length: 90 }, (_, i) => (i % 2 === 0 ? 100 : 103));
  const r = momentumScore(closes);
  assert.ok(Math.abs(r.momentum) < 0.05, `momentum ${r.momentum} should be ~0`);
});

test("momentumScore: a steady climber beats a choppy climber with the SAME net rise (R² rewards smoothness)", () => {
  // Both run 100 -> 150 over 90 bars (same overall slope in log space). The
  // smooth one is a clean log-line (R²~1); the jagged one zig-zags around it
  // (R² lower). The × R² term must rank the smooth one higher — the core thesis.
  const n = 90;
  const logStart = Math.log(100);
  const logEnd = Math.log(150);
  const smooth = Array.from({ length: n }, (_, i) =>
    Math.exp(logStart + (logEnd - logStart) * (i / (n - 1)))
  );
  const jagged = smooth.map((c, i) => c * (i % 2 === 0 ? 0.94 : 1.06));

  const a = momentumScore(smooth);
  const b = momentumScore(jagged);
  assert.ok(a.r2 > b.r2, `smooth r2 ${a.r2} should exceed jagged r2 ${b.r2}`);
  assert.ok(a.momentum > b.momentum, `smooth momentum ${a.momentum} should exceed jagged ${b.momentum}`);
});

test("momentumScore: a downtrend scores negative", () => {
  const closes = expSeries(90, -0.0015);
  const r = momentumScore(closes);
  assert.ok(r.momentum < 0, `momentum ${r.momentum} should be negative for a downtrend`);
});

// --- momentumScore: guards -------------------------------------------------

test("momentumScore returns null when history is shorter than the lookback", () => {
  assert.equal(momentumScore(expSeries(89, 0.001)), null);
  assert.equal(momentumScore([]), null);
  assert.equal(momentumScore(undefined), null);
});

test("momentumScore uses only the most recent `lookback` bars", () => {
  // A long flat prefix followed by exactly 90 bars of clean uptrend: only the
  // last 90 should drive the score, so it must match the 90-bar uptrend alone.
  const tail = expSeries(90, 0.002, 100);
  const withPrefix = [...Array.from({ length: 50 }, () => 100), ...tail];
  const a = momentumScore(withPrefix);
  const b = momentumScore(tail);
  assert.ok(Math.abs(a.momentum - b.momentum) < 1e-9, "should depend only on the last 90 bars");
});

test("momentumScore returns null on non-positive or non-finite closes (ln undefined)", () => {
  const bad = expSeries(90, 0.001);
  bad[10] = 0; // ln(0) = -Infinity
  assert.equal(momentumScore(bad), null);
  const bad2 = expSeries(90, 0.001);
  bad2[20] = -5;
  assert.equal(momentumScore(bad2), null);
  const bad3 = expSeries(90, 0.001);
  bad3[30] = NaN;
  assert.equal(momentumScore(bad3), null);
});

test("momentumScore honors a custom annualization constant (250 vs 252)", () => {
  const g = 0.001;
  const closes = expSeries(90, g);
  const r250 = momentumScore(closes, { tradingDaysPerYear: 250 });
  assert.ok(Math.abs(r250.annualized - (Math.exp(g) ** 250 - 1)) < 1e-9);
});
