import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPositionHeader,
  buildBuyEvent,
  applySell,
  buildDecision,
} from "../lambdas/shared/positions.mjs";

const LINKED = { pk: "SIGNAL#NVDA#2026-06-20", sk: 1_750_000_000_000, strategyVersion: "gp-2.0.0", stop: 240, entryDate: "2026-06-20" };

test("buildPositionHeader (linked) copies source + stop + strategyVersion", () => {
  const h = buildPositionHeader({
    ticker: "NVDA", shares: 20, price: 249.99, entryDate: "2026-06-23",
    positionId: "pos-1", boughtAt: "2026-06-23T14:00:00.000Z",
    linkedOutcome: LINKED, currentStrategyVersion: "gp-2.0.0",
  });
  assert.equal(h.pk, "POSITION#NVDA");
  assert.equal(h.sk, "2026-06-23#pos-1");
  assert.equal(h.recordType, "POSITION_HEADER");
  assert.equal(h.status, "OPEN");
  assert.equal(h.originalShares, 20);
  assert.equal(h.remainingShares, 20);
  assert.equal(h.avgEntryPrice, 249.99);
  assert.equal(h.actualEntry, 249.99);
  assert.equal(h.actualEntryValue, 4999.8); // 20 * 249.99
  assert.equal(h.realizedProfitDollars, 0);
  assert.equal(h.realizedProfitPctWeighted, null);
  assert.equal(h.costBasisSoldCumulative, 0);
  assert.equal(h.linked, true);
  assert.equal(h.sourceOutcomePk, "SIGNAL#NVDA#2026-06-20");
  assert.equal(h.sourceOutcomeSk, 1_750_000_000_000);
  assert.equal(h.strategyVersion, "gp-2.0.0");
  assert.equal(h.initialStop, 240);
  assert.equal(h.currentTrailStop, 240);
  assert.equal(h.trailModel, "none");
  assert.equal(h.pnlBasis, "actual-fill");
  assert.equal(h.commandSource, "telegram");
});

test("buildPositionHeader (unlinked) nulls source/stop, uses current version", () => {
  const h = buildPositionHeader({
    ticker: "AMD", shares: 5, price: 100, entryDate: "2026-06-23",
    positionId: "pos-2", boughtAt: "2026-06-23T14:00:00.000Z",
    linkedOutcome: null, currentStrategyVersion: "gp-2.0.0",
  });
  assert.equal(h.linked, false);
  assert.equal(h.sourceOutcomePk, null);
  assert.equal(h.sourceOutcomeSk, null);
  assert.equal(h.initialStop, null);
  assert.equal(h.currentTrailStop, null);
  assert.equal(h.strategyVersion, "gp-2.0.0");
});

test("buildBuyEvent builds a keyed BUY_EVENT row", () => {
  const e = buildBuyEvent({
    ticker: "NVDA", positionId: "pos-1", entryDate: "2026-06-23",
    shares: 20, price: 249.99, boughtAt: "2026-06-23T14:00:00.000Z",
  });
  assert.equal(e.pk, "POSITION#NVDA");
  assert.equal(e.sk, "2026-06-23#pos-1#BUY#2026-06-23T14:00:00.000Z");
  assert.equal(e.recordType, "BUY_EVENT");
  assert.equal(e.shares, 20);
  assert.equal(e.price, 249.99);
  assert.equal(e.commandSource, "telegram");
});

test("applySell partial: realizes P/L, reduces shares, stays OPEN", () => {
  const h = buildPositionHeader({
    ticker: "NVDA", shares: 20, price: 100, entryDate: "2026-06-23",
    positionId: "pos-1", boughtAt: "2026-06-23T14:00:00.000Z",
    linkedOutcome: null, currentStrategyVersion: "gp-2.0.0",
  });
  const r = applySell(h, { sharesSold: 10, sellPrice: 110, soldAt: "2026-06-24T14:00:00.000Z" });
  assert.equal(r.error, undefined);
  assert.equal(r.closed, false);
  assert.equal(r.saleDollars, 100); // (110-100)*10
  assert.equal(r.salePct, 10); // (110/100-1)*100
  assert.equal(r.event.recordType, "SELL_EVENT");
  assert.equal(r.event.sk, "2026-06-23#pos-1#SELL#2026-06-24T14:00:00.000Z");
  assert.equal(r.event.sharesSold, 10);
  assert.equal(r.event.avgEntryPriceAtSale, 100);
  assert.equal(r.event.remainingSharesAfter, 10);
  assert.equal(r.updatedFields.remainingShares, 10);
  assert.equal(r.updatedFields.status, "OPEN");
  assert.equal(r.updatedFields.realizedProfitDollars, 100);
  assert.equal(r.updatedFields.costBasisSoldCumulative, 1000); // 100*10
  assert.equal(r.updatedFields.realizedProfitPctWeighted, 10); // 100/1000*100
  assert.equal(r.updatedFields.soldAt, undefined); // not closed
});

