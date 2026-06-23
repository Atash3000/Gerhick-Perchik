# Manual Position Confirmation & Tracking — Design

**Date:** 2026-06-23
**Status:** Approved design (no implementation yet)
**Strategy version at design time:** `gp-2.0.0`

---

## Goal

When the bot sends a BUY_CANDIDATE to Telegram, it must **not** assume the trade
was taken. The human confirms manually. This feature adds manual position
confirmation and tracking through Telegram commands, recording what was actually
bought/sold (actual fills) **separately** from the research/outcome tracking so
observe-mode research stays unpolluted by manual decisions.

This is the foundation a future trailing-exit (Tier-3) engine builds on: that
engine will manage only `status="OPEN"` real positions in the new table.

**Out of scope (v1):** Telegram buttons, broker integration, live order
execution, automatic buying, unrealized P/L, scale-ins.

---

## The one principle still holds

> **Math decides. AI only explains.**

Nothing here lets the LLM choose or alter a trade. These are deterministic
record-keeping commands driven by explicit human input.

---

## Decisions locked during brainstorming

1. **Separate table `gp-positions`** — never write to `gp-outcomes`. The labeler's
   `status="OPEN"` scan of `gp-outcomes` must never see manual-position rows.
2. **`/bought` auto-links** to the latest OPEN outcome for the ticker if one
   exists (most recent by `sk`), else creates a manual/unlinked position.
3. **One OPEN position per ticker in v1.** A second `/bought` while one is OPEN is
   rejected. **No scale-ins in v1** (deferred; event-log shape leaves room).
4. **Partial sells supported.** `/sell` can sell part or all of an OPEN position.
   Average-cost logic (trivial in v1 since there is one buy per position).
5. **Realized P/L uses actual fill prices only** — no modeled `feeBps`/`slippageBps`.
   Modeled costs belong to simulated research outcomes/backtests, not manual fills.
6. **`/skip` stores a DECISION row** in `gp-positions` under a `DECISION#` pk
   namespace — never a field on the outcome row.
7. **`update_id` dedupe is mandatory** for the three mutating commands
   (`/bought`, `/sell`, `/skip`) so a Telegram webhook retry cannot double-apply.
8. **Pure row-builders are deterministic** — `positions.mjs` never calls
   `crypto.randomUUID()` or `Date` internally; ids and timestamps are injected by
   the caller.

---

## Data model — new table `gp-positions`

`PAY_PER_REQUEST`, `DeletionPolicy: Retain`, `UpdateReplacePolicy: Retain`,
`Project: gerchik-perchik` tag — same conventions as the existing four tables.

Key schema: `pk` (S, HASH), `sk` (S, RANGE).

Four logical record types share the table, distinguished by `recordType`:

| recordType        | pk                   | sk                                         |
| ----------------- | -------------------- | ------------------------------------------ |
| `POSITION_HEADER` | `POSITION#<ticker>`  | `<entryDate>#<positionId>`                 |
| `BUY_EVENT`       | `POSITION#<ticker>`  | `<entryDate>#<positionId>#BUY#<ts>`        |
| `SELL_EVENT`      | `POSITION#<ticker>`  | `<entryDate>#<positionId>#SELL#<ts>`       |
| `DECISION` (skip) | `DECISION#<ticker>`  | `<skippedAt>#<id>`                         |
| dedupe marker     | `MUTATION#<update_id>` | `<ts>` (carries `ttl`, auto-expires)     |

A single `Query` on `pk=POSITION#<ticker>` with
`begins_with(sk, "<entryDate>#<positionId>")` returns the header plus its full
event log in order — the audit trail (sells are events, never an overwrite).

### TTL

`TimeToLiveSpecification` on attribute `ttl` is **enabled**, but used **only** by
the `MUTATION#<update_id>` dedupe markers (e.g. ~24h expiry). Position, event, and
decision rows omit `ttl` and therefore **never expire** — preserving the
Retain-everything rule that makes this history the point of the project.

---

## Record shapes

### POSITION_HEADER — `pk=POSITION#<ticker>`, `sk=<entryDate>#<positionId>`

