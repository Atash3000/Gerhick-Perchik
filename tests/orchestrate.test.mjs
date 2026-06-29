import { test } from "node:test";
import assert from "node:assert/strict";
import { planScan, executePlan } from "../lambdas/scanner/orchestrate.mjs";

// --- helpers ---------------------------------------------------------------

const CFG = {
  targetPositions: 2, maxPositions: 20,
  kStop: 2.5, riskPctPerTrade: 0.75, positionCapPct: 15,
  feeBps: 10, slippageBps: 5, // round-trip cost 0.30%
  entryRankPct: 20, exitRankPct: 30,
};
const ACCOUNT = 100_000;
const PARAMS = { kStop: 2.5, regimeMa: 200 }; // a params block (shape doesn't matter here)

const bar = (date, high, low, close) => ({ date, open: close, high, low, close, volume: 1_000_000 });

// A fresh momentum-data view with a small bar history (last bar drives exits).
function md({ close, atr = 4, ma100 = 50, bars, dataAsOf = "2026-06-26" }) {
  return { fresh: true, close, atr, ma100, bars: bars ?? [bar(dataAsOf, close * 1.01, close * 0.99, close)], dataAsOf };
}
const elig = (eligible = true) => ({
  eligible, insufficientHistory: false,
  checks: { price: true, dollarVol: true, trend: eligible, noBigMove: true },
});
const rankRow = (ticker, rank, { entry = false, exit = false, momentum = 1 } = {}) => ({
  ticker, rank, rankPct: 99 - rank, inEntryZone: entry, inExitZone: exit, momentum, slope: 0.001, r2: 0.9,
});

function fakeStore() {
  const calls = { snap: [], open: [], close: [], refresh: [] };
  return {
    calls,
    async writeMomentumSnapshot(result, opts) { calls.snap.push({ result, opts }); return {}; },
    async openMomentumOutcome(result, opts) { calls.open.push({ result, opts }); return { opened: true }; },
    async closeOutcome(pk, sk, fields) { calls.close.push({ pk, sk, fields }); return { closed: true }; },
    async updateOpenPosition(pk, sk, fields) { calls.refresh.push({ pk, sk, fields }); return { updated: true }; },
  };
}

// --- INVARIANT 1: exits run before fills (a freed slot refills the same run) ---

test("exits-before-fills: a rank-exited holding frees a slot that is refilled the SAME run", () => {
  // target 2 positions. Holding A (rank-exits) + B (holds). C is a fresh top-rank buy.
  const gathered = [
    { ticker: "A", sector: "Tech", md: md({ close: 100, ma100: 50 }), eligibility: elig() },
    { ticker: "B", sector: "Tech", md: md({ close: 100, ma100: 50 }), eligibility: elig() },
    { ticker: "C", sector: "Tech", md: md({ close: 100, ma100: 50 }), eligibility: elig() },
  ];
  const ranked = [
    rankRow("B", 1, { entry: true }),
    rankRow("C", 2, { entry: true }),
    rankRow("A", 9, { exit: true }), // A fell out of the top → rank exit
  ];
  const open = [
    { pk: "S#A", sk: 1, ticker: "A", entry: 100, stop: 90, peakClose: 100, entryDate: "2026-06-01" },
    { pk: "S#B", sk: 2, ticker: "B", entry: 100, stop: 90, peakClose: 100, entryDate: "2026-06-01" },
  ];
  const plan = planScan({
    config: CFG, regimeOn: true, asOf: "2026-06-26", gathered, ranked,
    openOutcomes: open, governor: { blockNewBuys: false }, accountValue: ACCOUNT,
  });

  assert.deepEqual(plan.exits.map((e) => e.ticker), ["A"]); // A rank-exited
  assert.deepEqual(plan.buys.map((b) => b.result.ticker), ["C"]); // freed slot → C bought same run
  assert.deepEqual(plan.refreshes.map((r) => r.ticker), ["B"]); // B held → trail refreshed
});

