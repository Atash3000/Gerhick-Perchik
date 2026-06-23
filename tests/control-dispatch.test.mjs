import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../lambdas/control/handler.mjs";

// A fake store recording calls; configurable returns.
function fakeStore(overrides = {}) {
  const calls = { createPosition: [], recordSell: [], recordDecision: [], claimUpdateId: [] };
  return {
    calls,
    claimedSeq: overrides.claimedSeq ?? [true],
    _claimIdx: 0,
    async claimUpdateId(id, ttl) {
      calls.claimUpdateId.push({ id, ttl });
      const v = this.claimedSeq[Math.min(this._claimIdx, this.claimedSeq.length - 1)];
      this._claimIdx += 1;
      return { claimed: v };
    },
    async getOpenPosition() { return overrides.openPosition ?? null; },
    async findLatestOpenOutcome() { return overrides.linkedOutcome ?? null; },
    async createPosition(h, b) { calls.createPosition.push({ h, b }); return { created: true }; },
    async recordSell(h, r) { calls.recordSell.push({ h, r }); return { recorded: true }; },
    async recordDecision(d) { calls.recordDecision.push(d); return { recorded: true }; },
    async listOpenPositions() { return overrides.openPositions ?? []; },
  };
}

const DEPS = (store, extra = {}) => ({
  store,
  nowIso: "2026-06-23T14:00:00.000Z",
  nowMs: 1_750_000_000_000,
  genId: () => "id-1",
  updateId: 100,
  ...extra,
});

test("/bought creates an unlinked position when no open signal", async () => {
  const store = fakeStore();
  const reply = await dispatch("/bought NVDA 20 249.99", DEPS(store));
  assert.equal(store.calls.createPosition.length, 1);
  assert.equal(store.calls.createPosition[0].h.ticker, "NVDA");
  assert.equal(store.calls.createPosition[0].h.linked, false);
  assert.match(reply, /No open GP signal found/);
});

test("/bought links to the latest open outcome when present", async () => {
  const store = fakeStore({ linkedOutcome: { pk: "SIGNAL#NVDA#2026-06-20", sk: 5, strategyVersion: "gp-2.0.0", stop: 240 } });
  const reply = await dispatch("/bought NVDA 20 249.99", DEPS(store));
  assert.equal(store.calls.createPosition[0].h.linked, true);
  assert.equal(store.calls.createPosition[0].h.initialStop, 240);
  assert.match(reply, /Linked to latest GP signal \(entry 2026-06-20\)/);
});

test("/bought rejects a second open position for the same ticker", async () => {
  const store = fakeStore({ openPosition: { ticker: "NVDA", status: "OPEN" } });
  const reply = await dispatch("/bought NVDA 20 249.99", DEPS(store));
  assert.equal(store.calls.createPosition.length, 0);
  assert.match(reply, /Open position already exists for NVDA/);
});

test("/bought rejects bad args without claiming an update_id", async () => {
  const store = fakeStore();
  const reply = await dispatch("/bought NVDA 20", DEPS(store));
  assert.match(reply, /Usage: \/bought/);
  assert.equal(store.calls.claimUpdateId.length, 0);
});

test("/sell records a partial sell against an open position", async () => {
  const store = fakeStore({
    openPosition: {
      pk: "POSITION#NVDA", sk: "2026-06-23#pos-1", ticker: "NVDA", positionId: "pos-1",
      entryDate: "2026-06-23", remainingShares: 20, avgEntryPrice: 100,
      realizedProfitDollars: 0, costBasisSoldCumulative: 0,
    },
  });
  const reply = await dispatch("/sell NVDA 10 110", DEPS(store));
  assert.equal(store.calls.recordSell.length, 1);
  assert.match(reply, /📉 Sold 10 NVDA @ 110\.00 \(\+10\.00%, \+\$100\.00\)\. 10 remain open\./);
});

