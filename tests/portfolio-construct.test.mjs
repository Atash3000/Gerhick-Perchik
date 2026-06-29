import { test } from "node:test";
import assert from "node:assert/strict";
import { constructBook } from "../lambdas/shared/portfolio.mjs";

const CFG = { targetPositions: 15, maxPositions: 20 };
const ALLOW = { blockNewBuys: false, haltAllNew: false };

// Minimal ranked rows (constructBook only needs ticker + inEntryZone + rank order).
function ranked(specs) {
  return specs.map((s, i) => ({ ticker: s.t, rank: i + 1, inEntryZone: s.entry }));
}

// constructBook returns the ORDERED CANDIDATE POOL (entry-zone, not held) + the slot
// count. The actual fill — taking `slots`, skipping unsizable, backfilling — is
// planScan's job (tested in orchestrate.test.mjs). #85.

test("constructBook: returns the entry-zone candidate pool in rank order + the slot count", () => {
  const r = ranked([
    { t: "AAA", entry: true },
    { t: "BBB", entry: true },
    { t: "CCC", entry: true },
    { t: "DDD", entry: false }, // below entry zone — never a candidate
  ]);
  const out = constructBook(r, new Set(), ALLOW, { targetPositions: 2, maxPositions: 20 });
  assert.equal(out.blocked, false);
  assert.equal(out.slots, 2);
  assert.deepEqual(out.candidates.map((c) => c.ticker), ["AAA", "BBB", "CCC"]); // all entry-zone, rank order; DDD excluded
});

test("constructBook: zero eligible / zero entry-zone → empty pool", () => {
  assert.deepEqual(constructBook([], new Set(), ALLOW, CFG).candidates, []);
  const noneInZone = ranked([{ t: "AAA", entry: false }, { t: "BBB", entry: false }]);
  assert.deepEqual(constructBook(noneInZone, new Set(), ALLOW, CFG).candidates, []);
});

test("constructBook: the risk governor blocking new buys → blocked, empty pool", () => {
  const r = ranked([{ t: "AAA", entry: true }, { t: "BBB", entry: true }]);
  const out = constructBook(r, new Set(), { blockNewBuys: true, reason: "weekly drawdown" }, CFG);
  assert.equal(out.blocked, true);
  assert.deepEqual(out.candidates, []);
  assert.match(out.reason, /drawdown/);
});

test("constructBook: already-held tickers are excluded from the pool (open-once guard)", () => {
  const r = ranked([
    { t: "AAA", entry: true }, // held
    { t: "BBB", entry: true },
    { t: "CCC", entry: true },
  ]);
  const out = constructBook(r, new Set(["AAA"]), ALLOW, { targetPositions: 5, maxPositions: 20 });
  assert.deepEqual(out.candidates.map((c) => c.ticker), ["BBB", "CCC"]); // AAA excluded
});

test("constructBook: slots = targetPositions − held; a full book → slots 0", () => {
  const r = ranked([{ t: "NEW1", entry: true }, { t: "NEW2", entry: true }]);
  const out = constructBook(r, new Set(["H1", "H2", "H3"]), ALLOW, { targetPositions: 3, maxPositions: 20 });
  assert.equal(out.slots, 0);
});

test("constructBook: the pool is NOT truncated to slots (so the caller can backfill)", () => {
  const r = ranked(Array.from({ length: 30 }, (_, i) => ({ t: `T${i}`, entry: true })));
  const out = constructBook(r, new Set(["H1"]), ALLOW, { targetPositions: 15, maxPositions: 20 });
  assert.equal(out.slots, 14); // 15 target − 1 held
  assert.equal(out.candidates.length, 30); // full pool returned, NOT capped at 14 — backfill headroom
});
