# Manual Position Confirmation & Tracking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the human confirm/track real trades via Telegram (`/bought`, `/sell`, `/skip`, `/positions`) in a new `gp-positions` table, fully separate from `gp-outcomes` research tracking.

**Architecture:** A new pure module `lambdas/shared/positions.mjs` holds all row-builders and P/L math (deterministic — ids/timestamps injected). `lambdas/shared/store.mjs` gains DynamoDB methods against a new `gp-positions` table. `lambdas/control/commands.mjs` parses the new commands and formats replies (pure). `lambdas/control/handler.mjs` wires commands → store, guarded by Telegram `update_id` dedupe. `template.yaml` adds the table (Retain), one env var, and one IAM grant on the control Lambda.

**Tech Stack:** Node 22 ESM (`.mjs`), AWS SDK v3 (`@aws-sdk/lib-dynamodb`), AWS SAM, `node --test`.

Design spec: `docs/superpowers/specs/2026-06-23-manual-position-tracking-design.md`

## Global Constraints

Copied verbatim from the spec / CLAUDE.md — every task implicitly includes these:

- **`gp-outcomes` is never written by this feature.** Linkage reads it only. The labeler's `status="OPEN"` scan must never see position rows.
- **One OPEN position per ticker (v1).** Second `/bought` while one is OPEN is rejected. **No scale-ins.**
- **Partial sells supported.** Average-cost; `remainingShares == 0` ⇒ `CLOSED`.
- **Realized P/L = actual fill prices only.** No `feeBps`/`slippageBps`. `pnlBasis: "actual-fill"`.
- **`update_id` dedupe is mandatory** for the three mutating commands (`/bought`, `/sell`, `/skip`).
- **`positions.mjs` is pure & deterministic** — no `crypto`/`Date` inside; `positionId`/`id`/timestamps are injected by the caller.
- **All rows carry `commandSource: "telegram"`.** No unrealized P/L in v1.
- **New table `gp-positions`:** `PAY_PER_REQUEST`, `DeletionPolicy: Retain`, `UpdateReplacePolicy: Retain`, `Project: gerchik-perchik` tag, `pk` (S) HASH / `sk` (S) RANGE, TTL on attribute `ttl` (dedupe markers only).
- **Human-only, never the agent:** no `STRATEGY_VERSION` bump, no `alertMode` change, no `gp-config` trading-row write.
- **Branch:** `feat/manual-position-tracking`. Conventional commits. Commit per task.

### What must NOT change

`lambdas/scanner/*`, `lambdas/labeler/*`, `lambdas/shared/scoring.mjs`, `lambdas/shared/version.mjs`, `lambdas/shared/labeling.mjs`, the `gp-outcomes`/`gp-snapshots`/`gp-config`/`gp-watchlist` table shapes, and the existing `/start /stop /mode /enable /disable /stats /analyze` behaviors. The only edits to existing files are **additive**: new methods in `store.mjs`, new parsing/formatting in `commands.mjs`, new `switch` cases in `handler.mjs`, and new resources/env/IAM in `template.yaml`.

---

## File Structure

| File | Responsibility | Action |
| --- | --- | --- |
| `lambdas/shared/positions.mjs` | Pure row-builders + P/L math (`buildPositionHeader`, `buildBuyEvent`, `applySell`, `buildDecision`) | Create |
| `tests/positions.test.mjs` | Unit tests for the pure module | Create |
| `lambdas/shared/store.mjs` | Add `findLatestOpenOutcome`, `getOpenPosition`, `createPosition`, `recordSell`, `recordDecision`, `listOpenPositions`, `claimUpdateId` + `positionsTable` wiring | Modify |
| `tests/store.test.mjs` | Add tests for the new store methods | Modify |
| `lambdas/control/commands.mjs` | Extend `parseCommand`; add `parseTradeArgs`, `formatBought`, `formatSell`, `formatSkip`, `formatPositions`; update `HELP` | Modify |
| `tests/control.test.mjs` | Add tests for parser + formatters | Modify |
| `lambdas/control/handler.mjs` | New `switch` cases; `update_id` dedupe; inject store/clock; `export` dispatch | Modify |
| `tests/control-dispatch.test.mjs` | Dispatch-level tests (commands end-to-end against a fake store; dedupe) | Create |
| `template.yaml` | `PositionsTable` resource + `POSITIONS_TABLE` env + control IAM grant | Modify |

---

## Task 1: Add `gp-positions` table, env var, and control IAM grant

**Files:**
- Modify: `template.yaml` (table after `WatchlistTable` ~line 205; `Globals` env ~line 103; control IAM ~line 369)

**Interfaces:**
- Produces: a `gp-positions` DynamoDB table; `POSITIONS_TABLE` env var on all functions; CRUD IAM for the control Lambda.

- [ ] **Step 1: Add the table resource** after the `WatchlistTable` block (after line 205):

```yaml
  # Manual position tracking (separate from research outcomes). Two pk namespaces:
  #   POSITION#<ticker> — POSITION_HEADER + BUY_EVENT/SELL_EVENT rows
  #   DECISION#<ticker> — /skip decision rows
  #   MUTATION#<update_id> — Telegram update_id dedupe markers (TTL-expiring)
  # pk = S (HASH), sk = S (RANGE). TTL on `ttl` applies ONLY to dedupe markers;
  # position/decision rows omit `ttl` and never expire (Retain everything).
  # Design: docs/superpowers/specs/2026-06-23-manual-position-tracking-design.md
  PositionsTable:
    Type: AWS::DynamoDB::Table
    DeletionPolicy: Retain
    UpdateReplacePolicy: Retain
    Properties:
      TableName: gp-positions
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - AttributeName: pk
          AttributeType: S
        - AttributeName: sk
          AttributeType: S
      KeySchema:
        - AttributeName: pk
          KeyType: HASH
        - AttributeName: sk
          KeyType: RANGE
      TimeToLiveSpecification:
        AttributeName: ttl
        Enabled: true
      Tags:
        - Key: Project
          Value: gerchik-perchik
```