// --- INVARIANT 2: scanner-closed rank/trend exits are AFTER-COST ----------------

test("scanner-closed rank exit records an after-cost profitPct (same cost math as the labeler)", () => {
  const gathered = [{ ticker: "A", sector: "Tech", md: md({ close: 120, ma100: 50, bars: [
    bar("2026-06-10", 110, 100, 105), bar("2026-06-26", 125, 118, 120),
  ] }), eligibility: elig() }];
  const ranked = [rankRow("A", 9, { exit: true })];
  const open = [{ pk: "S#A", sk: 1, ticker: "A", entry: 100, stop: 90, peakClose: 105, entryDate: "2026-06-01" }];

  const plan = planScan({
    config: CFG, regimeOn: true, asOf: "2026-06-26", gathered, ranked,
    openOutcomes: open, governor: { blockNewBuys: false }, accountValue: ACCOUNT,
  });

  const ex = plan.exits[0];
  assert.equal(ex.fields.outcome, "EXIT");
  assert.equal(ex.fields.exitReason, "rank_exit");
  // exit at close 120; gross +20%; round-trip cost 0.30% → 19.7 after cost.
  assert.equal(ex.fields.profitPct, 19.7);
  assert.equal(typeof ex.fields.mfePct, "number"); // excursion recorded too
});

// --- INVARIANT 3: snapshotsOnly suppresses outcomes + alerts --------------------

test("snapshotsOnly: writes snapshots, opens NO outcomes, closes NONE, refreshes NONE, alerts NONE", async () => {
  const plan = {
    snapshots: [{ result: { ticker: "A", dataAsOf: "2026-06-26" }, sector: "T", marketData: {} }],
    refreshes: [{ pk: "S#B", sk: 1, stop: 91, peakClose: 101 }],
    exits: [{ pk: "S#C", sk: 1, fields: { outcome: "EXIT" } }],
    buys: [{ result: { ticker: "D" }, sector: "T" }],
  };
  const store = fakeStore();
  let alerts = 0;
  const r = await executePlan(plan, { store, sendAlert: async () => { alerts++; }, snapshotsOnly: true, scanId: "scan-1", params: PARAMS });

  assert.equal(store.calls.snap.length, 1); // snapshot written
  assert.equal(store.calls.open.length, 0); // NO outcomes opened
  assert.equal(store.calls.close.length, 0); // NO exits closed
  assert.equal(store.calls.refresh.length, 0); // NO refreshes
  assert.equal(alerts, 0); // NO alerts
  assert.equal(r.snapshotsOnly, true);
});

test("normal run (snapshotsOnly off): opens/closes/refreshes + alerts; passes scanId+params to the writers", async () => {
  const plan = {
    snapshots: [{ result: { ticker: "A", dataAsOf: "2026-06-26" }, sector: "T", marketData: {} }],
    refreshes: [{ pk: "S#B", sk: 1, stop: 91, peakClose: 101 }],
    exits: [{ pk: "S#C", sk: 1, fields: { outcome: "EXIT" } }],
    buys: [{ result: { ticker: "D" }, sector: "T" }],
  };
  const store = fakeStore();
  let alerts = 0;
  await executePlan(plan, { store, sendAlert: async () => { alerts++; }, snapshotsOnly: false, scanId: "scan-1", params: PARAMS });

  assert.equal(store.calls.open.length, 1);
  assert.equal(store.calls.close.length, 1);
  assert.equal(store.calls.refresh.length, 1);
  assert.equal(alerts, 1);
  // #5: scanId + params actually reach the snapshot writer.
  assert.equal(store.calls.snap[0].opts.scanId, "scan-1");
  assert.deepEqual(store.calls.snap[0].opts.params, PARAMS);
  assert.equal(store.calls.open[0].opts.scanId, "scan-1");
});

// --- INVARIANT 5: executePlan fails loud if scanId/params missing ---------------

