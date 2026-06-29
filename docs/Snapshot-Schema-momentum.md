# gp-momentum-1.0.0 — Snapshot & Outcome Schema (v2)

**Status: the field contract step 4 (scanner rewrite) implements against.** The
scanner writes one `gp-snapshots` row **per scored name per daily scan**, and opens
one `gp-outcomes` row per name actually bought. This doc freezes which fields each
row carries. Principle (inherited from gp-2.0.0, kept on purpose): **record the
decision *and* the raw inputs behind it, for every name scored — even excluded ones —
so we can later study what predicted outcomes, not just what we bought.**

It also states explicitly what is **carried over** from the gp-2.0.0 schema, what is
**dropped**, and what is **new**, so the agent neither blindly keeps dead fields nor
forgets a useful one.

> **v2 changes (from the schema review).** Added: a per-scan `params` snapshot (the
> real must-have — `strategyVersion` alone can't prove which numbers ran), a `scanId`
> to group one run, outcome audit fields (`entryAtr`, `initialRiskPerShare`,
> `initialRiskPct`), entry-price separation (`signalClose`, `plannedEntry`,
> `actualEntry`, `fillSlippagePct`), and two exit reasons (`manual`, `data_error`).
> Clarified: **one row per ticker per DAY** (not "per scan") — the key is unchanged
> and correct for the daily-scan / weekly-decision design. Deferred: splitting
> `decision` into `candidateDecision` + `positionDecision` (held state is already
> inferable from `entry`/`shares`/`stop`/`peakClose`; add only if reports get
> confusing).

---

## Key design (unchanged — correct for daily/weekly)

- `gp-snapshots`: `pk = TICKER#<ticker>` (S), `sk = <epoch day>` (N) → **one row per
  ticker per day.** The system runs one scheduled scan per trading day, so the day is
  a unique key. **Do NOT change the key** unless intraday (multiple scans per ticker
  per day) is ever introduced — then move to `sk = <epochDay>#<scanId>`. Not now.
- `gp-outcomes`: `pk = SIGNAL#<ticker>#<entryDate>` (S), `sk = <entry epoch>` (N) →
  one row per opened position, created once (conditional put; never overwrite a
  labeled outcome).

---

## `gp-snapshots` — one row per scored name per daily scan

### A. Identity & provenance — CARRIED OVER + `scanId` (NEW)

| field | type | meaning |
|---|---|---|
| `pk` | S | `TICKER#<ticker>` |
| `sk` | N | epoch day of `dataAsOf` |
| `ticker` | S | the symbol |
| `dataAsOf` | S | date of the latest bar used (freshness proof) |
| `strategyVersion` | S | `gp-momentum-1.0.0` — never pool across versions |
| `scanId` | S | **NEW** — same ID on every row from one scan run (group a run; future-proofs the key) |
| `scannedAt` | S | ISO timestamp the row was written |

### A2. Params snapshot — NEW (the must-have: makes every row self-describing)

The **actual tunable values used for this scan**, copied from the `gp-config` ACTIVE
row at run start. `strategyVersion` says *which* strategy; `params` proves *what
numbers* it ran with, so a later config edit can't silently make old rows
un-trustworthy. Stored once per scan (identical across the run's rows).

| field | source |
|---|---|
| `params.regimeMa` · `params.trendMa` · `params.momentumLookback` | §8 |
| `params.entryRankPct` · `params.exitRankPct` | §8 |
| `params.atrPeriod` · `params.kStop` · `params.riskPctPerTrade` | §8 |
| `params.minPrice` · `params.minDollarVol` | §1 |
| `params.gapFilterPct` · `params.gapFilterWindow` | §3 |
| `params.targetPositions` · `params.maxPositions` · `params.positionCapPct` | §4 |
| `params.weeklyDdLimit` · `params.monthlyDdLimit` · `params.maxDdLimit` | §6 |
| `params.feeBps` · `params.slippageBps` | §9 |

### B. The momentum decision — NEW (replaces the old score/breakdown/gates)

| field | type | meaning |
|---|---|---|
| `decision` | S | `BUY_CANDIDATE` \| `HOLD` \| `EXIT` \| `NOT_ELIGIBLE` \| `REGIME_OFF` \| `NO_DATA` |
| `reason` | S\|null | short human reason (e.g. `below_trend_ma`, `rank_exit`) |
| `momentum` | N\|null | the score: annualized exp-regression slope × R² |
| `slope` | N\|null | raw regression slope (log-price) |
| `r2` | N\|null | regression R² (trend smoothness) |
| `rank` | N\|null | cross-sectional rank that day (1 = strongest) |
| `rankPct` | N\|null | rank as a percentile of the eligible set |
| `inEntryZone` | B\|null | in the top `entryRankPct` (buy zone) |
| `inExitZone` | B\|null | below the top `exitRankPct` (rotate-out zone) |

> **Deferred (do NOT add now):** splitting `decision` into `candidateDecision` +
> `positionDecision`. A name can be regime-off for new buys yet still held and managed
> by exits — but that held state is already recoverable from the position fields
> (§F): a row with `shares`/`entry`/`peakClose` populated IS a held position. Add the
> split later only if funnel analysis proves the single field ambiguous. Non-breaking
> to add then.

### C. Eligibility flags — NEW (the per-gate breakdown, for funnel analysis)

| field | type | meaning |
|---|---|---|
| `eligible` | B | passed all eligibility checks (always boolean) |
| `checks.price` | B\|null | price ≥ `minPrice` |
| `checks.dollarVol` | B\|null | 20-day avg dollar volume ≥ `minDollarVol` |
| `checks.trend` | B\|null | close > `trendMa` SMA |
| `checks.noBigMove` | B\|null | no ≥`gapFilterPct` single-day (close-to-close) move in `gapFilterWindow` |
| `insufficientHistory` | B | too few bars to score (dropped from ranking; always boolean) |

The `checks.*` are **`B|null`**: `null` for decision classes where eligibility was
never evaluated (`REGIME_OFF`, `NO_DATA`). The store writes them with nullable
booleans (`momentumChecks`) — don't assume non-null in analysis.

### D. Market / regime context — CARRIED OVER (more central to momentum than before)

| field | type | meaning |
|---|---|---|
| `regimeOn` | B | SPY close > its `regimeMa` SMA that day (the buy switch) |
| `spy` | M\|null | SPY context block: `spyBelow200ma`, `asOf`, SPY returns. Keep — momentum's regime filter *is* this. |
| `sector` | S\|null | sector tag (capture-only; momentum doesn't gate on it, useful for concentration analysis) |

### E. Raw indicators — CARRIED OVER, TRIMMED (`metrics` block)

Keep the plain price/vol indicators momentum uses or wants for analysis; **drop the
gp-2.0.0 level/breakout/Minervini derived signals.**

| field | keep? | note |
|---|---|---|
| `close`, `ma50`, `ma100`, `ma200` | KEEP | trend filter + context (`ma100` is the momentum trend MA) |
| `atr` (ATR20) | KEEP | drives sizing & the stop — essential |
| `avgVolume30`, `volumeRatio` | KEEP | liquidity context |
| `return63d/126d/252d` | KEEP | cheap momentum context for analysis |
| `nearestSupport` / `nearestResistance` levels | **DROP** | level structures — gp-2.0.0 only |
| `distanceToSupportAtr` / `...ResistanceAtr` | **DROP** | level distances — gp-2.0.0 only |
| `minerviniAligned` | **DROP** | not used by momentum |
| `breakout20` / `breakout55` | **DROP** | Turtle signals — not used by momentum |

### F. Position fields — NEW / ADAPTED (only populated for held names)

| field | type | meaning |
|---|---|---|
| `entry` | N\|null | entry price (CARRIED OVER from gp-2.0.0, same meaning) |
| `stop` | N\|null | current stop level (CARRIED OVER) |
| `peakClose` | N\|null | highest close since entry — the chandelier trail anchor (NEW) |
| `shares` | N\|null | position size from ATR risk sizing (NEW) |
| `exitReason` | S\|null | see the exit-reason set below (NEW) |

### DROPPED from the gp-2.0.0 snapshot (old strategy's DNA — do NOT carry over)

`score`, `breakdown` (9 components), `gates`, `target`, `riskReward`,
`riskPerShare`, `rewardPerShare`, `targetType`, `projectedTarget`,
`resistanceTarget`, `targetAtrMultiple`, `sectorStrengthPct`, `fundamentals`
(O'Neil block). These belong to the gate-and-score + fixed-target strategy and have
no role in momentum v1. (No fundamental factor in v1 — that is the single
pre-registered v2 experiment in the Validation Scorecard, not now.)

---

## `gp-outcomes` — one row per bought name (the labeler UNCHANGED)

The labeler stays as-is (first-touch, pessimistic fills, after-cost `profitPct`,
MFE/MAE); only the *entry-side fields it copies in* change to the momentum set, plus
the v2 audit/entry-price additions.

### Carried over + momentum entry snapshot

| field | type | meaning |
|---|---|---|
| `pk` / `sk` | S / N | `SIGNAL#<ticker>#<entryDate>` / entry epoch (CARRIED OVER) |
| `ticker`, `sector`, `entryDate`, `status` | — | CARRIED OVER |
| `strategyVersion` | S | `gp-momentum-1.0.0` |
| `scanId` | S | **NEW** — the scan run that opened this position |
| `momentum`, `slope`, `r2`, `rank`, `rankPct` | N | the momentum snapshot **at entry** (replaces `score`/`breakdown`) |

### Entry-price separation — NEW

| field | type | meaning |
|---|---|---|
| `signalClose` | N | the close that triggered the signal (day-T close) |
| `plannedEntry` | N | intended fill. **Backtest/live: next day's open** (§9 fill rule). **OBSERVE: = `signalClose`** — T+1's open is unknowable when the scanner runs after T's close, so observe uses the signal close (a small, deliberate approximation; the precise next-day-open fill is the step-5 backtest's job). |
| `actualEntry` | N\|null | real fill price — **null until real (live) trading** |
| `fillSlippagePct` | N\|null | actual vs planned — **null until real (live) trading** |
| `entry` | N | the entry used for sizing/stops, = `plannedEntry` (so = `signalClose` in observe, next-day open in backtest) |

### Sizing audit — NEW (prove the sizing actually worked)

| field | type | meaning |
|---|---|---|
| `entryAtr` | N | ATR20 at entry (the volatility the size was based on) |
| `stop` | N | initial stop = `entry − kStop×entryAtr` |
| `shares` | N | size at entry |
| `initialRiskPerShare` | N | `entry − stop` (price risk per share) |
| `initialRiskPct` | N | account risk at entry (should ≈ `riskPctPerTrade`) |

### Exit / result (labeler + scanner-closed exits)

| field | type | meaning |
|---|---|---|
| `status` | S | lifecycle: `OPEN` → `CLOSED` (NOT the result; carried over) |
| `outcome` | S\|null | result type: `STOP` \| `EXIT` \| `TIMEOUT` (null while `OPEN`; **no `TARGET`** — momentum has none). `STOP` = labeler stop touch; `EXIT` = scanner rank/trend close; `TIMEOUT` = held to the window end. |
| `exitReason` | S\|null | the granular cause: `hard_stop` \| `trailing_stop` (→ `STOP`); `rank_exit` \| `trend_exit` (→ `EXIT`); `manual` \| `data_error`; null for `TIMEOUT` |
| `exitDate`, `daysHeld` | — | labeler |
| `profitPct` | N | **after-cost** return (labeler — keep cost subtraction; scanner-closed exits use the SAME cost math) |
| `mfePct`/`maePct` (+ prices) | N | price travel for stop tuning (labeler — keep) |

> **Exit-reason note:** `hard_stop` / `trailing_stop` come from the labeler's
> first-touch on the (scanner-refreshed) stop; `rank_exit` / `trend_exit` are closed
> by the scanner — both routes deduct costs identically. `manual` is a human close,
> `data_error` is a defensive close on bad/missing data (never a silent NaN). A
> momentum outcome can **never** be `TARGET` — the labeler's no-target guard ensures
> a non-finite target is skipped, not fired at price 0.

### DROPPED from the gp-2.0.0 outcome row

`score`, `breakdown`, `target`, `riskReward`, all `target*` metadata, and the
RS-at-entry fields (`rsRaw`, `rsRank`, `rsVsSpy`). gp-2.0.0 scoring inputs — no role
in momentum v1.

---

## Implementation notes for step 4

- Reuse gp-2.0.0's **persistence-boundary discipline**, it's already correct: round
  numbers at write time; convert `undefined` → `null` (DynamoDB rejects `undefined`);
  one unique `pk`/`sk` per row, never overwrite a labeled outcome (the conditional
  put pattern in `store.mjs`).
- A snapshot is written for **every** scored name and every decision class
  (`NOT_ELIGIBLE`, `REGIME_OFF`, etc.), not just buys — that's what powers the funnel
  report and the "did the excluded names actually underperform?" analysis.
- `params` and `scanId` are computed once per scan and stamped on every row of that
  run, so a later `gp-config` edit can't retroactively cloud old rows.
- `actualEntry` / `fillSlippagePct` stay `null` in observe mode and backtest — there
  is no real fill. Populate them only under live trading.
- `gp-config`, `gp-watchlist`, and all `Retain` policies are untouched by this step.
- The funnel-report (`report.mjs`) reads some of these fields — when the snapshot
  shape changes, update its buckets to read momentum rank/eligibility instead of the
  old score/gates. Flag it; don't silently break the dashboard.

---

## Review verdict (the agreed selective edits)

**Added now (v2):** `params` snapshot (the real must-have — old rows stay trustworthy
if config changes later) · `scanId` (group a run) · wording fixed to *one row per
ticker per day* · outcome audit fields (`entryAtr`, `initialRiskPerShare`,
`initialRiskPct`) · entry-price separation (`signalClose`, `plannedEntry`,
`actualEntry`=null, `fillSlippagePct`=null until real fill) · exit reasons (`manual`,
`data_error`).

**Deferred (do not build now):** splitting `decision` into `candidateDecision` +
`positionDecision` — held state is inferable from `entry`/`shares`/`stop`/`peakClose`;
add later only if reports get confusing.

**Key:** unchanged. `pk=TICKER#<ticker>`, `sk=epochDay` is correct for the
daily-scan / weekly-decision design. Only revisit if intraday scanning is ever added.

With these edits the schema is research-grade. This is the right moment to lock it —
before the persistence code (step 4b-2b) is written.
