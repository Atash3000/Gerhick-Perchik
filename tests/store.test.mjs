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
  assert.equal(Item.metrics.nearestSupport, 98);
  assert.equal(Item.metrics.nearestResistance, 110);
  assert.equal(Item.metrics.daysToEarnings, 20);
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
  const md = { close: 100, return63d: 5.5, return126d: 12.1, return252d: 30 };
  const fundamentals = { epsGrowthQtr: 23.3, salesGrowthQtr: 18, roeTTM: 33 };
  await store.writeSnapshot(buyResult, { asOf: "2026-06-18", marketData: md, fundamentals });
  const { Item } = client.calls[0];
  assert.equal(Item.fundamentals.epsGrowthQtr, 23.3);
  assert.equal(Item.fundamentals.roeTTM, 33);
  assert.equal(Item.metrics.return126d, 12.1);
  assert.equal(Item.metrics.return252d, 30);
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

test("openOutcome opens a conditional OPEN row with the right keys", async () => {
  const client = fakeClient();
  const store = createStore({ client, snapshotsTable: "T-snap", outcomesTable: "T-out" });

  const r = await store.openOutcome(buyResult, { sector: "Technology" });

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
  assert.equal(ConditionExpression, "attribute_not_exists(pk)");
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

test("listOutcomesByStatus scans by status", async () => {
  const items = [{ pk: "SIGNAL#MSFT#2026-06-18", status: "CLOSED" }];
  const client = { calls: [], async send(cmd) { this.calls.push(cmd.input); return { Items: items }; } };
  const store = createStore({ client, outcomesTable: "T-out" });

  const res = await store.listOutcomesByStatus("CLOSED");
  assert.deepEqual(res, items);
  assert.equal(client.calls[0].ExpressionAttributeValues[":st"], "CLOSED");
});