- [ ] **Step 2: Add the env var** to `Globals.Function.Environment.Variables` (after `WATCHLIST_TABLE: !Ref WatchlistTable`, line 106):

```yaml
        POSITIONS_TABLE: !Ref PositionsTable
```

- [ ] **Step 3: Grant the control Lambda CRUD** on the table. In `ControlFunction.Properties.Policies`, after the `DynamoDBReadPolicy` on `OutcomesTable` (line 369), add:

```yaml
        # /bought /sell /skip /positions read+write gp-positions (+ update_id dedupe markers).
        - DynamoDBCrudPolicy:
            TableName: !Ref PositionsTable
```

- [ ] **Step 4: Validate the template**

Run: `npm run validate`
Expected: `template.yaml is a valid SAM Template` (no errors).

- [ ] **Step 5: Commit**

```bash
git checkout -b feat/manual-position-tracking
git add template.yaml
git commit -m "feat: add gp-positions table, POSITIONS_TABLE env, control CRUD grant"
```

---

## Task 2: `positions.mjs` pure builders + P/L math

**Files:**
- Create: `lambdas/shared/positions.mjs`
- Test: `tests/positions.test.mjs`

**Interfaces:**
- Produces:
  - `buildPositionHeader({ ticker, shares, price, entryDate, positionId, boughtAt, linkedOutcome?, currentStrategyVersion, commandSource? }) -> headerItem`
  - `buildBuyEvent({ ticker, positionId, entryDate, shares, price, boughtAt, commandSource? }) -> buyEventItem`
  - `applySell(header, { sharesSold, sellPrice, soldAt, commandSource? }) -> { error } | { event, updatedFields, closed, saleDollars, salePct }`
  - `buildDecision({ ticker, skippedAt, id, linkedOutcome?, currentStrategyVersion, reason?, commandSource? }) -> decisionItem`
  - `linkedOutcome` shape: `{ pk, sk, strategyVersion, stop, entryDate }` or `null`.

- [ ] **Step 1: Write the failing test** — create `tests/positions.test.mjs`:

```javascript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/positions.test.mjs`
Expected: FAIL — `Cannot find module '.../lambdas/shared/positions.mjs'`.

- [ ] **Step 3: Implement `lambdas/shared/positions.mjs`**

```javascript
// positions.mjs — pure builders + P/L math for manual position tracking.
// No I/O, no clock, no RNG: positionId/id and timestamps are injected by the
// caller so every function is deterministic and unit-testable. The control
// handler supplies real crypto.randomUUID() ids and ISO timestamps.

export const positionPk = (ticker) => `POSITION#${ticker}`;
export const decisionPk = (ticker) => `DECISION#${ticker}`;

// Round to 2dp at the value boundary; null for non-finite input.
const round2 = (v) =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null;

// POSITION_HEADER for a fresh buy (v1: exactly one buy per position).
// linkedOutcome: { pk, sk, strategyVersion, stop, entryDate } | null.
export function buildPositionHeader({
  ticker,
  shares,
  price,
  entryDate,
  positionId,
  boughtAt,
  linkedOutcome = null,
  currentStrategyVersion,
  commandSource = "telegram",
}) {
  const linked = !!linkedOutcome;
  return {
    pk: positionPk(ticker),
    sk: `${entryDate}#${positionId}`,
    recordType: "POSITION_HEADER",
    ticker,
    status: "OPEN",
    positionId,
    entryDate,
    originalShares: shares,
    remainingShares: shares,
    avgEntryPrice: price,
    actualEntry: price,
    actualEntryValue: round2(shares * price),
    boughtAt,
    soldAt: null,
    closedAt: null,
    realizedProfitDollars: 0,
    realizedProfitPctWeighted: null,
    costBasisSoldCumulative: 0,
    linked,
    sourceOutcomePk: linkedOutcome?.pk ?? null,
    sourceOutcomeSk: linkedOutcome?.sk ?? null,
    strategyVersion: linkedOutcome?.strategyVersion ?? currentStrategyVersion ?? null,
    initialStop: linkedOutcome?.stop ?? null,
    currentTrailStop: linkedOutcome?.stop ?? null,
    trailModel: "none",
    pnlBasis: "actual-fill",
    commandSource,
    notes: null,
  };
}

export function buildBuyEvent({
  ticker,
  positionId,
  entryDate,
  shares,
  price,
  boughtAt,
  commandSource = "telegram",
}) {
  return {
    pk: positionPk(ticker),
    sk: `${entryDate}#${positionId}#BUY#${boughtAt}`,
    recordType: "BUY_EVENT",
    ticker,
    positionId,
    shares,
    price,
    boughtAt,
    commandSource,
  };
}