test("/sell rejects oversell and does not write", async () => {
  const store = fakeStore({
    openPosition: { pk: "POSITION#NVDA", sk: "s", ticker: "NVDA", positionId: "pos-1", entryDate: "2026-06-23", remainingShares: 10, avgEntryPrice: 100, realizedProfitDollars: 0, costBasisSoldCumulative: 0 },
  });
  const reply = await dispatch("/sell NVDA 25 110", DEPS(store));
  assert.equal(store.calls.recordSell.length, 0);
  assert.match(reply, /You hold 10 NVDA; can't sell 25\./);
});

test("/sell with no open position replies cleanly", async () => {
  const store = fakeStore();
  const reply = await dispatch("/sell NVDA 10 110", DEPS(store));
  assert.equal(store.calls.recordSell.length, 0);
  assert.match(reply, /No open NVDA position\./);
});

test("update_id dedupe: a retried /sell is dropped, no second decrement", async () => {
  const store = fakeStore({
    claimedSeq: [true, false], // first delivery claims; retry fails the claim
    openPosition: { pk: "POSITION#NVDA", sk: "s", ticker: "NVDA", positionId: "pos-1", entryDate: "2026-06-23", remainingShares: 20, avgEntryPrice: 100, realizedProfitDollars: 0, costBasisSoldCumulative: 0 },
  });
  const first = await dispatch("/sell NVDA 10 110", DEPS(store, { updateId: 777 }));
  const retry = await dispatch("/sell NVDA 10 110", DEPS(store, { updateId: 777 }));
  assert.match(first, /Sold 10 NVDA/);
  assert.equal(retry, null); // silent drop
  assert.equal(store.calls.recordSell.length, 1); // only ONCE
});

test("/skip records a decision row (linked)", async () => {
  const store = fakeStore({ linkedOutcome: { pk: "SIGNAL#NVDA#2026-06-20", sk: 5, strategyVersion: "gp-2.0.0", stop: 240 } });
  const reply = await dispatch("/skip NVDA too extended", DEPS(store));
  assert.equal(store.calls.recordDecision.length, 1);
  assert.equal(store.calls.recordDecision[0].reason, "too extended");
  assert.equal(store.calls.recordDecision[0].linked, true);
  assert.match(reply, /⏭️ Skipped NVDA \(linked to GP signal\)\./);
});

test("/positions lists open positions", async () => {
  const store = fakeStore({
    openPositions: [{ ticker: "NVDA", remainingShares: 10, originalShares: 20, avgEntryPrice: 100, realizedProfitDollars: 100, linked: true }],
  });
  const reply = await dispatch("/positions", DEPS(store));
  assert.match(reply, /NVDA 10\/20 @ 100\.00/);
});

test("/sell renders a losing partial with negative P/L", async () => {
  const store = fakeStore({
    openPosition: { pk: "POSITION#NVDA", sk: "2026-06-23#pos-1", ticker: "NVDA", positionId: "pos-1", entryDate: "2026-06-23", remainingShares: 20, avgEntryPrice: 100, realizedProfitDollars: 0, costBasisSoldCumulative: 0 },
  });
  const reply = await dispatch("/sell NVDA 10 90", DEPS(store));
  assert.equal(store.calls.recordSell.length, 1);
  assert.match(reply, /📉 Sold 10 NVDA @ 90\.00 \(-10\.00%, -\$100\.00\)\. 10 remain open\./);
});

test("/skip records an unlinked decision when no open outcome", async () => {
  const store = fakeStore(); // findLatestOpenOutcome → null
  const reply = await dispatch("/skip AMD", DEPS(store));
  assert.equal(store.calls.recordDecision.length, 1);
  assert.equal(store.calls.recordDecision[0].linked, false);
  assert.match(reply, /⏭️ Skipped AMD \(unlinked\)\./);
});

test("/positions does not claim an update_id", async () => {
  const store = fakeStore({ openPositions: [] });
  await dispatch("/positions", DEPS(store));
  assert.equal(store.calls.claimUpdateId.length, 0);
});