```
recordType:                 "POSITION_HEADER"
ticker
status:                     "OPEN" | "CLOSED"
positionId                  // injected by caller (crypto.randomUUID() in handler)
entryDate:                  YYYY-MM-DD            // date of the buy
originalShares                                    // total ever bought (= buy shares in v1)
remainingShares                                   // decremented by sells; 0 => CLOSED
avgEntryPrice                                     // = actualEntry in v1 (single buy)
actualEntry                                       // the /bought price
actualEntryValue                                  // originalShares * actualEntry
boughtAt:                   ISO timestamp
soldAt:                     ISO timestamp | null  // set when fully closed
closedAt:                   ISO timestamp | null  // = soldAt of final sell
realizedProfitDollars                             // running sum across sell events; 0 until first sell
realizedProfitPctWeighted                         // realizedProfitDollars / costBasisSoldCumulative
costBasisSoldCumulative                           // sum(avgEntryPriceAtSale * sharesSold); helper for weighted pct
linked:                     true | false
sourceOutcomePk             // "SIGNAL#<ticker>#<entryDate>" | null
sourceOutcomeSk             // <entry epoch ms> | null
strategyVersion             // copied from linked outcome, else current STRATEGY_VERSION
initialStop                 // linked outcome.stop | null   (for future trailing engine)
currentTrailStop            // = initialStop at creation
trailModel:                 "none"                // placeholder until Tier-3 engine exists
pnlBasis:                   "actual-fill"         // not modeled after-cost
commandSource:              "telegram"
notes:                      string | null
```

**Weighted realized-pct formula (documented):**
`realizedProfitPctWeighted = realizedProfitDollars / costBasisSoldCumulative`

### BUY_EVENT — `sk=<entryDate>#<positionId>#BUY#<ts>`

```
recordType:     "BUY_EVENT"
ticker, positionId
shares
price
boughtAt:       ISO timestamp
commandSource:  "telegram"
```

One per position in v1. Modeled as an event now so scale-ins can be added later
without a schema change.

### SELL_EVENT — `sk=<entryDate>#<positionId>#SELL#<ts>`

```
recordType:              "SELL_EVENT"
ticker, positionId
sharesSold
sellPrice
avgEntryPriceAtSale                       // avgEntryPrice at moment of sale
realizedProfitDollars                     // (sellPrice - avgEntryPriceAtSale) * sharesSold
realizedProfitPct                         // sellPrice/avgEntryPriceAtSale - 1
remainingSharesAfter
soldAt:                  ISO timestamp
commandSource:           "telegram"
```

### DECISION (skip) — `pk=DECISION#<ticker>`, `sk=<skippedAt>#<id>`

```
recordType:       "DECISION"
decision:         "SKIPPED"
ticker
skippedAt:        ISO timestamp
linked:           true | false
sourceOutcomePk / sourceOutcomeSk   // latest OPEN outcome if any, else null
strategyVersion   // from linked outcome if linked, else current
reason:           string | null
commandSource:    "telegram"
```

Later analytics can compare bought vs skipped decisions without polluting
research outcomes.

---

## Linkage lookup

`findLatestOpenOutcome(ticker)`:

- Scans `gp-outcomes` with `begins_with(pk, "SIGNAL#<ticker>#")` and
  `status="OPEN"`; returns the row with the **highest `sk`** (most recent entry
  epoch), exposing `{pk, sk, strategyVersion, stop}`; `null` if none.
- A `Scan` is acceptable in v1 because the table is small — consistent with how
  `/stats` already scans `gp-outcomes`.
- The control Lambda already holds `DynamoDBReadPolicy` on `OutcomesTable`; no new
  read grant is needed.

**TODO (do NOT build in v1 unless needed):** if outcomes grow, add a GSI for
ticker/status lookup instead of scanning:
`GSI1PK = TICKER#<ticker>`, `GSI1SK = STATUS#<status>#<entryEpoch>`.
Track as a GitHub Issue.

---

## Command behaviors (control Lambda)

All three mutating commands (`/bought`, `/sell`, `/skip`) first attempt a
conditional dedupe claim on the Telegram `update_id` (`claimUpdateId`): a
`PutItem` of `MUTATION#<update_id>` with `attribute_not_exists(pk)`. On
`ConditionalCheckFailed`, the delivery is a retry and is dropped before any share
math runs.

### `/bought TICKER SHARES PRICE`  (e.g. `/bought NVDA 20 249.99`)

1. Validate: `SHARES` positive integer, `PRICE` positive number → else usage error.
2. Reject if an OPEN POSITION_HEADER already exists for the ticker:
   *"Open position already exists for NVDA. Close or sell partial first."*
3. `findLatestOpenOutcome(ticker)` → set `linked`, `sourceOutcomePk/Sk`,
   `strategyVersion`, and `initialStop`/`currentTrailStop` (from outcome `stop`).
4. Write POSITION_HEADER + BUY_EVENT.
5. Reply:
   - linked → *"✅ Bought NVDA 20 @ 249.99. Linked to latest GP signal (entry 2026-06-20)."*
   - unlinked → *"✅ Bought NVDA 20 @ 249.99. No open GP signal found — position created as manual/unlinked."*

### `/sell TICKER SHARES PRICE`

1. Validate numbers. Find the OPEN POSITION_HEADER for the ticker → none ⇒
   *"No open NVDA position."*
