import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore, epochDay, epochMs } from "../lambdas/shared/store.mjs";

// A fake DynamoDB document client. Records each command's `.input`; can be told
// to throw (once, or always) to exercise the conditional-put path.
function fakeClient(opts = {}) {
  const calls = [];
  let state = { ...opts };
  return {
    calls,
    async send(cmd) {
      calls.push(cmd.input);
      if (state.throwOnce) {
        state.throwOnce = false;
        const e = new Error("conditional check failed");
        e.name = "ConditionalCheckFailedException";
        throw e;
      }
      if (state.throwError) throw state.throwError;
      return {};
    },
  };
}

const buyResult = {
  ticker: "MSFT",
  decision: "BUY_CANDIDATE",
  reason: "all gates passed; score at/above threshold",
  strategyVersion: "gp-1.0.0",
  dataAsOf: "2026-06-18",
  score: 81,
  breakdown: { empiricalEdge: 15, trend: 20, setup: 16, momentum: 15, volume: 10, news: 5 },
  entry: 100,
  stop: 97,
  target: 110,
  riskReward: 3.333,
  gates: { trend: true },
};

test("epochDay / epochMs compute UTC day boundaries", () => {
  assert.equal(epochDay("1970-01-01"), 0);
  assert.equal(epochDay("1970-01-02"), 1);
  assert.equal(epochMs("1970-01-01"), 0);
  assert.equal(epochMs("1970-01-02"), 86_400_000);
});

test("writeSnapshot writes one keyed row with strategyVersion + dataAsOf", async () => {
  const client = fakeClient();
  const store = createStore({ client, snapshotsTable: "T-snap", outcomesTable: "T-out" });

  const ref = await store.writeSnapshot(buyResult, { asOf: "2026-06-18", sector: "Technology" });

  assert.equal(client.calls.length, 1);
  const { TableName, Item } = client.calls[0];
  assert.equal(TableName, "T-snap");
  assert.equal(Item.pk, "TICKER#MSFT");
  assert.equal(Item.sk, epochDay("2026-06-18"));
  assert.equal(Item.strategyVersion, "gp-1.0.0");
  assert.equal(Item.dataAsOf, "2026-06-18");
  assert.equal(Item.decision, "BUY_CANDIDATE");
  assert.equal(Item.score, 81);
  assert.equal(Item.sector, "Technology");
  assert.deepEqual(ref, { table: "T-snap", pk: "TICKER#MSFT", sk: epochDay("2026-06-18") });
});

test("writeSnapshot records raw metrics from marketData for tuning", async () => {
  const client = fakeClient();
  const store = createStore({ client, snapshotsTable: "T-snap", outcomesTable: "T-out" });
  const md = {
    rsi: 58, ma50: 95, ma200: 90, atr: 2,
    volume: 1_500_000, avgVolume30: 1_000_000,
    nearestSupport: { price: 98 }, nearestResistance: { price: 110 }, daysToEarnings: 20,
  };
  await store.writeSnapshot(buyResult, { asOf: "2026-06-18", sector: "Technology", marketData: md });
  const { Item } = client.calls[0];
  assert.equal(Item.metrics.rsi, 58);
  assert.equal(Item.metrics.volumeRatio, 1.5);
  assert.equal(Item.metrics.nearestSupport.price, 98);
  assert.equal(Item.metrics.nearestResistance.price, 110);
  assert.equal(Item.metrics.daysToEarnings, 20);
});

test("writeSnapshot stores the FULL support/resistance level, not just the price", async () => {
  const client = fakeClient();
  const store = createStore({ client, snapshotsTable: "T-snap", outcomesTable: "T-out" });
  const md = {
    close: 100, atr: 2, rsi: 58, ma50: 95, ma200: 90, volume: 1_000_000, avgVolume30: 1_000_000,
    nearestSupport: { price: 98.004, touches: 8, strength: 0.7321, brokenSupport: false },
    nearestResistance: { price: 110.2, touches: 3, strength: 0.5, brokenSupport: false },
  };
  await store.writeSnapshot(buyResult, { asOf: "2026-06-18", marketData: md });
  const { Item } = client.calls[0];
  // touches/strength/brokenSupport must survive to the DB (the most "Gerchik" data).
  assert.deepEqual(Item.metrics.nearestSupport, { price: 98, touches: 8, strength: 0.7321, brokenSupport: false });
  assert.equal(Item.metrics.nearestResistance.touches, 3);
  assert.equal(Item.metrics.nearestResistance.brokenSupport, false);
});