test("executePlan fails loud when scanId or params is missing (self-describing rows guaranteed)", async () => {
  const plan = { snapshots: [], refreshes: [], exits: [], buys: [] };
  const store = fakeStore();
  await assert.rejects(() => executePlan(plan, { store, snapshotsOnly: true, params: PARAMS }), /scanId/);
  await assert.rejects(() => executePlan(plan, { store, snapshotsOnly: true, scanId: "s" }), /params/);
});

// --- supporting: snapshot decision classes -------------------------------------

test("planScan classifies every name: HOLD, EXIT, BUY_CANDIDATE, NOT_ELIGIBLE, REGIME_OFF, NO_DATA", () => {
  const gathered = [
    { ticker: "HELD", sector: "T", md: md({ close: 100, ma100: 50 }), eligibility: elig() },
    { ticker: "GONE", sector: "T", md: md({ close: 100, ma100: 50 }), eligibility: elig() },
    { ticker: "BUY", sector: "T", md: md({ close: 100, ma100: 50 }), eligibility: elig() },
    { ticker: "INELIG", sector: "T", md: md({ close: 100, ma100: 120 }), eligibility: elig(false) }, // below trend
    { ticker: "NODATA", sector: "T", md: { fresh: false, reason: "stale" }, eligibility: { eligible: false } },
  ];
  const ranked = [rankRow("HELD", 1, { entry: true }), rankRow("BUY", 2, { entry: true }), rankRow("GONE", 9, { exit: true })];
  const open = [
    { pk: "S#HELD", sk: 1, ticker: "HELD", entry: 100, stop: 90, peakClose: 100, entryDate: "2026-06-01" },
    { pk: "S#GONE", sk: 1, ticker: "GONE", entry: 100, stop: 90, peakClose: 100, entryDate: "2026-06-01" },
  ];
  const plan = planScan({ config: CFG, regimeOn: true, asOf: "2026-06-26", gathered, ranked, openOutcomes: open, governor: { blockNewBuys: false }, accountValue: ACCOUNT });
  const dec = Object.fromEntries(plan.snapshots.map((s) => [s.result.ticker, s.result.decision]));
  assert.equal(dec.HELD, "HOLD");
  assert.equal(dec.GONE, "EXIT");
  assert.equal(dec.BUY, "BUY_CANDIDATE");
  assert.equal(dec.INELIG, "NOT_ELIGIBLE");
  assert.equal(dec.NODATA, "NO_DATA");
});

test("planScan: regime OFF → non-held eligible names are REGIME_OFF, holdings still managed", () => {
  const gathered = [
    { ticker: "NEW", sector: "T", md: md({ close: 100, ma100: 50 }), eligibility: elig() },
    { ticker: "HELD", sector: "T", md: md({ close: 100, ma100: 50 }), eligibility: elig() },
  ];
  const ranked = [rankRow("NEW", 1, { entry: true }), rankRow("HELD", 2, { entry: true })];
  const open = [{ pk: "S#HELD", sk: 1, ticker: "HELD", entry: 100, stop: 90, peakClose: 100, entryDate: "2026-06-01" }];
  const plan = planScan({ config: CFG, regimeOn: false, asOf: "2026-06-26", gathered, ranked, openOutcomes: open, governor: { blockNewBuys: false }, accountValue: ACCOUNT });
  const dec = Object.fromEntries(plan.snapshots.map((s) => [s.result.ticker, s.result.decision]));
  assert.equal(dec.NEW, "REGIME_OFF"); // no new buys in risk-off
  assert.equal(dec.HELD, "HOLD"); // existing position still managed
  assert.equal(plan.buys.length, 0); // nothing bought
});

// --- review round 4 fixes --------------------------------------------------

