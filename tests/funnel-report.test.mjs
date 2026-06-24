import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFunnelReport } from "../lambdas/funnel-report/report.mjs";

// A fresh scan day and the timestamp its rows were written at.
const SCAN_DAY = "2026-06-25";
const SCANNED_AT = "2026-06-25T23:35:00Z";
const SIX_HOURS = 6 * 60 * 60 * 1000;

// Helpers to build snapshot rows in the gp-snapshots shape (as the document client
// returns them — plain JS objects).
function snap(over = {}) {
  return {
    pk: `TICKER#${over.ticker ?? "X"}`,
    ticker: over.ticker ?? "X",
    dataAsOf: SCAN_DAY,
    scannedAt: SCANNED_AT,
    decision: "NO_SIGNAL",
    reason: null,
    score: null,
    gates: null,
    targetType: null,
    strategyVersion: "gp-2.0.0",
    ...over,
  };
}

// A representative one-scan fixture exercising every branch.
function fixtureSnapshots() {
  return [
    // reached scoring, candidate
    snap({ ticker: "A", decision: "BUY_CANDIDATE", score: 70, targetType: "PROJECTED_ATR",
      gates: { marketRegime: true, news: true, earnings: true, trend: true, validRisk: true, targetAbovePrice: true, riskReward: true, correlation: true } }),
    // reached scoring, below threshold (NOT a gate rejection)
    snap({ ticker: "B", decision: "NO_SIGNAL", score: 45, reason: "all gates passed; score 45 < threshold 53",
      targetType: "RESISTANCE_FLOORED_BY_PROJECTED_ATR",
      gates: { marketRegime: true, news: true, earnings: true, trend: true, validRisk: true, targetAbovePrice: true, riskReward: true, correlation: true } }),
    // gate-rejected at trend
    snap({ ticker: "C", decision: "NO_SIGNAL", reason: "price not above 200MA",
      gates: { marketRegime: true, news: true, earnings: true, trend: false } }),
    // gate-rejected at riskReward — note: targetType metadata IS attached at R:R rejection
    snap({ ticker: "D", decision: "NO_SIGNAL", reason: "R:R 1.2 < min 2", targetType: "RESISTANCE",
      gates: { marketRegime: true, news: true, earnings: true, trend: true, validRisk: true, targetAbovePrice: true, riskReward: false } }),
    // gate-rejected at marketRegime
    snap({ ticker: "E", decision: "NO_SIGNAL", reason: "SPY below 200MA",
      gates: { marketRegime: false } }),
    // NO_DATA (stale) — excluded from fresh coverage
    snap({ ticker: "F", decision: "NO_DATA", reason: "stale or missing market data", gates: null }),
    // pathological: NO_SIGNAL with no false gate → must land in `unrecognized`, never dropped
    snap({ ticker: "G", decision: "NO_SIGNAL", reason: "weird", gates: { marketRegime: true, news: true } }),
    // an OLDER scan day — must be excluded by latest-scan selection
    snap({ ticker: "OLD", dataAsOf: "2026-06-24", scannedAt: "2026-06-24T23:35:00Z",
      decision: "BUY_CANDIDATE", score: 99, targetType: "PROJECTED_ATR" }),
  ];
}

function fixtureOutcomes() {
  return [
    { ticker: "A", status: "OPEN", entryDate: SCAN_DAY },       // newly opened this scan
    { ticker: "P", status: "OPEN", entryDate: "2026-06-20" },   // older open
    { ticker: "Q", status: "CLOSED", entryDate: "2026-06-10" }, // closed
  ];
}

const CONFIG = { buyScoreThreshold: 53, strategyVersion: "gp-2.0.0" };
const NOW_FRESH = Date.parse("2026-06-26T00:10:00Z"); // 35 min after SCANNED_AT

function build(over = {}) {
  return buildFunnelReport({
    snapshots: over.snapshots ?? fixtureSnapshots(),
    outcomes: over.outcomes ?? fixtureOutcomes(),
    config: over.config ?? CONFIG,
    nowMs: over.nowMs ?? NOW_FRESH,
    freshWindowMs: over.freshWindowMs ?? SIX_HOURS,
  });
}

test("latest-scan selection: only the newest dataAsOf is reported", () => {
  const r = build();
  assert.equal(r.dataAsOf, SCAN_DAY);
  // OLD (2026-06-24, score 99) must be excluded — it would top the list if leaked.
  assert.ok(!r.counts.topScored.some((s) => s.ticker === "OLD"));
  assert.equal(r.counts.watchlist, 7); // A..G, not OLD
});