test("writeSnapshot stores per-period RS-vs-SPY (from md) and the SPY context block", async () => {
  const client = fakeClient();
  const store = createStore({ client, snapshotsTable: "T-snap", outcomesTable: "T-out" });
  const md = { close: 100, atr: 2, rsVsSpy: 37.1, rs21VsSpy: 13.2, rs63VsSpy: 24.8, rs126VsSpy: 37.1, rs252VsSpy: 55.9 };
  const spy = { close: 690.22, ma50: 675.11, ma200: 620.33, rsi: 62.4, return21d: 4.1, return63d: 9.2, return126d: 12, return252d: 20.5, above50: true, above200: true };
  await store.writeSnapshot(buyResult, { asOf: "2026-06-18", marketData: md, spy });
  const { Item } = client.calls[0];
  assert.equal(Item.metrics.rs21VsSpy, 13.2);
  assert.equal(Item.metrics.rs63VsSpy, 24.8);
  assert.equal(Item.metrics.rs126VsSpy, 37.1);
  assert.equal(Item.metrics.rs252VsSpy, 55.9);
  assert.equal(Item.metrics.rsVsSpy, 37.1); // back-compat alias retained
  assert.deepEqual(Item.spy, spy);
});

test("writeSnapshot: no md RS deltas / no spy → nulls, never undefined", async () => {
  const client = fakeClient();
  const store = createStore({ client, snapshotsTable: "T-snap", outcomesTable: "T-out" });
  await store.writeSnapshot(buyResult, { asOf: "2026-06-18", marketData: { close: 50, atr: 1 } });
  const { Item } = client.calls[0];
  assert.equal(Item.metrics.rs21VsSpy, null);
  assert.equal(Item.metrics.rs252VsSpy, null);
  assert.equal(Item.spy, null);
});

test("writeSnapshot: missing level fields → nulls (never undefined); no level → null", async () => {
  const client = fakeClient();
  const store = createStore({ client, snapshotsTable: "T-snap", outcomesTable: "T-out" });
  const md = { close: 100, atr: 2, nearestSupport: { price: 98 }, nearestResistance: null };
  await store.writeSnapshot(buyResult, { asOf: "2026-06-18", marketData: md });
  const { Item } = client.calls[0];
  assert.deepEqual(Item.metrics.nearestSupport, { price: 98, touches: null, strength: null, brokenSupport: null });
  assert.equal(Item.metrics.nearestResistance, null);
});

test("writeSnapshot captures ATR distances + per-share risk/reward + sectorStrengthPct", async () => {
  const client = fakeClient();
  const store = createStore({ client, snapshotsTable: "T-snap", outcomesTable: "T-out" });
  const md = {
    close: 100, atr: 2, rsi: 58, ma50: 95, ma200: 90,
    volume: 1_000_000, avgVolume30: 1_000_000,
    nearestSupport: { price: 98 }, nearestResistance: { price: 110 },
  };
  await store.writeSnapshot(buyResult, { asOf: "2026-06-18", marketData: md, sectorStrengthPct: 72.5 });
  const { Item } = client.calls[0];
  assert.equal(Item.metrics.distanceToSupportAtr, 1); // (100-98)/2
  assert.equal(Item.metrics.distanceToResistanceAtr, 5); // (110-100)/2
  assert.equal(Item.riskPerShare, 3); // entry 100 - stop 97
  assert.equal(Item.rewardPerShare, 10); // target 110 - entry 100
  assert.equal(Item.sectorStrengthPct, 72.5);
});