// Apply a sell against a POSITION_HEADER. Average-cost; actual-fill P/L only.
// Returns { error, held? } on rejection, else { event, updatedFields, closed,
// saleDollars, salePct }. updatedFields are the header attributes to SET.
export function applySell(header, { sharesSold, sellPrice, soldAt, commandSource = "telegram" }) {
  if (!Number.isInteger(sharesSold) || sharesSold <= 0) return { error: "invalid-shares" };
  const remaining = header.remainingShares;
  if (sharesSold > remaining) return { error: "oversell", held: remaining };

  const avgEntryPriceAtSale = header.avgEntryPrice;
  const saleDollars = round2((sellPrice - avgEntryPriceAtSale) * sharesSold);
  const salePct = round2((sellPrice / avgEntryPriceAtSale - 1) * 100);
  const remainingSharesAfter = remaining - sharesSold;
  const realizedProfitDollars = round2((header.realizedProfitDollars ?? 0) + saleDollars);
  const costBasisSoldCumulative = round2(
    (header.costBasisSoldCumulative ?? 0) + avgEntryPriceAtSale * sharesSold
  );
  const realizedProfitPctWeighted =
    costBasisSoldCumulative > 0
      ? round2((realizedProfitDollars / costBasisSoldCumulative) * 100)
      : null;
  const closed = remainingSharesAfter === 0;

  const event = {
    pk: header.pk,
    sk: `${header.entryDate}#${header.positionId}#SELL#${soldAt}`,
    recordType: "SELL_EVENT",
    ticker: header.ticker,
    positionId: header.positionId,
    sharesSold,
    sellPrice,
    avgEntryPriceAtSale,
    realizedProfitDollars: saleDollars,
    realizedProfitPct: salePct,
    remainingSharesAfter,
    soldAt,
    commandSource,
  };

  const updatedFields = {
    remainingShares: remainingSharesAfter,
    realizedProfitDollars,
    costBasisSoldCumulative,
    realizedProfitPctWeighted,
    status: closed ? "CLOSED" : "OPEN",
    ...(closed ? { soldAt, closedAt: soldAt } : {}),
  };

  return { event, updatedFields, closed, saleDollars, salePct };
}