test("gate-breakdown PARTITIONS NO_SIGNAL: sum(buckets)+belowThreshold+unrecognized == total, no double-count", () => {
  const gb = build().counts.gateBreakdown;
  // NO_SIGNAL rows in the latest scan: B, C, D, E, G = 5
  assert.equal(gb.totalNoSignal, 5);
  const bucketSum = Object.values(gb.byGate).reduce((a, b) => a + b, 0);
  assert.equal(bucketSum + gb.belowThreshold + gb.unrecognized, gb.totalNoSignal);
  // each gate-rejected name in exactly one bucket
  assert.deepEqual(gb.byGate, { trend: 1, riskReward: 1, marketRegime: 1 });
  assert.equal(gb.belowThreshold, 1); // B reached scoring — NOT a gate rejection
  assert.equal(gb.unrecognized, 1);   // G has no false gate — caught, not dropped
});

test("below-threshold names are NOT counted as gate rejections", () => {
  const gb = build().counts.gateBreakdown;
  // B (score 45) must not appear under any gate bucket.
  assert.ok(!Object.keys(gb.byGate).includes("riskReward") || gb.byGate.riskReward === 1); // only D
  assert.equal(gb.belowThreshold, 1);
});

test("unrecognized catches a NO_SIGNAL with no single false gate (nothing dropped)", () => {
  // Two pathological rows: one all-true, one with two false gates.
  const snaps = [
    snap({ ticker: "Z1", decision: "NO_SIGNAL", gates: { marketRegime: true, trend: true } }),
    snap({ ticker: "Z2", decision: "NO_SIGNAL", gates: { trend: false, riskReward: false } }),
  ];
  const gb = build({ snapshots: snaps, outcomes: [] }).counts.gateBreakdown;
  assert.equal(gb.totalNoSignal, 2);
  assert.equal(gb.unrecognized, 2);
  assert.equal(Object.values(gb.byGate).reduce((a, b) => a + b, 0), 0);
});

test("reaching-scoring, BUY_CANDIDATE, fresh coverage, watchlist counts", () => {
  const c = build().counts;
  assert.equal(c.reachingScoring, 2);   // A, B (score != null)
  assert.equal(c.buyCandidates, 1);     // A
  assert.equal(c.watchlist, 7);         // A..G distinct
  assert.equal(c.freshCoverage.noData, 1);
  assert.equal(c.freshCoverage.fresh, 6);
  assert.equal(c.freshCoverage.total, 7);
  assert.equal(c.freshCoverage.pct, 85.7); // 6/7
});

test("targetType distribution counts only rows where targetType != null", () => {
  const tt = build().counts.targetTypes;
  // A(PROJECTED_ATR), B(RESISTANCE_FLOORED), D(RESISTANCE) — D counts despite score null.
  assert.deepEqual(tt, {
    RESISTANCE: 1,
    PROJECTED_ATR: 1,
    RESISTANCE_FLOORED_BY_PROJECTED_ATR: 1,
  });
});

test("top scored: desc by score, score==null excluded", () => {
  const top = build().counts.topScored;
  assert.deepEqual(top.map((s) => s.ticker), ["A", "B"]);
  assert.equal(top[0].score, 70);
  assert.equal(top[0].decision, "BUY_CANDIDATE");
});

test("outcome counts: cumulative open/closed + newly opened by entryDate", () => {
  const o = build().counts.outcomes;
  assert.equal(o.open, 2);        // A, P
  assert.equal(o.closed, 1);      // Q
  assert.equal(o.newlyOpened, 1); // A (entryDate == latest scan day)
});

test("fresh-scan gate: recent scannedAt → isFreshScan true; stale → false", () => {
  assert.equal(build().isFreshScan, true);
  const stale = build({ nowMs: Date.parse("2026-06-27T00:10:00Z") }); // ~24h later
  assert.equal(stale.isFreshScan, false);
});

test("report text carries the OBSERVE disclaimer, version, threshold, and key numbers", () => {
  const r = build();
  assert.match(r.text, /OBSERVE/);
  assert.match(r.text, /gp-2\.0\.0/);
  assert.match(r.text, /53/);          // threshold
  assert.match(r.text, /2026-06-25/);  // dataAsOf
  assert.doesNotMatch(r.text, /\bBUY\b(?!_CANDIDATE)/); // no bare "BUY" recommendation
});

