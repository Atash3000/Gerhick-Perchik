import { test } from "node:test";
import assert from "node:assert/strict";
import { constructBook } from "../lambdas/shared/portfolio.mjs";

const CFG = { targetPositions: 15, maxPositions: 20 };
const ALLOW = { blockNewBuys: false, haltAllNew: false };

// Minimal ranked rows (constructBook only needs ticker + inEntryZone + rank order).
function ranked(specs) {
  return specs.map((s, i) => ({ ticker: s.t, rank: i + 1, inEntryZone: s.entry }));
}

test("constructBook: fills open slots from the top entry-zone names, strongest first", () => {
  const r = ranked([
    { t: "AAA", entry: true },
    { t: "BBB", entry: true },
    { t: "CCC", entry: true },
    { t: "DDD", entry: false }, // below entry zone — never bought
  ]);
  const out = constructBook(r, new Set(), ALLOW, { targetPositions: 2, maxPositions: 20 });
  assert.equal(out.blocked, false);
  assert.equal(out.slots, 2);
  assert.deepEqual(out.buys.map((b) => b.ticker), ["AAA", "BBB"]); // top 2 entry-zone, in rank order
});

test("constructBook: zero eligible / zero entry-zone → no buys (sit in cash)", () => {
  assert.deepEqual(constructBook([], new Set(), ALLOW, CFG).buys, []);
  const noneInZone = ranked([{ t: "AAA", entry: false }, { t: "BBB", entry: false }]);
  assert.deepEqual(constructBook(noneInZone, new Set(), ALLOW, CFG).buys, []);
});

test("constructBook: the risk governor blocking new buys → buys nothing", () => {
  const r = ranked([{ t: "AAA", entry: true }, { t: "BBB", entry: true }]);
  const out = constructBook(r, new Set(), { blockNewBuys: true, reason: "weekly drawdown" }, CFG);
  assert.equal(out.blocked, true);
  assert.deepEqual(out.buys, []);
  assert.match(out.reason, /drawdown/);
});

test("constructBook: already-held tickers are NEVER reopened (open-once guard)", () => {
  const r = ranked([
    { t: "AAA", entry: true }, // held
    { t: "BBB", entry: true },
    { t: "CCC", entry: true },
  ]);
  const out = constructBook(r, new Set(["AAA"]), ALLOW, { targetPositions: 5, maxPositions: 20 });
  assert.deepEqual(out.buys.map((b) => b.ticker), ["BBB", "CCC"]); // AAA skipped
});

test("constructBook: slots = targetPositions − held; a full book buys nothing", () => {
  const r = ranked([{ t: "NEW1", entry: true }, { t: "NEW2", entry: true }]);
  // Already holding the target number → no slots.
  const held = new Set(["H1", "H2", "H3"]);
  const out = constructBook(r, held, ALLOW, { targetPositions: 3, maxPositions: 20 });
  assert.equal(out.slots, 0);
  assert.deepEqual(out.buys, []);
});

test("constructBook: never exceeds the slot count even with many entry-zone names", () => {
  const r = ranked(Array.from({ length: 30 }, (_, i) => ({ t: `T${i}`, entry: true })));
  const out = constructBook(r, new Set(["H1"]), ALLOW, { targetPositions: 15, maxPositions: 20 });
  assert.equal(out.slots, 14); // 15 target − 1 held
  assert.equal(out.buys.length, 14);
});