export function buildDecision({
  ticker,
  skippedAt,
  id,
  linkedOutcome = null,
  currentStrategyVersion,
  reason = null,
  commandSource = "telegram",
}) {
  const linked = !!linkedOutcome;
  return {
    pk: decisionPk(ticker),
    sk: `${skippedAt}#${id}`,
    recordType: "DECISION",
    decision: "SKIPPED",
    ticker,
    skippedAt,
    linked,
    sourceOutcomePk: linkedOutcome?.pk ?? null,
    sourceOutcomeSk: linkedOutcome?.sk ?? null,
    strategyVersion: linkedOutcome?.strategyVersion ?? currentStrategyVersion ?? null,
    reason,
    commandSource,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/positions.test.mjs`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add lambdas/shared/positions.mjs tests/positions.test.mjs
git commit -m "feat: positions.mjs pure builders + average-cost P/L math"
```

---

## Task 3: `store.mjs` DynamoDB methods for positions

**Files:**
- Modify: `lambdas/shared/store.mjs` (imports line 15-21; `createStore` signature line 108; add methods before the closing `};` at line 312)
- Test: `tests/store.test.mjs` (append)

**Interfaces:**
- Consumes: `positions.mjs` builders' row shapes (header/event/decision items).
- Produces (on the object returned by `createStore`):
  - `findLatestOpenOutcome(ticker) -> { pk, sk, strategyVersion, stop, entryDate } | null`
  - `getOpenPosition(ticker) -> headerItem | null`
  - `createPosition(header, buyEvent) -> { created: true, pk, sk }`
  - `recordSell(header, sellResult) -> { recorded: true }` (sellResult = the `applySell` return)
  - `recordDecision(decision) -> { recorded: true }`
  - `listOpenPositions() -> headerItem[]`
  - `claimUpdateId(updateId, ttlEpochSec) -> { claimed: boolean }`
- `createStore` accepts a new option `positionsTable` (defaults to `process.env.POSITIONS_TABLE`).

- [ ] **Step 1: Write the failing tests** — append to `tests/store.test.mjs`:

```javascript
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/store.test.mjs`
Expected: FAIL — `store.findLatestOpenOutcome is not a function` (and the rest).

- [ ] **Step 3: Update imports** in `lambdas/shared/store.mjs` (lines 16-21) to add `QueryCommand` and `TransactWriteCommand`:

```javascript
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
```

- [ ] **Step 4: Add `positionsTable` to `createStore`** — change line 108-112:

```javascript
export function createStore({ client, snapshotsTable, outcomesTable, watchlistTable, positionsTable } = {}) {
  const doc = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const snapTable = snapshotsTable ?? process.env.SNAPSHOTS_TABLE;
  const outTable = outcomesTable ?? process.env.OUTCOMES_TABLE;
  const watchTable = watchlistTable ?? process.env.WATCHLIST_TABLE;
  const posTable = positionsTable ?? process.env.POSITIONS_TABLE;
```

- [ ] **Step 5: Add the new methods** — insert before the final `};` that closes the returned object (currently line 311, right after `listOutcomesByStatus`):

```javascript
    // Latest OPEN research outcome for a ticker (links a /bought or /skip to its
    // source signal). Small table → prefix+status scan; picks the highest sk.
    // TODO(#46): replace the scan with a TICKER#/STATUS# GSI Query if outcomes grow.
    async findLatestOpenOutcome(ticker) {
      const prefix = `SIGNAL#${ticker}#`;
      let best = null;
      let ExclusiveStartKey;
      do {
        const out = await doc.send(
          new ScanCommand({
            TableName: outTable,
            FilterExpression: "begins_with(pk, :p) AND #s = :open",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":p": prefix, ":open": "OPEN" },
            ExclusiveStartKey,
          })
        );
        for (const it of out.Items ?? []) {
          if (!best || it.sk > best.sk) best = it;
        }
        ExclusiveStartKey = out.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      if (!best) return null;
      return {
        pk: best.pk,
        sk: best.sk,
        strategyVersion: best.strategyVersion ?? null,
        stop: best.stop ?? null,
        entryDate: best.entryDate ?? null,
      };
    },

    // The single OPEN position header for a ticker (v1: at most one). null if none.
    async getOpenPosition(ticker) {
      const out = await doc.send(
        new QueryCommand({
          TableName: posTable,
          KeyConditionExpression: "pk = :pk",
          FilterExpression: "recordType = :h AND #s = :open",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":pk": `POSITION#${ticker}`,
            ":h": "POSITION_HEADER",
            ":open": "OPEN",
          },
        })
      );
      return (out.Items ?? [])[0] ?? null;
    },

    // Create a position: header (conditional on key absence) + its first buy
    // event, atomically. The "one open per ticker" rule is enforced by the
    // caller (getOpenPosition check) before this runs.
    async createPosition(header, buyEvent) {
      await doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: posTable,
                Item: header,
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            { Put: { TableName: posTable, Item: buyEvent } },
          ],
        })
      );
      return { created: true, pk: header.pk, sk: header.sk };
    },

    // Record a sell: update the header (optimistic lock on remainingShares to
    // block a double-decrement) + put the SELL_EVENT, atomically. sellResult is
    // the object returned by positions.applySell.
    async recordSell(header, sellResult) {
      const { event, updatedFields } = sellResult;
      const sets = [];
      const names = {};
      const values = { ":expected": header.remainingShares };
      for (const [k, v] of Object.entries(updatedFields)) {
        sets.push(`#${k} = :${k}`);
        names[`#${k}`] = k;
        values[`:${k}`] = v;
      }
      await doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: posTable,
                Key: { pk: header.pk, sk: header.sk },
                UpdateExpression: "SET " + sets.join(", "),
                ExpressionAttributeNames: names,
                ExpressionAttributeValues: values,
                ConditionExpression: "remainingShares = :expected",
              },
            },
            { Put: { TableName: posTable, Item: event } },
          ],
        })
      );
      return { recorded: true };
    },

    // Record a /skip decision row.
    async recordDecision(decision) {
      await doc.send(new PutCommand({ TableName: posTable, Item: decision }));
      return { recorded: true };
    },

    // All OPEN position headers (for /positions). Small table → paginated scan.
    async listOpenPositions() {
      const items = [];
      let ExclusiveStartKey;
      do {
        const out = await doc.send(
          new ScanCommand({
            TableName: posTable,
            FilterExpression: "recordType = :h AND #s = :open",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":h": "POSITION_HEADER", ":open": "OPEN" },
            ExclusiveStartKey,
          })
        );
        items.push(...(out.Items ?? []));
        ExclusiveStartKey = out.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return items;
    },

    // Idempotency guard for mutating Telegram commands. Conditionally write a
    // MUTATION#<update_id> marker; a retried delivery fails the condition and is
    // dropped before any share math. ttlEpochSec auto-expires the marker.
    async claimUpdateId(updateId, ttlEpochSec) {
      try {
        await doc.send(
          new PutCommand({
            TableName: posTable,
            Item: {
              pk: `MUTATION#${updateId}`,
              sk: "claim",
              ttl: ttlEpochSec,
              claimedAt: new Date().toISOString(),
            },
            ConditionExpression: "attribute_not_exists(pk)",
          })
        );
        return { claimed: true };
      } catch (err) {
        if (err?.name === "ConditionalCheckFailedException") return { claimed: false };
        throw err;
      }
    },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/store.test.mjs`
Expected: PASS — existing store tests plus the 11 new ones green.

- [ ] **Step 7: Commit**

```bash
git add lambdas/shared/store.mjs tests/store.test.mjs
git commit -m "feat: store methods for positions, decisions, outcome linkage, dedupe"
```

---

## Task 4: Command parser + reply formatters

**Files:**
- Modify: `lambdas/control/commands.mjs` (`HELP` line 4-13; `parseCommand` line 17-32; append new exports)
- Test: `tests/control.test.mjs` (append)

**Interfaces:**
- Produces:
  - `parseTradeArgs(args) -> { ok: true, ticker, shares, price } | { ok: false, error }`
  - `formatBought(header) -> string`
  - `formatSell(sellResult, header, sharesSold, sellPrice) -> string`
  - `formatSkip(decision) -> string`
  - `formatPositions(headers) -> string`
- Consumes: `parseCommand` now upper-cases the ticker arg for `bought`/`sell`/`skip` too.

- [ ] **Step 1: Write the failing tests** — append to `tests/control.test.mjs`. First add the imports at the top (extend the existing import from `commands.mjs`):

```javascript
import {
  parseCommand,
  computeStats,
  formatStats,
  formatAlarm,
  formatEt,
  parseTradeArgs,
  formatBought,
  formatSell,
  formatSkip,
  formatPositions,
} from "../lambdas/control/commands.mjs";
```

Then append these tests:

```javascript
test("parseCommand upper-cases tickers for bought/sell/skip", () => {
  assert.equal(parseCommand("/bought nvda 20 249.99").arg, "NVDA");
  assert.deepEqual(parseCommand("/bought nvda 20 249.99").args, ["nvda", "20", "249.99"]);
  assert.equal(parseCommand("/sell nvda 10 260").arg, "NVDA");
  assert.equal(parseCommand("/skip amd too extended").arg, "AMD");
  assert.equal(parseCommand("/positions").cmd, "positions");
});

