import { test } from "node:test";
import assert from "node:assert/strict";
import { assessScanHealth, shouldOpenOutcome, createSectorCounter } from "../lambdas/scanner/handler.mjs";

test("createSectorCounter: seeds from open outcomes and counts by sector", () => {
  const c = createSectorCounter([
    { ticker: "MSFT", sector: "Technology" },
    { ticker: "NVDA", sector: "Technology" },
    { ticker: "XOM", sector: "Energy" },
    { ticker: "FOO" }, // no sector → "unknown"
  ]);
  assert.equal(c.count("Technology"), 2);
  assert.equal(c.count("Energy"), 1);
  assert.equal(c.count("unknown"), 1);
  assert.equal(c.count(null), 1); // null sector maps to "unknown"
  assert.equal(c.count("Healthcare"), 0); // unseen sector
});

test("createSectorCounter: add() increments so same-scan opens accrue toward the cap", () => {
  // The bug: a static count let multiple same-sector candidates in ONE scan all
  // pass a cap-3 gate. The counter must grow as outcomes open within the scan.
  const c = createSectorCounter([
    { ticker: "MSFT", sector: "Technology" },
    { ticker: "NVDA", sector: "Technology" },
  ]);
  assert.equal(c.count("Technology"), 2); // 2 < cap 3 → first candidate may open
  c.add("Technology"); // a new same-sector outcome opens this scan
  assert.equal(c.count("Technology"), 3); // now 3 → cap reached, next is rejected
  c.add(null); // unknown-sector open
  assert.equal(c.count("unknown"), 1);
});

test("shouldOpenOutcome: open a BUY_CANDIDATE only if no position already open", () => {
  const open = new Set(["MSFT"]);
  assert.equal(shouldOpenOutcome("BUY_CANDIDATE", "AAPL", open), true);  // new name
  assert.equal(shouldOpenOutcome("BUY_CANDIDATE", "MSFT", open), false); // already open → skip
  assert.equal(shouldOpenOutcome("NO_SIGNAL", "AAPL", open), false);     // not a candidate
  assert.equal(shouldOpenOutcome("NO_DATA", "AAPL", open), false);
});

test("healthy scan: snapshots written, low errors, full coverage", () => {
  const h = assessScanHealth({ expectedCount: 43, snapshotsWritten: 41, errorCount: 2, freshDataCount: 41 });
  assert.equal(h.healthy, true);
  assert.equal(h.reason, null);
});

test("degraded: zero snapshots (e.g. feed rate-limited every name)", () => {
  const h = assessScanHealth({ expectedCount: 43, snapshotsWritten: 0, errorCount: 43, freshDataCount: 0 });
  assert.equal(h.healthy, false);
  assert.match(h.reason, /no snapshots/);
});

test("degraded: error rate >= 50%", () => {
  const h = assessScanHealth({ expectedCount: 40, snapshotsWritten: 18, errorCount: 22, freshDataCount: 18 });
  assert.equal(h.healthy, false);
  assert.match(h.reason, /error rate/);
});

test("degraded: low fresh-data coverage (< 50%) even when snapshots were written", () => {
  // 40 names, 30 snapshots written but only 15 had fresh data (15 NO_DATA stale) →
  // 15 fresh + 15 noData snapshotted, errorCount low. Coverage 37.5% → degraded.
  const h = assessScanHealth({ expectedCount: 40, snapshotsWritten: 30, errorCount: 0, freshDataCount: 15 });
  assert.equal(h.healthy, false);
  assert.match(h.reason, /low coverage/);
});

test("coverage at/above 50% with low errors is healthy", () => {
  const h = assessScanHealth({ expectedCount: 40, snapshotsWritten: 40, errorCount: 0, freshDataCount: 21 });
  assert.equal(h.healthy, true);
});

test("just under the error threshold is healthy", () => {
  const h = assessScanHealth({ expectedCount: 40, snapshotsWritten: 21, errorCount: 19, freshDataCount: 21 });
  assert.equal(h.healthy, true);
});

test("empty watchlist is not flagged as degraded", () => {
  const h = assessScanHealth({ expectedCount: 0, snapshotsWritten: 0, errorCount: 0, freshDataCount: 0 });
  assert.equal(h.healthy, true);
});

test("freshDataCount omitted → coverage check skipped (back-compat)", () => {
  const h = assessScanHealth({ expectedCount: 43, snapshotsWritten: 41, errorCount: 2 });
  assert.equal(h.healthy, true);
});
