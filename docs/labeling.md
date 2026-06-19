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
`exitPrice`, `profitPct` (after cost), `daysHeld`, `status: "CLOSED"`, `labeledAt`.
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

## Known limitation

Labeling uses split/dividend-**adjusted** prices, which rescale retroactively. If a
split occurs mid-trade, the stored absolute `entry`/`stop`/`target` (captured at
scan time) can drift from the re-fetched adjusted series. Rare for the large-cap
watchlist and short windows; tracked as a follow-up.