test("writeSnapshot: ATH breakout (no resistance) → distanceToResistanceAtr null, never fabricated", async () => {
  const client = fakeClient();
  const store = createStore({ client, snapshotsTable: "T-snap", outcomesTable: "T-out" });
  const md = { close: 250, atr: 7, nearestSupport: { price: 197 }, nearestResistance: null };
  await store.writeSnapshot(buyResult, { asOf: "2026-06-18", marketData: md });
  const { Item } = client.calls[0];
  assert.equal(Item.metrics.distanceToResistanceAtr, null);
  assert.equal(Item.metrics.distanceToSupportAtr, 7.571); // (250-197)/7, 3dp
});

test("writeSnapshot: no levels / no sector → per-share + sectorStrengthPct null, not fabricated", async () => {
  const client = fakeClient();
  const store = createStore({ client, snapshotsTable: "T-snap", outcomesTable: "T-out" });
  const noLevels = { ...buyResult, decision: "NO_SIGNAL", entry: null, stop: null, target: null, riskReward: null, score: null, breakdown: null };
  await store.writeSnapshot(noLevels, { asOf: "2026-06-18", marketData: { close: 50, atr: 1 } });
  const { Item } = client.calls[0];
  assert.equal(Item.riskPerShare, null);
  assert.equal(Item.rewardPerShare, null);
  assert.equal(Item.sectorStrengthPct, null); // not passed → null
});

test("writeSnapshot rounds full-precision indicator fields for persistence", async () => {
  // marketData now carries FULL-PRECISION decision fields (scoring sees them raw);
  // snapshotMetrics is the persistence boundary that rounds for clean storage.
  const client = fakeClient();
  const store = createStore({ client, snapshotsTable: "T-snap", outcomesTable: "T-out" });
  const md = {
    rsi: 57.83456, ma50: 95.111, ma150: 92.005, ma200: 90.126, atr: 2.19899,
    volume: 1_500_000, avgVolume30: 1_000_000,
    nearestSupport: { price: 98 }, nearestResistance: { price: 110 },
  };
  await store.writeSnapshot(buyResult, { asOf: "2026-06-18", marketData: md });
  const { Item } = client.calls[0];
  assert.equal(Item.metrics.rsi, 57.83);
  assert.equal(Item.metrics.ma50, 95.11);
  assert.equal(Item.metrics.ma150, 92.01);
  assert.equal(Item.metrics.ma200, 90.13);
  assert.equal(Item.metrics.atr, 2.2);
});

test("writeSnapshot derives v2 capture booleans (Minervini/Turtle) when inputs present", async () => {
  const client = fakeClient();
  const store = createStore({ client, snapshotsTable: "T-snap", outcomesTable: "T-out" });
  const md = {
    close: 113, ma50: 110, ma150: 105, ma200: 100, ma200SlopePct: 1.2,
    high20d: 112, high55d: 114, // close>high20d (breakout20 true), close<high55d (false)
  };
  await store.writeSnapshot(buyResult, { asOf: "2026-06-18", marketData: md });
  const { metrics } = client.calls[0].Item;
  assert.equal(metrics.minerviniAligned, true); // 110>105>100
  assert.equal(metrics.ma200Rising, true); // slope 1.2 > 0
  assert.equal(metrics.breakout20, true); // 113 > 112
  assert.equal(metrics.breakout55, false); // 113 < 114
});

test("writeSnapshot records fundamentals + RS returns (capture-only)", async () => {
  const client = fakeClient();
  const store = createStore({ client, snapshotsTable: "T-snap", outcomesTable: "T-out" });
  const md = {
    close: 100, return63d: 5.5, return126d: 12.1, return252d: 30,
    rsRaw: 53.1, rsRank: 88, rsVsSpy: 11.2,
  };
  const fundamentals = { epsGrowthQtr: 23.3, salesGrowthQtr: 18, roeTTM: 33 };
  await store.writeSnapshot(buyResult, { asOf: "2026-06-18", marketData: md, fundamentals });
  const { Item } = client.calls[0];
  assert.equal(Item.fundamentals.epsGrowthQtr, 23.3);
  assert.equal(Item.fundamentals.roeTTM, 33);
  assert.equal(Item.metrics.return126d, 12.1);
  assert.equal(Item.metrics.return252d, 30);
  assert.equal(Item.metrics.rsRaw, 53.1);
  assert.equal(Item.metrics.rsRank, 88);
  assert.equal(Item.metrics.rsVsSpy, 11.2);
});