test("stale scan produces a short skip message, not a full report", () => {
  const r = build({ nowMs: Date.parse("2026-06-27T00:10:00Z") });
  assert.equal(r.isFreshScan, false);
  assert.match(r.text, /no new scan/i);
});

// --- Redesign: Score Distribution + Top Sectors + dashboard text ---
// Candidates spread across score bands and sectors (all gates pass).
function cand(ticker, score, sector) {
  return snap({
    ticker, decision: "BUY_CANDIDATE", score, sector, targetType: "PROJECTED_ATR",
    gates: { marketRegime: true, news: true, earnings: true, trend: true, validRisk: true, targetAbovePrice: true, riskReward: true, correlation: true },
  });
}
function distroSnapshots() {
  return [
    cand("H1", 75, "Financials"),   // high
    cand("H2", 72, "Financials"),   // high
    cand("M1", 65, "Financials"),   // mid
    cand("M2", 62, "Industrials"),  // mid
    cand("L1", 55, "Industrials"),  // low
    cand("L2", 54, "RealEstate"),   // low
    // below-threshold scored name — must NOT count in candidate distribution
    snap({ ticker: "BT", decision: "NO_SIGNAL", score: 50,
      gates: { marketRegime: true, news: true, earnings: true, trend: true, validRisk: true, targetAbovePrice: true, riskReward: true, correlation: true } }),
  ];
}

test("scoreDistribution: candidates bucketed into high/mid/low, sums to buyCandidates", () => {
  const c = build({ snapshots: distroSnapshots() }).counts;
  assert.deepEqual(
    { high: c.scoreDistribution.high, mid: c.scoreDistribution.mid, low: c.scoreDistribution.low },
    { high: 2, mid: 2, low: 2 }
  );
  assert.equal(c.scoreDistribution.lowFloor, 53); // tracks threshold
  assert.equal(c.scoreDistribution.high + c.scoreDistribution.mid + c.scoreDistribution.low, c.buyCandidates);
});

test("scoreDistribution excludes below-threshold scored names", () => {
  const c = build({ snapshots: distroSnapshots() }).counts;
  assert.equal(c.buyCandidates, 6); // BT (score 50) is NOT a candidate
});

test("sectorBreakdown: candidates counted by sector, desc, null→Unknown", () => {
  const snaps = distroSnapshots();
  snaps.push(cand("U1", 80, null)); // unknown sector
  const c = build({ snapshots: snaps }).counts;
  assert.deepEqual(c.sectorBreakdown, [
    { sector: "Financials", count: 3 },
    { sector: "Industrials", count: 2 },
    { sector: "RealEstate", count: 1 },
    { sector: "Unknown", count: 1 },
  ]);
});

test("redesigned text contains the new dashboard sections", () => {
  const t = build({ snapshots: distroSnapshots() }).text;
  assert.match(t, /Daily Funnel/);
  assert.match(t, /📊 Score Distribution/);
  assert.match(t, /70\+:\s*2/);
  assert.match(t, /60–69:\s*2/);
  assert.match(t, /53–59:\s*2/);
  assert.match(t, /🏭 Top Sectors/);
  assert.match(t, /Financials:\s*3/);
  assert.match(t, /Real Estate/); // camel-case prettified
  assert.match(t, /🎯 Target Types/);
});

test("gate rejections render with friendly labels", () => {
  const t = build().text; // shared fixture: trend, riskReward, marketRegime false
  assert.match(t, /Trend <200MA:/);
  assert.match(t, /R:R too low:/);
  assert.match(t, /SPY <200MA:/);
  assert.match(t, /Below score:/);
});

test("liquidity gate rejections render under the friendly 'Liquidity' label", () => {
  const snaps = [
    snap({ ticker: "ILQ", decision: "NO_SIGNAL", reason: "illiquid",
      gates: { marketRegime: true, news: true, liquidity: false } }),
  ];
  const t = build({ snapshots: snaps }).text;
  assert.match(t, /Liquidity: 1/);
});

test("Top Sectors section omitted when there are 0 candidates", () => {
  const noCands = [
    snap({ ticker: "C", decision: "NO_SIGNAL", reason: "trend", gates: { marketRegime: true, news: true, earnings: true, trend: false } }),
  ];
  const t = build({ snapshots: noCands }).text;
  assert.doesNotMatch(t, /🏭 Top Sectors/);
});