test("parseTradeArgs validates ticker/shares/price", () => {
  assert.deepEqual(parseTradeArgs(["nvda", "20", "249.99"]), { ok: true, ticker: "NVDA", shares: 20, price: 249.99 });
  assert.equal(parseTradeArgs(["NVDA", "20"]).ok, false); // missing price
  assert.equal(parseTradeArgs(["NVDA", "2.5", "10"]).error, "shares"); // non-integer
  assert.equal(parseTradeArgs(["NVDA", "0", "10"]).error, "shares"); // non-positive
  assert.equal(parseTradeArgs(["NVDA", "10", "0"]).error, "price"); // non-positive
  assert.equal(parseTradeArgs(["NVDA", "10", "abc"]).error, "price"); // NaN
});

test("formatBought distinguishes linked vs unlinked", () => {
  const linked = { ticker: "NVDA", originalShares: 20, actualEntry: 249.99, linked: true, sourceOutcomePk: "SIGNAL#NVDA#2026-06-20", entryDate: "2026-06-23" };
  assert.match(formatBought(linked), /✅ Bought NVDA 20 @ 249\.99\./);
  assert.match(formatBought(linked), /Linked to latest GP signal \(entry 2026-06-20\)/);
  const unlinked = { ticker: "AMD", originalShares: 5, actualEntry: 100, linked: false, sourceOutcomePk: null, entryDate: "2026-06-23" };
  assert.match(formatBought(unlinked), /No open GP signal found — position created as manual\/unlinked/);
});

test("formatSell renders partial and full close", () => {
  const header = { ticker: "NVDA" };
  const partial = { closed: false, saleDollars: 100.1, salePct: 4, updatedFields: { remainingShares: 10 } };
  assert.match(formatSell(partial, header, 10, 260), /📉 Sold 10 NVDA @ 260\.00 \(\+4\.00%, \+\$100\.10\)\. 10 remain open\./);
  const full = { closed: true, updatedFields: { realizedProfitDollars: 200.2, realizedProfitPctWeighted: 4 } };
  assert.match(formatSell(full, header, 10, 265), /🏁 Closed NVDA\. Realized \+\$200\.20 \(\+4\.00% weighted\)\./);
});