test("writeSnapshot fundamentals defaults to null when not provided", async () => {
  const client = fakeClient();
  const store = createStore({ client, snapshotsTable: "T-snap", outcomesTable: "T-out" });
  await store.writeSnapshot(buyResult, { asOf: "2026-06-18", marketData: { close: 100 } });
  assert.equal(client.calls[0].Item.fundamentals, null);
});

test("writeSnapshot v2 booleans are null when MAs/levels are unavailable", async () => {
  const client = fakeClient();
  const store = createStore({ client, snapshotsTable: "T-snap", outcomesTable: "T-out" });
  await store.writeSnapshot(buyResult, { asOf: "2026-06-18", marketData: { close: 100 } });
  const { metrics } = client.calls[0].Item;
  assert.equal(metrics.minerviniAligned, null);
  assert.equal(metrics.breakout55, null);
});

test("writeSnapshot falls back to asOf when the result has no dataAsOf (NO_DATA)", async () => {
  const client = fakeClient();
  const store = createStore({ client, snapshotsTable: "T-snap", outcomesTable: "T-out" });

  const noData = {
    ticker: "FOO", decision: "NO_DATA", reason: "stale feed",
    strategyVersion: "gp-1.0.0", dataAsOf: null,
    score: null, breakdown: null, entry: null, stop: null, target: null, riskReward: null, gates: null,
  };
  await store.writeSnapshot(noData, { asOf: "2026-06-18" });

  const { Item } = client.calls[0];
  assert.equal(Item.sk, epochDay("2026-06-18"));
  assert.equal(Item.decision, "NO_DATA");
  assert.equal(Item.score, null);
});

test("writeSnapshot throws when no as-of date is available at all", async () => {
  const store = createStore({ client: fakeClient(), snapshotsTable: "T-snap", outcomesTable: "T-out" });
  await assert.rejects(
    () => store.writeSnapshot({ ticker: "X", dataAsOf: null }, {}),
    /no as-of date/
  );
});

test("openOutcome opens a conditional OPEN row with the right keys + RS capture", async () => {
  const client = fakeClient();
  const store = createStore({ client, snapshotsTable: "T-snap", outcomesTable: "T-out" });

  const r = await store.openOutcome(buyResult, {
    sector: "Technology",
    rs: { rsRaw: 42.5, rsRank: 88, rsVsSpy: 11.2 },
  });

  assert.equal(r.opened, true);
  const { TableName, Item, ConditionExpression } = client.calls[0];
  assert.equal(TableName, "T-out");
  assert.equal(Item.pk, "SIGNAL#MSFT#2026-06-18");
  assert.equal(Item.sk, epochMs("2026-06-18"));
  assert.equal(Item.status, "OPEN");
  assert.equal(Item.entry, 100);
  assert.equal(Item.stop, 97);
  assert.equal(Item.target, 110);
  assert.equal(Item.strategyVersion, "gp-1.0.0");
  assert.equal(Item.rsRank, 88); // captured RS at entry
  assert.equal(Item.rsRaw, 42.5);
  assert.equal(Item.rsVsSpy, 11.2);
  assert.equal(ConditionExpression, "attribute_not_exists(pk)");
});

test("openOutcome RS fields default to null when rs not provided", async () => {
  const client = fakeClient();
  const store = createStore({ client, outcomesTable: "T-out" });
  await store.openOutcome(buyResult, { sector: "Technology" });
  assert.equal(client.calls[0].Item.rsRank, null);
});

test("openOutcome is idempotent — already-open signal returns opened:false, no throw", async () => {
  const client = fakeClient({ throwOnce: true });
  const store = createStore({ client, outcomesTable: "T-out" });

  const r = await store.openOutcome(buyResult, {});
  assert.equal(r.opened, false);
  assert.match(r.reason, /already open/);
});

