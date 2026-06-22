import { test } from "node:test";
import assert from "node:assert/strict";
import { assessScanHealth } from "../lambdas/scanner/handler.mjs";

test("healthy scan: snapshots written, low error rate", () => {
  const h = assessScanHealth({ scanned: 43, snapshotsWritten: 41, errorCount: 2 });
  assert.equal(h.healthy, true);
  assert.equal(h.reason, null);
});

test("degraded: zero snapshots (e.g. feed rate-limited every name)", () => {
  const h = assessScanHealth({ scanned: 43, snapshotsWritten: 0, errorCount: 43 });
  assert.equal(h.healthy, false);
  assert.match(h.reason, /no snapshots/);
});

test("degraded: error rate >= 50%", () => {
  const h = assessScanHealth({ scanned: 40, snapshotsWritten: 18, errorCount: 22 });
  assert.equal(h.healthy, false);
  assert.match(h.reason, /error rate/);
});

test("just under the error threshold is healthy", () => {
  const h = assessScanHealth({ scanned: 40, snapshotsWritten: 21, errorCount: 19 });
  assert.equal(h.healthy, true);
});

test("empty watchlist is not flagged as degraded", () => {
  const h = assessScanHealth({ scanned: 0, snapshotsWritten: 0, errorCount: 0 });
  assert.equal(h.healthy, true);
});
