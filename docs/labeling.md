# Outcome labeling (Phase 5)

Once a signal is opened (a `BUY_CANDIDATE` row in `gp-outcomes`), the labeler walks
it forward day by day and records what actually happened — so scoring can later be
tuned from real results instead of guesses. **Math decides here too**: the
accounting is a pure function; the Lambda only does I/O.

- Pure logic: `lambdas/shared/labeling.mjs` (`labelSignal`)
- Lambda: `lambdas/labeler/handler.mjs` (`gp-labeler`)

## The rules

For each open signal, walk **every** trading day strictly after the entry date
(entry is the close of the entry day), using adjusted Tiingo bars — the same series
the entry/stop/target were derived from.

```
for each day after entry:
  if day_low  <= stop   -> STOP     (checked first: if both hit, STOP wins)
  if day_high >= target -> TARGET
  if days_held >= timeoutTradingDays -> TIMEOUT (exit = that day's close)
```

If none of these trigger (no touch and fewer than `timeoutTradingDays` bars have
elapsed), the signal is **left OPEN** and re-evaluated on the next run.

### Pessimistic fills

- **STOP** exits at the **worse of the stop and that day's open** — a stop can gap
  through overnight, so `exit = min(stop, open)` for a long.
- **TARGET** exits at the **target itself** — we do not credit a gap-up that opens
  above the target.

These bias P&L downward on purpose; an optimistic backtest lies.

### After costs

`profitPct` is the **after-cost** return, in percent:

```
grossPct = (exit / entry - 1) * 100
costPct  = 2 * (feeBps + slippageBps) / 100   # both sides; bps → %
profitPct = grossPct - costPct
```

With the seed defaults (`feeBps 10`, `slippageBps 5`) the round-trip cost is
`2 * 15 bps = 0.30%`.

## What gets recorded

`store.closeOutcome` updates the `gp-outcomes` row (guarded by `status = OPEN`, so a
re-run can't relabel a closed signal) with:

`outcome` (STOP/TARGET/TIMEOUT), `hitStopFirst`, `hitTargetFirst`, `exitDate`,
`exitPrice`, `profitPct` (after cost), `daysHeld`, `status: "CLOSED"`, `labeledAt`,
the split-audit fields (above), and the **SPY benchmark** (B6): `spyEntry`,
`spyExit`, `spyReturnPct` (gross buy-and-hold of SPY over the same entry→exit
window, adjusted bars), and `alphaVsSpyPct = profitPct − spyReturnPct` — so a
win-rate can be judged against the market, not in a vacuum.
The original `breakdown` and `strategyVersion` stay on the row — outcome analysis
must always filter by `strategyVersion`.

## Tunable

`timeoutTradingDays` lives in `gp-config` (default **60** ≈ 3 months), not in code.
It is **provisional** like the other tunables and may be revisited once real
outcomes accumulate (Phase 8).

## Schedule

`gp-labeler` runs daily at `cron(0 23 ? * MON-FRI *)` UTC (after the scan), gated by
the same `ScheduleEnabled` parameter — **off by default** until the pipeline is
ready. It is idempotent: re-running only closes newly-resolved signals.

## Split-safe re-anchoring

Labeling uses split/dividend-**adjusted** prices, which Tiingo rescales
retroactively — so a split after a signal opens halves (or otherwise re-scales)
the entry-era bars while the stored `entry`/`stop`/`target` stay in the scan-time
frame. The labeler re-anchors before walking:

1. Find the entry bar (`date === entryDate`) and read its current adjusted close
   `entryAdjNow`.
2. `scaleFactor = entryAdjNow / storedEntry` (1.0 with no split; ~0.5 after a 2:1).
3. Scale `entry`/`stop`/`target` by `scaleFactor` into the current frame, then run
   the normal first-touch walk. `profitPct` is anchored to the scaled entry, so it
   is **split-invariant** (a ratio).

Audit fields recorded on the outcome: `scaleFactor`, `splitAdjusted`
(`|scaleFactor − 1| > 0.02`), `entryAdjAtLabel`, and `entryBarMissing` (true →
fell back to `scaleFactor = 1`). With `scaleFactor == 1` the result is identical to
the pre-fix behavior. (Anchoring to the adjusted series is total-return consistent;
a small dividend adjustment scales the levels proportionally and is flagged
`splitAdjusted: false`.)