test("openOutcome rethrows non-conditional errors", async () => {
  const boom = new Error("kaboom");
  boom.name = "ProvisionedThroughputExceededException";
  const store = createStore({ client: fakeClient({ throwError: boom }), outcomesTable: "T-out" });
  await assert.rejects(() => store.openOutcome(buyResult, {}), /kaboom/);
});

test("listOpenOutcomes scans for status=OPEN", async () => {
  const items = [{ pk: "SIGNAL#MSFT#2026-06-18", sk: 1, status: "OPEN" }];
  const client = { calls: [], async send(cmd) { this.calls.push(cmd.input); return { Items: items }; } };
  const store = createStore({ client, outcomesTable: "T-out" });

  const res = await store.listOpenOutcomes();
  assert.deepEqual(res, items);
  assert.equal(client.calls[0].TableName, "T-out");
  assert.equal(client.calls[0].FilterExpression, "#s = :open");
  assert.equal(client.calls[0].ExpressionAttributeValues[":open"], "OPEN");
});

test("listOpenOutcomes paginates until LastEvaluatedKey is exhausted", async () => {
  let n = 0;
  const client = {
    calls: [],
    async send(cmd) {
      this.calls.push(cmd.input);
      n += 1;
      return n === 1
        ? { Items: [{ pk: "a" }], LastEvaluatedKey: { pk: "a" } }
        : { Items: [{ pk: "b" }] };
    },
  };
  const store = createStore({ client, outcomesTable: "T-out" });

  const res = await store.listOpenOutcomes();
  assert.equal(res.length, 2);
  assert.equal(client.calls.length, 2);
  assert.deepEqual(client.calls[1].ExclusiveStartKey, { pk: "a" });
});

test("closeOutcome updates label fields, guarded by status=OPEN", async () => {
  const client = { calls: [], async send(cmd) { this.calls.push(cmd.input); return {}; } };
  const store = createStore({ client, outcomesTable: "T-out" });

  const r = await store.closeOutcome("SIGNAL#MSFT#2026-06-18", 123, {
    outcome: "TARGET", profitPct: 9.7, daysHeld: 3,
  });

  assert.equal(r.closed, true);
  const inp = client.calls[0];
  assert.equal(inp.TableName, "T-out");
  assert.deepEqual(inp.Key, { pk: "SIGNAL#MSFT#2026-06-18", sk: 123 });
  assert.equal(inp.ConditionExpression, "#s = :open");
  assert.match(inp.UpdateExpression, /^SET /);
  assert.equal(inp.ExpressionAttributeNames["#s"], "status");
  assert.equal(inp.ExpressionAttributeValues[":closed"], "CLOSED");
  assert.equal(inp.ExpressionAttributeNames["#outcome"], "outcome");
  assert.equal(inp.ExpressionAttributeValues[":outcome"], "TARGET");
});

test("closeOutcome on an already-closed row returns closed:false (no throw)", async () => {
  const err = new Error("already closed");
  err.name = "ConditionalCheckFailedException";
  const store = createStore({ client: { async send() { throw err; } }, outcomesTable: "T-out" });

  const r = await store.closeOutcome("pk", 1, { outcome: "STOP" });
  assert.equal(r.closed, false);
  assert.match(r.reason, /not open/);
});

test("setWatchlistEnabled updates the row, guarded by existence", async () => {
  const client = { calls: [], async send(cmd) { this.calls.push(cmd.input); return {}; } };
  const store = createStore({ client, watchlistTable: "T-wl" });

  const r = await store.setWatchlistEnabled("AAPL", false);
  assert.deepEqual(r, { ok: true, ticker: "AAPL", enabled: false });
  const inp = client.calls[0];
  assert.equal(inp.TableName, "T-wl");
  assert.deepEqual(inp.Key, { pk: "TICKER#AAPL" });
  assert.equal(inp.ExpressionAttributeValues[":e"], false);
  assert.equal(inp.ConditionExpression, "attribute_exists(pk)");
});

test("setWatchlistEnabled on an unknown ticker returns ok:false (no throw)", async () => {
  const err = new Error("missing");
  err.name = "ConditionalCheckFailedException";
  const store = createStore({ client: { async send() { throw err; } }, watchlistTable: "T-wl" });
  const r = await store.setWatchlistEnabled("ZZZZ", true);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not on watchlist/);
});