test("applySell full close: status CLOSED, weighted pct across two sells", () => {
  const h = buildPositionHeader({
    ticker: "NVDA", shares: 20, price: 100, entryDate: "2026-06-23",
    positionId: "pos-1", boughtAt: "2026-06-23T14:00:00.000Z",
    linkedOutcome: null, currentStrategyVersion: "gp-2.0.0",
  });
  // First sell 10 @ 110 — apply updatedFields back onto a header copy.
  const r1 = applySell(h, { sharesSold: 10, sellPrice: 110, soldAt: "2026-06-24T14:00:00.000Z" });
  const h2 = { ...h, ...r1.updatedFields };
  // Second sell 10 @ 120 closes it.
  const r2 = applySell(h2, { sharesSold: 10, sellPrice: 120, soldAt: "2026-06-25T14:00:00.000Z" });
  assert.equal(r2.closed, true);
  assert.equal(r2.saleDollars, 200); // (120-100)*10
  assert.equal(r2.updatedFields.remainingShares, 0);
  assert.equal(r2.updatedFields.status, "CLOSED");
  assert.equal(r2.updatedFields.realizedProfitDollars, 300); // 100 + 200
  assert.equal(r2.updatedFields.costBasisSoldCumulative, 2000); // 1000 + 1000
  assert.equal(r2.updatedFields.realizedProfitPctWeighted, 15); // 300/2000*100
  assert.equal(r2.updatedFields.soldAt, "2026-06-25T14:00:00.000Z");
  assert.equal(r2.updatedFields.closedAt, "2026-06-25T14:00:00.000Z");
});

test("applySell rejects oversell without mutating", () => {
  const h = buildPositionHeader({
    ticker: "NVDA", shares: 10, price: 100, entryDate: "2026-06-23",
    positionId: "pos-1", boughtAt: "2026-06-23T14:00:00.000Z",
    linkedOutcome: null, currentStrategyVersion: "gp-2.0.0",
  });
  const r = applySell(h, { sharesSold: 25, sellPrice: 110, soldAt: "2026-06-24T14:00:00.000Z" });
  assert.equal(r.error, "oversell");
  assert.equal(r.held, 10);
  assert.equal(r.event, undefined);
});

test("applySell rejects non-positive / non-integer shares", () => {
  const h = buildPositionHeader({
    ticker: "NVDA", shares: 10, price: 100, entryDate: "2026-06-23",
    positionId: "pos-1", boughtAt: "2026-06-23T14:00:00.000Z",
    linkedOutcome: null, currentStrategyVersion: "gp-2.0.0",
  });
  assert.equal(applySell(h, { sharesSold: 0, sellPrice: 110, soldAt: "x" }).error, "invalid-shares");
  assert.equal(applySell(h, { sharesSold: 2.5, sellPrice: 110, soldAt: "x" }).error, "invalid-shares");
});

test("buildDecision (linked + unlinked)", () => {
  const linked = buildDecision({
    ticker: "NVDA", skippedAt: "2026-06-23T14:00:00.000Z", id: "dec-1",
    linkedOutcome: LINKED, currentStrategyVersion: "gp-2.0.0", reason: "too extended",
  });
  assert.equal(linked.pk, "DECISION#NVDA");
  assert.equal(linked.sk, "2026-06-23T14:00:00.000Z#dec-1");
  assert.equal(linked.recordType, "DECISION");
  assert.equal(linked.decision, "SKIPPED");
  assert.equal(linked.linked, true);
  assert.equal(linked.sourceOutcomePk, "SIGNAL#NVDA#2026-06-20");
  assert.equal(linked.strategyVersion, "gp-2.0.0");
  assert.equal(linked.reason, "too extended");
  assert.equal(linked.commandSource, "telegram");

  const unlinked = buildDecision({
    ticker: "AMD", skippedAt: "2026-06-23T14:00:00.000Z", id: "dec-2",
    linkedOutcome: null, currentStrategyVersion: "gp-2.0.0",
  });
  assert.equal(unlinked.linked, false);
  assert.equal(unlinked.sourceOutcomePk, null);
  assert.equal(unlinked.reason, null);
});