test("#1 decision: BUY_CANDIDATE = bought; eligible-but-not-bought = RANKED_NOT_BOUGHT", () => {
  const gathered = [
    { ticker: "BUY", sector: "T", md: md({ close: 100, ma100: 50 }), eligibility: elig() },
    { ticker: "NOSLOT", sector: "T", md: md({ close: 100, ma100: 50 }), eligibility: elig() },
    { ticker: "LOWRANK", sector: "T", md: md({ close: 100, ma100: 50 }), eligibility: elig() },
  ];
  const ranked = [
    rankRow("BUY", 1, { entry: true }),
    rankRow("NOSLOT", 2, { entry: true }), // entry zone but no slot (target 1)
    rankRow("LOWRANK", 5, { entry: false }), // eligible, below entry rank
  ];
  const plan = planScan({
    config: { ...CFG, targetPositions: 1 }, regimeOn: true, asOf: "2026-06-26",
    gathered, ranked, openOutcomes: [], governor: { blockNewBuys: false }, accountValue: ACCOUNT,
  });
  const dec = Object.fromEntries(plan.snapshots.map((s) => [s.result.ticker, s.result.decision]));
  assert.equal(dec.BUY, "BUY_CANDIDATE"); // ONLY the actually-opened position
  assert.equal(dec.NOSLOT, "RANKED_NOT_BOUGHT");
  assert.equal(dec.LOWRANK, "RANKED_NOT_BOUGHT");
  assert.deepEqual(plan.buys.map((b) => b.result.ticker), ["BUY"]);
});

test("#2 spy context: planScan stamps the SPY block onto every snapshot (not spy:null)", () => {
  const spy = { spyBelow200ma: false, asOf: "2026-06-26", return126d: 12.1 };
  const gathered = [{ ticker: "A", sector: "T", md: md({ close: 100, ma100: 50 }), eligibility: elig() }];
  const plan = planScan({
    config: CFG, regimeOn: true, asOf: "2026-06-26", gathered,
    ranked: [rankRow("A", 1, { entry: true })], openOutcomes: [], governor: { blockNewBuys: false },
    accountValue: ACCOUNT, spy,
  });
  assert.deepEqual(plan.snapshots[0].spy, spy);
});

test("#3 counters: executePlan counts only truthy updated/closed returns (honest tally)", async () => {
  const plan = {
    snapshots: [],
    refreshes: [{ pk: "a", sk: 1, stop: 1, peakClose: 1 }, { pk: "b", sk: 1, stop: 1, peakClose: 1 }],
    exits: [{ pk: "c", sk: 1, fields: {} }, { pk: "d", sk: 1, fields: {} }],
    buys: [],
  };
  let nRef = 0, nClose = 0;
  const store = {
    async writeMomentumSnapshot() { return {}; },
    async updateOpenPosition() { nRef++; return { updated: nRef === 1 }; }, // 2nd skipped (closed-row guard)
    async closeOutcome() { nClose++; return { closed: nClose === 1 }; }, // 2nd skipped
    async openMomentumOutcome() { return { opened: true }; },
  };
  const r = await executePlan(plan, { store, snapshotsOnly: false, scanId: "s", params: PARAMS });
  assert.equal(r.refreshed, 1); // only the truthy update counted
  assert.equal(r.exitsClosed, 1);
});

test("alert failure is BEST-EFFORT: a Telegram throw doesn't fail the scan or block later buys", async () => {
  const plan = {
    snapshots: [],
    refreshes: [],
    exits: [],
    buys: [{ result: { ticker: "A" }, sector: "T" }, { result: { ticker: "B" }, sector: "T" }],
  };
  const store = fakeStore();
  const r = await executePlan(plan, {
    store,
    sendAlert: async () => { throw new Error("telegram 503"); }, // every alert fails
    snapshotsOnly: false, scanId: "s", params: PARAMS,
  });
  // BOTH outcomes still opened (alert failure didn't abort the loop or throw).
  assert.equal(store.calls.open.length, 2);
  assert.equal(r.outcomesOpened, 2);
  assert.equal(r.alertsSent, 0);
  assert.equal(r.alertErrors, 2); // counted, not fatal
});