2. `SHARES > remainingShares` ⇒ reject: *"You hold 10 NVDA; can't sell 20."*
3. Compute sale P/L (actual-fill), write SELL_EVENT, update header:
   `remainingShares -= sold`, accumulate `realizedProfitDollars` and
   `costBasisSoldCumulative`, recompute `realizedProfitPctWeighted`.
4. `remainingShares == 0` ⇒ `status=CLOSED`, set `soldAt`/`closedAt`.
5. Reply distinguishes partial vs full close:
   - partial → *"📉 Sold 10 NVDA @ 260.00 (+4.00%, +$100.10). 10 remain open."*
   - full → *"🏁 Closed NVDA. Realized +$200.20 (+4.00% weighted)."*

### `/skip TICKER [reason]`

- `findLatestOpenOutcome(ticker)` for linkage; write DECISION row (trailing text
  becomes `reason`).
- Reply: *"⏭️ Skipped NVDA (linked to GP signal)."* / *"…(unlinked)."*

### `/positions`

- `Scan` `gp-positions` filtered `recordType=POSITION_HEADER AND status=OPEN`.
- Format a list: ticker, remaining/original shares, avgEntry, realized-so-far,
  linked flag. Empty ⇒ *"No open positions."*
- No unrealized P/L in v1 (deferred until a latest-price lookup is added).

---

## Idempotency

Telegram can retry a webhook delivery. Without protection a retried `/sell` would
double-decrement shares.

- **Dedupe marker:** conditional `PutItem` of `MUTATION#<update_id>` keyed on the
  Telegram `update_id`, with `attribute_not_exists(pk)`, before any mutating
  command runs. TTL auto-expires the marker.
- **POSITION_HEADER create** additionally uses `attribute_not_exists` on the
  composite key, and the "one OPEN position per ticker" check independently blocks
  a duplicate buy.

This matches the idempotent-write discipline the scanner already uses
(`attribute_not_exists(pk)` on outcomes).

---

## Module / file layout

- **`lambdas/shared/positions.mjs`** *(new — pure, deterministic, unit-tested,
  same pattern as funnel `report.mjs`)*: math + row-builders —
  `buildPositionHeader`, `buildBuyEvent`, `applySell` (validates shares, computes
  actual-fill P/L, returns updated header fields + sell event), `buildDecision`.
  No I/O. **`positionId`/`id` and timestamps are injected by the caller** — no
  `crypto`/`Date` inside this module.
- **`lambdas/shared/store.mjs`** *(extend)*: `findLatestOpenOutcome(ticker)`,
  `getOpenPosition(ticker)`, `createPosition(...)`, `recordSell(...)`,
  `recordDecision(...)`, `listOpenPositions()`, `claimUpdateId(updateId)`.
- **`lambdas/control/commands.mjs`** *(extend)*: `parseCommand` learns `/bought`,
  `/sell` (`TICKER SHARES PRICE`), `/skip` (`TICKER [reason…]`), `/positions`;
  preserves ticker-uppercasing.
- **`lambdas/control/handler.mjs`** *(extend)*: new `switch` cases; dedupe-claim
  guards the three mutating commands; `HELP` text updated.
- **`template.yaml`**: `PositionsTable` resource (Retain, PAY_PER_REQUEST, TTL on
  `ttl`, tags) + one IAM grant (`DynamoDBCrudPolicy` on `PositionsTable`) on the
  control Lambda.

### Tests (core covered surface)

`positions.mjs` math: partial sell, full close, weighted realized-pct, over-sell
rejection, linked vs unlinked construction, input validation (positive integer
shares / positive price). Deterministic via injected id + timestamps.

---

## What this feature explicitly does NOT change

- Scanner and labeler are untouched; they never read or write `gp-positions`.
- `gp-outcomes` stays pure research/outcome tracking; "do nothing" leaves a signal
  observe-only and starts no sell logic.
- No `STRATEGY_VERSION` bump, no `alertMode` change, no `gp-config` trading-row
  write (all human-reserved).

---

## Follow-up Issues to open

1. **GSI for ticker/status outcome lookup** — only if `gp-outcomes` grows enough
   that the linkage `Scan` becomes costly (`GSI1PK=TICKER#<ticker>`,
   `GSI1SK=STATUS#<status>#<entryEpoch>`).
2. **Scale-ins** — allow a second `/bought` to add to an OPEN position (recompute
   `avgEntryPrice` across buy events). Schema already accommodates it.
3. **Unrealized P/L in `/positions`** — needs a latest-price lookup
   (Finnhub quote) before it can be shown.
4. **Trailing-exit (Tier-3) engine** — future consumer that manages only
   `status="OPEN"` rows in `gp-positions`.