test("putWatchlistRow upserts a full watchlist row", async () => {
  const client = { calls: [], async send(cmd) { this.calls.push(cmd.input); return {}; } };
  const store = createStore({ client, watchlistTable: "T-wl" });

  const r = await store.putWatchlistRow({ ticker: "NVDA", sector: "Technology", qualityTier: "A" });
  assert.deepEqual(r, { ok: true, ticker: "NVDA" });
  const inp = client.calls[0];
  assert.equal(inp.TableName, "T-wl");
  assert.deepEqual(inp.Item, {
    pk: "TICKER#NVDA", ticker: "NVDA", sector: "Technology", enabled: true, qualityTier: "A",
  });
  assert.equal(inp.ConditionExpression, undefined); // upsert, not guarded
});

test("putWatchlistRow requires a ticker", async () => {
  const store = createStore({ client: { async send() {} }, watchlistTable: "T-wl" });
  await assert.rejects(() => store.putWatchlistRow({ sector: "Technology" }), /ticker required/);
});

test("listOutcomesByStatus scans by status", async () => {
  const items = [{ pk: "SIGNAL#MSFT#2026-06-18", status: "CLOSED" }];
  const client = { calls: [], async send(cmd) { this.calls.push(cmd.input); return { Items: items }; } };
  const store = createStore({ client, outcomesTable: "T-out" });

  const res = await store.listOutcomesByStatus("CLOSED");
  assert.deepEqual(res, items);
  assert.equal(client.calls[0].ExpressionAttributeValues[":st"], "CLOSED");
});

test("findLatestOpenOutcome scans by ticker prefix + OPEN, picks highest sk", async () => {
  const items = [
    { pk: "SIGNAL#NVDA#2026-06-18", sk: 100, status: "OPEN", strategyVersion: "gp-2.0.0", stop: 230, entryDate: "2026-06-18" },
    { pk: "SIGNAL#NVDA#2026-06-20", sk: 300, status: "OPEN", strategyVersion: "gp-2.0.0", stop: 240, entryDate: "2026-06-20" },
  ];
  const client = { calls: [], async send(cmd) { this.calls.push(cmd.input); return { Items: items }; } };
  const store = createStore({ client, outcomesTable: "T-out" });
  const r = await store.findLatestOpenOutcome("NVDA");
  assert.deepEqual(r, { pk: "SIGNAL#NVDA#2026-06-20", sk: 300, strategyVersion: "gp-2.0.0", stop: 240, entryDate: "2026-06-20" });
  assert.equal(client.calls[0].FilterExpression, "begins_with(pk, :p) AND #s = :open");
  assert.equal(client.calls[0].ExpressionAttributeValues[":p"], "SIGNAL#NVDA#");
});

test("findLatestOpenOutcome returns null when none open", async () => {
  const client = { calls: [], async send() { return { Items: [] }; } };
  const store = createStore({ client, outcomesTable: "T-out" });
  assert.equal(await store.findLatestOpenOutcome("ZZZZ"), null);
});

test("getOpenPosition queries the POSITION pk for an OPEN header", async () => {
  const header = { pk: "POSITION#NVDA", sk: "2026-06-23#pos-1", recordType: "POSITION_HEADER", status: "OPEN" };
  const client = { calls: [], async send(cmd) { this.calls.push(cmd.input); return { Items: [header] }; } };
  const store = createStore({ client, positionsTable: "T-pos" });
  const r = await store.getOpenPosition("NVDA");
  assert.deepEqual(r, header);
  assert.equal(client.calls[0].TableName, "T-pos");
  assert.equal(client.calls[0].KeyConditionExpression, "pk = :pk");
  assert.equal(client.calls[0].ExpressionAttributeValues[":pk"], "POSITION#NVDA");
  assert.equal(client.calls[0].FilterExpression, "recordType = :h AND #s = :open");
});

