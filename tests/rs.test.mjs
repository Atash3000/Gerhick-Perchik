import { test } from "node:test";
import assert from "node:assert/strict";
import { rsRaw, rsVsSpy, rankPercentiles } from "../lambdas/shared/rs.mjs";

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
