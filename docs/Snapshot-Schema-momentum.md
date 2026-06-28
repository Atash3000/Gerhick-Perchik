# gp-momentum-1.0.0 — Snapshot & Outcome Schema

**Status: the field contract step 4 (scanner rewrite) implements against.** The
scanner writes one `gp-snapshots` row per scored name per scan, and opens one
`gp-outcomes` row per name actually bought. This doc freezes which fields each row
carries. Principle (inherited from gp-2.0.0, kept on purpose): **record the decision
*and* the raw inputs behind it, for every name scored — even excluded ones — so we
can later study what predicted outcomes, not just what we bought.**

It also states explicitly what is **carried over** from the gp-2.0.0 schema, what is
**dropped**, and what is **new**, so the agent neither blindly keeps dead fields nor
forgets a useful one.

---

## `gp-snapshots` — one row per scored name per scan

### A. Identity & provenance — CARRIED OVER (universal, keep verbatim)

| field | type | meaning |
|---|---|---|
| `pk` | S | `TICKER#<ticker>` |
| `sk` | N | epoch day of `dataAsOf` |
| `ticker` | S | the symbol |
| `dataAsOf` | S | date of the latest bar used (freshness proof) |
| `strategyVersion` | S | `gp-momentum-1.0.0` — never pool across versions |
| `scannedAt` | S | ISO timestamp the row was written |

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

### C. Eligibility flags — NEW (the per-gate breakdown, for funnel analysis)

| field | type | meaning |
|---|---|---|
| `eligible` | B | passed all eligibility checks |
| `checks.price` | B\|null | price ≥ `minPrice`; null when eligibility was not evaluated |
| `checks.dollarVol` | B\|null | 20-day avg dollar volume ≥ `minDollarVol`; null when eligibility was not evaluated |
| `checks.trend` | B\|null | close > `trendMa` SMA; null when eligibility was not evaluated |
| `checks.noBigMove` | B\|null | no ≥`gapFilterPct` single-day (close-to-close) move in `gapFilterWindow`; null when eligibility was not evaluated |
| `insufficientHistory` | B | too few bars to score (dropped from ranking) |

### D. Market / regime context — CARRIED OVER (more central to momentum than before)

| field | type | meaning |
|---|---|---|
| `regimeOn` | B | SPY close > its `regimeMa` SMA that day (the buy switch) |
| `spy` | M\|null | the SPY context block: `spyBelow200ma`, `asOf`, SPY returns. Keep — momentum's regime filter *is* this. |
| `sector` | S\|null | sector tag (capture-only; momentum doesn't gate on it, but useful for concentration analysis) |

### E. Raw indicators — CARRIED OVER, TRIMMED (`metrics` block)

Keep the plain price/vol indicators momentum actually uses or wants for analysis;
**drop the gp-2.0.0 level/breakout/Minervini derived signals.**

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
| `exitReason` | S\|null | `hard_stop` \| `trailing_stop` \| `rank_exit` \| `trend_exit` (NEW) |

### DROPPED from the gp-2.0.0 snapshot (old strategy's DNA — do NOT carry over)

`score`, `breakdown` (9 components), `gates`, `target`, `riskReward`,
`riskPerShare`, `rewardPerShare`, `targetType`, `projectedTarget`,
`resistanceTarget`, `targetAtrMultiple`, `sectorStrengthPct`, `fundamentals`
(O'Neil block). These belong to the gate-and-score + fixed-target strategy and have
no role in momentum v1. (No fundamental factor in v1 — that is the single
pre-registered v2 experiment in the Validation Scorecard, not now.)

---

## `gp-outcomes` — one row per bought name (the labeler UNCHANGED)

The labeler stays as-is; only the *entry-side fields it copies in* change to the
momentum set. Keep its mechanics (first-touch, pessimistic fills, after-cost
`profitPct`, MFE/MAE) exactly.

| field | type | meaning |
|---|---|---|
| `pk` / `sk` | S / N | `SIGNAL#<ticker>#<entryDate>` / entry epoch (CARRIED OVER) |
| `ticker`, `sector`, `entryDate`, `status` | — | CARRIED OVER |
| `strategyVersion` | S | `gp-momentum-1.0.0` |
| `entry`, `stop` | N | entry & initial stop (CARRIED OVER) |
| `momentum`, `slope`, `r2`, `rank`, `rankPct` | N | the momentum snapshot **at entry** (NEW — replaces `score`/`breakdown`) |
| `shares` | N | size at entry (NEW) |
| `outcome` | S | `STOP` \| `TARGET`/exit \| `TIMEOUT` (labeler) |
| `exitReason` | S | which exit fired (NEW; richer than gp-2.0.0's stop/target) |
| `exitDate`, `daysHeld` | — | labeler |
| `profitPct` | N | **after-cost** return (labeler — keep cost subtraction) |
| `mfePct`/`maePct` (+ prices) | N | price travel for stop tuning (labeler — keep) |

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
- `gp-config`, `gp-watchlist`, and all `Retain` policies are untouched by this step.
- The funnel-report (`report.mjs`) reads some of these fields — when the snapshot
  shape changes, update `report.mjs`'s buckets to read momentum rank/eligibility
  instead of the old score/gates. Flag it; don't silently break the dashboard.