test("getOpenPosition returns null when no open header", async () => {
  const client = { async send() { return { Items: [] }; } };
  const store = createStore({ client, positionsTable: "T-pos" });
  assert.equal(await store.getOpenPosition("NVDA"), null);
});

test("createPosition transact-writes header (conditional) + buy event", async () => {
  const client = { calls: [], async send(cmd) { this.calls.push(cmd.input); return {}; } };
  const store = createStore({ client, positionsTable: "T-pos" });
  const header = { pk: "POSITION#NVDA", sk: "2026-06-23#pos-1" };
  const buyEvent = { pk: "POSITION#NVDA", sk: "2026-06-23#pos-1#BUY#t" };
  const r = await store.createPosition(header, buyEvent);
  assert.deepEqual(r, { created: true, pk: "POSITION#NVDA", sk: "2026-06-23#pos-1" });
  const items = client.calls[0].TransactItems;
  assert.equal(items.length, 2);
  assert.equal(items[0].Put.ConditionExpression, "attribute_not_exists(pk)");
  assert.equal(items[0].Put.Item, header);
  assert.equal(items[1].Put.Item, buyEvent);
});

test("recordSell transact-updates header (optimistic lock) + puts sell event", async () => {
  const client = { calls: [], async send(cmd) { this.calls.push(cmd.input); return {}; } };
  const store = createStore({ client, positionsTable: "T-pos" });
  const header = { pk: "POSITION#NVDA", sk: "2026-06-23#pos-1", remainingShares: 20 };
  const sellResult = {
    event: { pk: "POSITION#NVDA", sk: "2026-06-23#pos-1#SELL#t" },
    updatedFields: { remainingShares: 10, status: "OPEN", realizedProfitDollars: 100 },
  };
  await store.recordSell(header, sellResult);
  const items = client.calls[0].TransactItems;
  assert.equal(items[0].Update.Key.sk, "2026-06-23#pos-1");
  assert.equal(items[0].Update.ConditionExpression, "remainingShares = :expected");
  assert.equal(items[0].Update.ExpressionAttributeValues[":expected"], 20);
  assert.equal(items[0].Update.ExpressionAttributeValues[":remainingShares"], 10);
  assert.match(items[0].Update.UpdateExpression, /^SET /);
  assert.equal(items[1].Put.Item, sellResult.event);
});

test("recordDecision puts the decision row", async () => {
  const client = { calls: [], async send(cmd) { this.calls.push(cmd.input); return {}; } };
  const store = createStore({ client, positionsTable: "T-pos" });
  const decision = { pk: "DECISION#NVDA", sk: "t#dec-1" };
  await store.recordDecision(decision);
  assert.equal(client.calls[0].TableName, "T-pos");
  assert.equal(client.calls[0].Item, decision);
});

test("listOpenPositions scans headers with status OPEN", async () => {
  const headers = [{ pk: "POSITION#NVDA", recordType: "POSITION_HEADER", status: "OPEN" }];
  const client = { calls: [], async send(cmd) { this.calls.push(cmd.input); return { Items: headers }; } };
  const store = createStore({ client, positionsTable: "T-pos" });
  assert.deepEqual(await store.listOpenPositions(), headers);
  assert.equal(client.calls[0].FilterExpression, "recordType = :h AND #s = :open");
});

test("claimUpdateId returns claimed:true on first put", async () => {
  const client = { calls: [], async send(cmd) { this.calls.push(cmd.input); return {}; } };
  const store = createStore({ client, positionsTable: "T-pos" });
  const r = await store.claimUpdateId(555, 1_900_000_000);
  assert.deepEqual(r, { claimed: true });
  assert.equal(client.calls[0].Item.pk, "MUTATION#555");
  assert.equal(client.calls[0].Item.ttl, 1_900_000_000);
  assert.equal(client.calls[0].ConditionExpression, "attribute_not_exists(pk)");
});

test("claimUpdateId returns claimed:false when already claimed", async () => {
  const store = createStore({ client: fakeClient({ throwOnce: true }), positionsTable: "T-pos" });
  const r = await store.claimUpdateId(555, 1_900_000_000);
  assert.deepEqual(r, { claimed: false });
});