test("formatSkip + formatPositions", () => {
  assert.match(formatSkip({ ticker: "NVDA", linked: true }), /⏭️ Skipped NVDA \(linked to GP signal\)\./);
  assert.match(formatSkip({ ticker: "AMD", linked: false }), /⏭️ Skipped AMD \(unlinked\)\./);
  assert.match(formatPositions([]), /No open positions\./);
  const list = formatPositions([
    { ticker: "NVDA", remainingShares: 10, originalShares: 20, avgEntryPrice: 100, realizedProfitDollars: 100, linked: true },
  ]);
  assert.match(list, /NVDA 10\/20 @ 100\.00/);
  assert.match(list, /realized \+\$100\.00/);
  assert.match(list, /linked/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/control.test.mjs`
Expected: FAIL — `parseTradeArgs is not a function`.

- [ ] **Step 3: Update `HELP`** (lines 4-13) to add the new commands:

```javascript
export const HELP = [
  "Gerchik-Perchik control:",
  "/start — enable the scanner + labeler schedules",
  "/stop — disable them",
  "/mode observe|live — set alert mode (live is a human decision)",
  "/enable <TICKER> — add a ticker to the active scan",
  "/disable <TICKER> — remove it",
  "/stats [30d] — outcome summary for the current strategy version",
  "/analyze [30d] — Phase 8 deep-dive: profit factor + component predictors",
  "/bought <TICKER> <SHARES> <PRICE> — confirm a manual buy (links latest GP signal)",
  "/sell <TICKER> <SHARES> <PRICE> — sell part or all of an open position",
  "/skip <TICKER> [reason] — record that you skipped a signal",
  "/positions — list open positions",
].join("\n");
```

- [ ] **Step 4: Update `parseCommand`** (lines 24-30) to upper-case tickers for the new commands:

```javascript
  const rawArg = parts[1] ?? null;
  // Tickers are upper-cased; mode/stats args stay lower-case.
  const TICKER_CMDS = new Set(["enable", "disable", "bought", "sell", "skip"]);
  const arg = rawArg
    ? TICKER_CMDS.has(cmd)
      ? rawArg.toUpperCase()
      : rawArg.toLowerCase()
    : null;
```

- [ ] **Step 5: Append the parser + formatters** to the end of `lambdas/control/commands.mjs`:

```javascript
// Parse "/bought TICKER SHARES PRICE" / "/sell TICKER SHARES PRICE" args
// (the parts after the command token). SHARES must be a positive integer;
// PRICE a positive number. Returns {ok:true, ticker, shares, price} or
// {ok:false, error:"usage"|"shares"|"price"}.
export function parseTradeArgs(args) {
  if (!args || args.length < 3) return { ok: false, error: "usage" };
  const ticker = String(args[0]).toUpperCase();
  const shares = Number(args[1]);
  const price = Number(args[2]);
  if (!Number.isInteger(shares) || shares <= 0) return { ok: false, error: "shares" };
  if (!Number.isFinite(price) || price <= 0) return { ok: false, error: "price" };
  return { ok: true, ticker, shares, price };
}

const fmtMoney = (n) => `${n < 0 ? "-" : "+"}$${Math.abs(n).toFixed(2)}`;
const fmtPct = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

export function formatBought(header) {
  const base = `✅ Bought ${header.ticker} ${header.originalShares} @ ${header.actualEntry.toFixed(2)}.`;
  if (!header.linked) {
    return `${base} No open GP signal found — position created as manual/unlinked.`;
  }
  const signalDate = header.sourceOutcomePk?.split("#")[2] ?? header.entryDate;
  return `${base} Linked to latest GP signal (entry ${signalDate}).`;
}

export function formatSell(sellResult, header, sharesSold, sellPrice) {
  const { closed, saleDollars, salePct, updatedFields } = sellResult;
  if (closed) {
    return `🏁 Closed ${header.ticker}. Realized ${fmtMoney(updatedFields.realizedProfitDollars)} (${fmtPct(updatedFields.realizedProfitPctWeighted)} weighted).`;
  }
  return `📉 Sold ${sharesSold} ${header.ticker} @ ${sellPrice.toFixed(2)} (${fmtPct(salePct)}, ${fmtMoney(saleDollars)}). ${updatedFields.remainingShares} remain open.`;
}

export function formatSkip(decision) {
  return decision.linked
    ? `⏭️ Skipped ${decision.ticker} (linked to GP signal).`
    : `⏭️ Skipped ${decision.ticker} (unlinked).`;
}

export function formatPositions(headers) {
  if (!headers.length) return "No open positions.";
  const lines = ["📂 Open positions:"];
  for (const h of headers) {
    const realized = fmtMoney(h.realizedProfitDollars ?? 0);
    lines.push(
      `• ${h.ticker} ${h.remainingShares}/${h.originalShares} @ ${h.avgEntryPrice.toFixed(2)} · realized ${realized}${h.linked ? " · linked" : ""}`
    );
  }
  return lines.join("\n");
}
```

- [ ] **Step 6: Run to verify pass**

Run: `node --test tests/control.test.mjs`
Expected: PASS — existing control tests plus the 5 new ones green.

- [ ] **Step 7: Commit**

```bash
git add lambdas/control/commands.mjs tests/control.test.mjs
git commit -m "feat: parse /bought /sell /skip /positions + reply formatters"
```

---

## Task 5: Control handler integration + `update_id` dedupe

**Files:**
- Modify: `lambdas/control/handler.mjs` (imports line 17-24; `handler` dispatch call line 62; `dispatch` line 78-140)
- Test: `tests/control-dispatch.test.mjs` (create)

**Interfaces:**
- Consumes: all `store` methods from Task 3, all `positions.mjs` builders from Task 2, all `commands.mjs` formatters from Task 4.
- Produces: `export async function dispatch(text, deps)` where `deps = { store?, nowIso?, nowMs?, genId?, updateId? }` (defaults: real `createStore()`, `new Date().toISOString()`, `Date.now()`, `randomUUID`). Handler passes `{ updateId: update?.update_id }`.

- [ ] **Step 1: Write the failing tests** — create `tests/control-dispatch.test.mjs`:

```javascript
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/control-dispatch.test.mjs`
Expected: FAIL — `dispatch` is not exported / not a function.

- [ ] **Step 3: Update imports** in `lambdas/control/handler.mjs` (lines 17-24). Add `randomUUID`, the position builders, and the new command helpers:

```javascript
import { randomUUID } from "node:crypto";
import { getParameter } from "../shared/ssm.mjs";
import { sendTelegram } from "../shared/telegram.mjs";
import { setScheduleEnabled } from "../shared/schedule.mjs";
import { setAlertMode } from "../shared/config.mjs";
import { createStore } from "../shared/store.mjs";
import { STRATEGY_VERSION } from "../shared/version.mjs";
import {
  parseCommand,
  computeStats,
  formatStats,
  formatAlarm,
  HELP,
  parseTradeArgs,
  formatBought,
  formatSell,
  formatSkip,
  formatPositions,
} from "./commands.mjs";
import { buildPositionHeader, buildBuyEvent, applySell, buildDecision } from "../shared/positions.mjs";
import { analyze, formatAnalysis } from "./analytics.mjs";

const DEDUPE_TTL_SEC = 24 * 60 * 60;
```

- [ ] **Step 4: Pass `update_id` into dispatch** — change the call in `handler` (line 62) from `reply = await dispatch(text);` to:

```javascript
    reply = await dispatch(text, { updateId: update?.update_id });
```

- [ ] **Step 5: Convert `dispatch` to take injectable deps and add the new cases.** Replace the signature line (`async function dispatch(text) {`, line 78) and add the new cases before `default:` (line 137). The new signature/header:

```javascript
// Run a command and return the reply text (or null to stay silent). Deps are
// injectable for unit tests; defaults use real I/O + clock + id generator.
export async function dispatch(text, deps = {}) {
  const parsed = parseCommand(text);
  if (!parsed) return null; // not a command

  const store = deps.store ?? createStore();
  const nowIso = deps.nowIso ?? new Date().toISOString();
  const nowMs = deps.nowMs ?? Date.now();
  const genId = deps.genId ?? randomUUID;
  const { updateId } = deps;
  const ttlEpochSec = Math.floor(nowMs / 1000) + DEDUPE_TTL_SEC;
  // Claim a Telegram update_id once; a retried delivery returns false → drop.
  const claim = async () =>
    updateId == null ? true : (await store.claimUpdateId(updateId, ttlEpochSec)).claimed;
```

The new cases (insert just before `default:`):

```javascript
    case "bought": {
      const t = parseTradeArgs(parsed.args);
      if (!t.ok) return "Usage: /bought <TICKER> <SHARES> <PRICE>  e.g. /bought NVDA 20 249.99";
      if (!(await claim())) return null;
      if (await store.getOpenPosition(t.ticker)) {
        return `Open position already exists for ${t.ticker}. Close or sell partial first.`;
      }
      const linkedOutcome = await store.findLatestOpenOutcome(t.ticker);
      const entryDate = nowIso.slice(0, 10);
      const positionId = genId();
      const header = buildPositionHeader({
        ticker: t.ticker, shares: t.shares, price: t.price, entryDate,
        positionId, boughtAt: nowIso, linkedOutcome, currentStrategyVersion: STRATEGY_VERSION,
      });
      const buyEvent = buildBuyEvent({
        ticker: t.ticker, positionId, entryDate, shares: t.shares, price: t.price, boughtAt: nowIso,
      });
      await store.createPosition(header, buyEvent);
      return formatBought(header);
    }
    case "sell": {
      const t = parseTradeArgs(parsed.args);
      if (!t.ok) return "Usage: /sell <TICKER> <SHARES> <PRICE>  e.g. /sell NVDA 10 260.00";
      if (!(await claim())) return null;
      const header = await store.getOpenPosition(t.ticker);
      if (!header) return `No open ${t.ticker} position.`;
      const result = applySell(header, { sharesSold: t.shares, sellPrice: t.price, soldAt: nowIso });
      if (result.error === "oversell") return `You hold ${result.held} ${t.ticker}; can't sell ${t.shares}.`;
      if (result.error) return `Invalid sell quantity for ${t.ticker}.`;
      await store.recordSell(header, result);
      return formatSell(result, header, t.shares, t.price);
    }
    case "skip": {
      if (!parsed.arg) return "Usage: /skip <TICKER> [reason]";
      if (!(await claim())) return null;
      const ticker = parsed.arg;
      const reason = parsed.args.slice(1).join(" ") || null;
      const linkedOutcome = await store.findLatestOpenOutcome(ticker);
      const decision = buildDecision({
        ticker, skippedAt: nowIso, id: genId(), linkedOutcome,
        currentStrategyVersion: STRATEGY_VERSION, reason,
      });
      await store.recordDecision(decision);
      return formatSkip(decision);
    }
    case "positions": {
      return formatPositions(await store.listOpenPositions());
    }
```

- [ ] **Step 6: Run to verify pass**

Run: `node --test tests/control-dispatch.test.mjs`
Expected: PASS — all 11 dispatch tests green.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS — every test file green (no regressions in scanner-health, labeling, scoring, etc.).

- [ ] **Step 8: Commit**

```bash
git add lambdas/control/handler.mjs tests/control-dispatch.test.mjs
git commit -m "feat: wire /bought /sell /skip /positions with update_id dedupe"
```

---

## Task 6: Deploy, smoke test, and manual Telegram verification

**Files:** none changed — this task validates, deploys, and verifies the deployed feature, then opens the PR.

**Pre-deploy gate:**

- [ ] **Step 1: Full local verification**

Run: `npm test && npm run validate`
Expected: all tests PASS; `template.yaml is a valid SAM Template`.

- [ ] **Step 2: Confirm identity + region before deploying**

Run: `aws sts get-caller-identity && cat samconfig.toml`
Expected: the expected account id; `region = "us-east-1"`.

- [ ] **Step 3: Build + deploy**

```bash
npm run build
sam deploy
```
Expected: CloudFormation creates `PositionsTable` (`gp-positions`), updates `gp-control` (new env var + IAM). No changes to scanner/labeler/funnel function code beyond the shared bundle.

- [ ] **Step 4: Confirm the table exists and TTL is enabled**

```bash
aws dynamodb describe-table --table-name gp-positions --region us-east-1 \
  --query "Table.{Status:TableStatus,Keys:KeySchema}"
aws dynamodb describe-time-to-live --table-name gp-positions --region us-east-1
```
Expected: `Status: ACTIVE`, HASH `pk` / RANGE `sk`; TTL `ENABLED` on `ttl`.

**Manual Telegram verification** (from the dedicated GP channel; observe the bot replies and inspect DynamoDB):

- [ ] **Step 5: Verify `/bought` (unlinked)** — pick a ticker with no open outcome, e.g. `/bought TSLA 3 200`
  - Expect reply: `✅ Bought TSLA 3 @ 200.00. No open GP signal found — position created as manual/unlinked.`
  - Verify the row:
    ```bash
    aws dynamodb query --table-name gp-positions --region us-east-1 \
      --key-condition-expression "pk = :p" \
      --expression-attribute-values '{":p":{"S":"POSITION#TSLA"}}'
    ```
    Expect a `POSITION_HEADER` (`status=OPEN`, `linked=false`, `remainingShares=3`, `pnlBasis=actual-fill`, `commandSource=telegram`) and a `BUY_EVENT`.

- [ ] **Step 6: Verify `/bought` rejects a second open position** — `/bought TSLA 1 205`
  - Expect reply: `Open position already exists for TSLA. Close or sell partial first.`
  - Verify no new header/buy event was added (re-run the query from Step 5; still one header).

- [ ] **Step 7: Verify `/bought` (linked)** — pick a ticker that has an OPEN `gp-outcomes` row (check `/stats` or the funnel report for a recent open signal), e.g. `/bought <LINKED_TICKER> 2 <price>`
  - Expect reply containing `Linked to latest GP signal (entry <date>)`.
  - Verify the header has `linked=true`, `sourceOutcomePk`/`sourceOutcomeSk` set, and `initialStop` copied from the outcome's `stop`.

- [ ] **Step 8: Verify `/positions`** — `/positions`
  - Expect a list including `TSLA 3/3 @ 200.00 · realized +$0.00` and the linked ticker.

- [ ] **Step 9: Verify `/sell` (partial)** — `/sell TSLA 1 210`
  - Expect reply: `📉 Sold 1 TSLA @ 210.00 (+5.00%, +$10.00). 2 remain open.`
  - Verify a `SELL_EVENT` row exists and the header now has `remainingShares=2`, `realizedProfitDollars=10`, `status=OPEN`.

- [ ] **Step 10: Verify `/sell` over-sell rejection** — `/sell TSLA 9 210`
  - Expect reply: `You hold 2 TSLA; can't sell 9.` and no new `SELL_EVENT`.

- [ ] **Step 11: Verify `/sell` (full close)** — `/sell TSLA 2 220`
  - Expect reply: `🏁 Closed TSLA. Realized +$50.00 (+8.33% weighted).` (10 + 40 dollars; weighted 50/600·100 ≈ 8.33%).
  - Verify the header is `status=CLOSED` with `soldAt`/`closedAt` set, `remainingShares=0`.

- [ ] **Step 12: Verify `/skip`** — `/skip AMD too extended`
  - Expect reply: `⏭️ Skipped AMD (...)`.
  - Verify a `DECISION#AMD` row exists (`decision=SKIPPED`, `reason="too extended"`).

- [ ] **Step 13: Verify `update_id` dedupe markers** — after the mutating commands above, confirm markers exist:
    ```bash
    aws dynamodb scan --table-name gp-positions --region us-east-1 \
      --filter-expression "begins_with(pk, :m)" \
      --expression-attribute-values '{":m":{"S":"MUTATION#"}}' \
      --query "Items[].pk"
    ```
    Expect one `MUTATION#<update_id>` per mutating command sent. (Telegram assigns a unique `update_id` per delivery; a retry of the same delivery reuses the id, so the conditional write drops it — proven authoritatively by the `tests/control-dispatch.test.mjs` "retried /sell is dropped" unit test.)

- [ ] **Step 14: Verify `gp-outcomes` is UNTOUCHED**
    ```bash
    aws dynamodb scan --table-name gp-outcomes --region us-east-1 --select COUNT
    ```
    Run before Step 5 and again after Step 13 — the count and item contents must be identical. The feature only *reads* `gp-outcomes` (linkage); confirm no row gained a `skipped`/position attribute and no `status` flipped. Also confirm the labeler still sees the same OPEN set (no position rows leaked in): the scan above plus `aws dynamodb scan --table-name gp-outcomes --filter-expression "#s = :o" --expression-attribute-names '{"#s":"status"}' --expression-attribute-values '{":o":{"S":"OPEN"}}' --select COUNT --region us-east-1`.

- [ ] **Step 15: Open the PR**

```bash
git push -u origin feat/manual-position-tracking
gh pr create --title "feat: manual position confirmation & tracking (gp-positions)" \
  --body "Implements docs/superpowers/specs/2026-06-23-manual-position-tracking-design.md. New gp-positions table (Retain) + /bought /sell /skip /positions on the control Lambda, separate from gp-outcomes research tracking. v1: one open position per ticker, partial sells, actual-fill P/L, update_id dedupe. Defers scale-ins, unrealized P/L, and the outcome-lookup GSI (#46)."
```

- [ ] **Step 16: Merge + deploy** (delegated to the agent per CLAUDE.md; this does NOT extend to `alertMode: live`, `STRATEGY_VERSION`, or `gp-config` trading-row writes — none of which this feature touches).

```bash
gh pr merge --squash --delete-branch
```
Then redeploy from `main` if the merge changed the bundle: `npm run build && sam deploy`.

---

## Rollback plan

- **Data is safe by construction.** `gp-positions` is `Retain` on delete + replace. Rolling back never deletes recorded positions/decisions.
- **Revert the behavior:** redeploy the previous control bundle (`git revert <merge commit>` → `npm run build && sam deploy`, or deploy the prior tag). With the new code gone, `/bought /sell /skip /positions` simply fall through to `HELP` (unknown command) — no errors, no data loss.
- **Leave the table in place** even after a behavior revert; it is empty-cost (`PAY_PER_REQUEST`) and preserves any rows already written. Only remove `PositionsTable` from `template.yaml` in a deliberate cleanup PR — and because of `Retain`, even that leaves the live table and data untouched (CloudFormation just stops managing it).
- **Partial-deploy failure:** if `sam deploy` fails mid-update, CloudFormation auto-rolls back the `gp-control` function to its prior version; the `Retain` table (if it was created) stays. Re-run `npm test && npm run validate` and redeploy.
- **No schedule/secret/cron changes** are part of this feature, so there is nothing to toggle back.

---

## Self-review (completed during planning)

- **Spec coverage:** table + namespaces (Task 1) · record shapes incl. `actualEntryValue`, `commandSource`, weighted-pct formula (Task 2) · linkage + one-open-per-ticker + partial sells + actual-fill P/L (Tasks 2/3/5) · `/skip` DECISION rows (Tasks 2/3/5) · `update_id` dedupe (Tasks 3/5) · `/positions` no-unrealized-P/L (Tasks 4/5) · GSI deferred to #46 (Task 3 TODO comment) · gp-outcomes untouched + verification (Task 6). All present.
- **Placeholder scan:** none — every code/test step is concrete.
- **Type consistency:** `linkedOutcome` shape `{pk, sk, strategyVersion, stop, entryDate}` is produced by `findLatestOpenOutcome` (Task 3) and consumed by `buildPositionHeader`/`buildDecision` (Task 2); `applySell` return `{event, updatedFields, closed, saleDollars, salePct}` is consumed identically by `recordSell` (Task 3) and `formatSell` (Task 4); `dispatch` deps shape matches between handler (Task 5) and the dispatch tests.
