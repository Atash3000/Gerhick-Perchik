import { test } from "node:test";
import assert from "node:assert/strict";
import { rsRaw, rsVsSpy, rankPercentiles, sectorStrengthPercentiles } from "../lambdas/shared/rs.mjs";

test("rsRaw = 2*return63d + return126d + return252d", () => {
  assert.equal(rsRaw({ return63d: 10, return126d: 20, return252d: 30 }), 70); // 20+20+30
  assert.equal(rsRaw({ return63d: 5, return126d: 0, return252d: -10 }), 0); // 10+0-10
});

test("rsRaw is null when any required return is missing/non-finite", () => {
  assert.equal(rsRaw({ return63d: 10, return126d: 20 }), null);
  assert.equal(rsRaw({ return63d: 10, return126d: NaN, return252d: 30 }), null);
  assert.equal(rsRaw({}), null);
});

test("rsVsSpy = ticker return126d minus SPY return126d", () => {
  assert.equal(rsVsSpy({ return126d: 18 }, 7), 11);
  assert.equal(rsVsSpy({ return126d: 5 }, 12), -7);
  assert.equal(rsVsSpy({ return126d: 5 }, null), null);
  assert.equal(rsVsSpy({}, 7), null);
});

test("rsVsSpy rejects non-finite inputs (NaN/Infinity) → null, never leaks NaN", () => {
  assert.equal(rsVsSpy({ return126d: NaN }, 7), null);
  assert.equal(rsVsSpy({ return126d: 5 }, Infinity), null);
  assert.equal(rsVsSpy({ return126d: Infinity }, -Infinity), null);
});

test("rankPercentiles ranks 1-99, strongest highest", () => {
  const m = rankPercentiles([
    { key: "A", value: 100 },
    { key: "B", value: 50 },
    { key: "C", value: 10 },
    { key: "D", value: -5 },
  ]);
  // A is the top of 4 → high percentile; D the bottom → low.
  assert.ok(m.get("A") > m.get("B"));
  assert.ok(m.get("B") > m.get("C"));
  assert.ok(m.get("C") > m.get("D"));
  for (const k of ["A", "B", "C", "D"]) {
    assert.ok(m.get(k) >= 1 && m.get(k) <= 99);
  }
});

test("rankPercentiles excludes null values (they get rank null)", () => {
  const m = rankPercentiles([
    { key: "A", value: 100 },
    { key: "B", value: null },
    { key: "C", value: 10 },
  ]);
  assert.equal(m.get("B"), null);
  assert.ok(m.get("A") > m.get("C")); // ranked among the 2 valued
});

test("rankPercentiles handles all-null / empty", () => {
  assert.equal(rankPercentiles([{ key: "A", value: null }]).get("A"), null);
  assert.equal(rankPercentiles([]).size, 0);
});

// --- sectorStrengthPercentiles (gp-2.0.0 sectorStrength input) -------------------

test("sectorStrengthPercentiles ranks sectors by mean rsRaw, strongest highest", () => {
  const m = sectorStrengthPercentiles([
    { sector: "Tech", rsRaw: 90 },
    { sector: "Tech", rsRaw: 70 },
    { sector: "Tech", rsRaw: 80 }, // mean 80
    { sector: "Energy", rsRaw: 10 },
    { sector: "Energy", rsRaw: 20 },
    { sector: "Energy", rsRaw: 0 }, // mean 10
  ]);
  assert.ok(m.get("Tech") > m.get("Energy"));
  for (const s of ["Tech", "Energy"]) assert.ok(m.get(s) >= 1 && m.get(s) <= 99);
});

test("sectorStrengthPercentiles excludes undersized sectors (<3 names) → not in map", () => {
  const m = sectorStrengthPercentiles([
    { sector: "Tech", rsRaw: 90 },
    { sector: "Tech", rsRaw: 70 },
    { sector: "Tech", rsRaw: 80 },
    { sector: "Materials", rsRaw: 99 }, // only 1 name → undersized
    { sector: "Comm", rsRaw: 50 },
    { sector: "Comm", rsRaw: 60 }, // only 2 names → undersized
  ]);
  assert.ok(typeof m.get("Tech") === "number"); // qualifies (3)
  assert.equal(m.get("Materials"), undefined); // absent → caller treats as neutral 0
  assert.equal(m.get("Comm"), undefined);
});

test("sectorStrengthPercentiles ignores null-sector and non-numeric rsRaw items", () => {
  const m = sectorStrengthPercentiles([
    { sector: null, rsRaw: 90 },
    { sector: "Tech", rsRaw: 90 },
    { sector: "Tech", rsRaw: null },
    { sector: "Tech", rsRaw: 80 },
    { sector: "Tech", rsRaw: 70 }, // 3 valid Tech rsRaw → qualifies
  ]);
  assert.ok(typeof m.get("Tech") === "number");
  assert.equal(m.size, 1); // only Tech; null-sector item dropped
});

test("sectorStrengthPercentiles with a custom minNames", () => {
  const m = sectorStrengthPercentiles(
    [
      { sector: "Tech", rsRaw: 90 },
      { sector: "Tech", rsRaw: 80 },
      { sector: "Energy", rsRaw: 10 },
      { sector: "Energy", rsRaw: 20 },
    ],
    2
  );
  assert.ok(typeof m.get("Tech") === "number");
  assert.ok(typeof m.get("Energy") === "number");
});
