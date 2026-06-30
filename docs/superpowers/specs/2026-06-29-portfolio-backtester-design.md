# Portfolio Backtester — Design Spec (Build-order Step 5)

**Date:** 2026-06-29
**Strategy under test:** `gp-momentum-1.0.0`
**Status:** Approved design. Next action: implementation plan (writing-plans).

> **Read this first — the honesty frame.** This step builds the *judge* and runs a
> *preliminary hearing on biased evidence*. Every number it produces on the
> hand-curated `seed/watchlist.json` is **survivorship-biased and is NOT a verdict.**
> A real PASS/KILL is only believed after build-order step 7 re-runs this engine on a
> survivorship-free, point-in-time universe. The structural/relative tests in scope
> here (ablation, dumb-baseline, rebalance-day, cost, concentration, sweep) are
> informative even on biased data because they compare the strategy *to itself*; the
> absolute, data-hungry tests (period battery, sealed holdout, universe robustness,
> Monte Carlo) are deferred to step 7. See `docs/Validation-Scorecard.md` (signed,
> FINAL) for the pre-registered metrics and thresholds.

---

## 1. Goal & scope

Build a **portfolio backtester** that replays the momentum strategy's *decisions* over
historical bars inside a proper portfolio NAV simulation, and emits the
`docs/Validation-Scorecard.md` §1 metric table plus the in-scope robustness tests,
side-by-side with SPY buy-and-hold.

**The governing principle:** the backtester and the live scanner make decisions with
the **same code**, but they are **different machines around that code.** The engine
imports the live pure primitives and never re-implements exit/cost/ranking math; it
wraps them in a NAV simulation that does what a backtest needs and the live scanner
does not — next-open fills, a compounding equity curve, a daily stop-walk between
weekly reviews, and real drawdowns that trip the circuit breakers.

### In scope (this step)

- Portfolio NAV simulation engine (compounding, ATR sizing, weekly rotation, daily
  stops, circuit breakers).
- Full §1 metric table, computed off the NAV curve, vs SPY buy-and-hold.
- Structural / relative robustness tests: **A** (dumb-baseline), **B** (edge
  concentration), **C** (rebalance-day stability), **E** (cost sensitivity), **G**
  (ablation), **J** (parameter sweep).
- Disk bar-cache so the battery is re-runnable without hammering Tiingo.
- Committed markdown report **and** structured JSON, SHA/params/coverage stamped.

### Out of scope — deferred to step 7 (architected to slot in as sibling modules)

- **D** period battery (2000–02 / 2008–09 / 2020 / 2022), **F** sealed holdout,
  **H** universe robustness, **I** Monte Carlo. These need deep, survivorship-free,
  point-in-time data to mean anything; running them now produces untrustworthy
  verdicts. They plug into the same engine with no engine change.

### Defaults (locked)

- **Starting capital:** $100,000, **compounding off current equity** each week
  (so sizing and the governor see real drawdown — not a static account).
- **Cash:** earns **0%** when in cash (conservative; biases *against* the strategy,
  the honest direction). SPY buy-and-hold is the benchmark.
- **Universe / period:** `seed/watchlist.json` over the **deepest history Tiingo
  returns**, no holdout carved out (sealed holdout F is deferred). Survivorship
  coverage is **quantified per window** in the report (§9).
- **Determinism:** no randomness anywhere in scope (Monte Carlo deferred). A re-run is
  bit-identical. Any ablation that "removes ranking" uses a deterministic substitute
  ordering (by liquidity), never a random one.

---

## 2. Module layout

```
scripts/backtest/
  run.mjs           # CLI entrypoint — wires everything, writes artifacts (I/O)
  data.mjs          # load watchlist + fetch/cache bars + build trading calendar (I/O)
  cache.mjs         # disk bar cache keyed by ticker+range, with fetchedAt (I/O)
  engine.mjs        # portfolio NAV simulator (PURE: bars in -> equity curve + ledger)
  metrics.mjs       # §1 metric table from an equity curve + ledger (PURE)
  benchmark.mjs     # SPY buy-and-hold curve over the identical calendar (PURE)
  report.mjs        # markdown + JSON, SHA/params/coverage/warnings stamped (PURE)
  robustness/
    ablation.mjs        # G
    baseline.mjs        # A
    rebalance-day.mjs   # C
    cost.mjs            # E
    concentration.mjs   # B
    sweep.mjs           # J
docs/backtest/          # committed reports: Scorecard-run-<ts>.md + .json
scripts/backtest/.cache/   # gitignored bar cache
```

`engine.mjs`, `metrics.mjs`, `benchmark.mjs`, and `report.mjs` are **pure** →
unit-testable against known series. `data.mjs`, `cache.mjs`, `run.mjs` own all I/O.

**Reused live primitives (imported, never copied):**

- `lambdas/shared/portfolio.mjs` — `isEligible`, `rankByMomentum`, `sizePosition`,
  `updateTrailingStop`, `evaluateExits`, `riskGovernor`, `constructBook`.
- `lambdas/shared/marketdata.mjs` — `buildMomentumData` + indicators (`sma`,
  `atrWilder`, dollar-volume) and `getDailyBars` (data layer).
- `lambdas/shared/momentum.mjs` — `momentumScore` (via `rankByMomentum`).
- `lambdas/shared/labeling.mjs` — `afterCostProfitPct`, `excursion` (cost/excursion
  semantics; see §4 cost equivalence).
- `lambdas/shared/config.mjs` — the active tunables (frozen §8 params).
- `lambdas/shared/version.mjs` — `STRATEGY_VERSION` stamped on the report.

No exit, cost, or ranking math is re-implemented. Requirement #1 (identical decisions
to live) is enforced *structurally by import*, not by discipline.

---

## 3. The simulation loop — daily/weekly sequencing

The engine walks the **SPY trading calendar** (the canonical session list) from start
to end. SPY is also the regime input and the benchmark, so its bars define the
calendar; per-name bars are aligned/forward-filled to it only for mark-to-market (a
name with no bar on a session keeps its last close for MTM; it is simply not tradable
that session).

**State:** `cash`, `positions[]` (each
`{ ticker, shares, entry, entryDate, stop, peakClose, entryAtr }`), `peakEquity`, the
daily `equityCurve[]` (`{ date, nav }`), the `ledger[]` (closed trades), and a
`pendingOrders` queue (decisions made at review T fill at session T+1's open).

### Order of operations, per session D

1. **Execute queued orders at D's open** — **sells first** (free cash), then **buys**.
   This is the next-open fill (§4). A buy deducts `shares × open × (1 + cost)` from
   cash and opens a position with `entry = open_D`, `entryDate = D`,
   `stop = open_D − kStop × ATR_T` (ATR from the signal day T), `peakClose = open_D`.
   A decision-sell closes the position at `open_D` (after cost) and records the trade.
2. **Daily stop-walk** on every *still-held* position (not the ones just sold in
   step 1): if `D.low ≤ position.stop` → **STOP** exit, fill = `min(stop, D.open)`
   (pessimistic gap-through — identical rule to `labelSignal`). The stop checked is
   the level set **at the last review**; it does **not** advance intraday. Record the
   trade with `exitReason = hard_stop` if `stop ≤ entry` else `trailing_stop` (same
   classification as `momentumStopExitReason`).
3. **If D is the rebalance weekday** (signal day T), using D's **close**:
   - **(a)** Point-in-time `buildMomentumData` / `isEligible` over `bars[..D]` for the
     whole universe; `isRegimeOn(SPY closes[..D])`; `rankByMomentum` over the eligible
     set (or the active `rankFn` for tests).
   - **(b) Trail advance** held stops via `updateTrailingStop` from D's close —
     **weekly-granular, matching live**. The trail ratchets up *only here*; the daily
     walk in step 2 only *checks* the prior level. (This is the same conservative
     approximation the live scanner uses, so backtest and live measure the same
     strategy.)
   - **(c) Exits before fills** (§7 ordering): `evaluateExits` for **RANK / TREND** on
     held names → queue decision-sells for T+1 open. **STOP is owned by the daily walk
     (step 2); the review never re-fires it** — no double-counting.
   - **(d) Fills:** `riskGovernor(drawdowns)` fed **real NAV-derived drawdowns** (§5);
     `constructBook(ranked, heldNow, governor, config)` where `heldNow` = held minus
     names queued to exit this cycle (freed slots are reusable same cycle, exactly like
     live `planScan`); for each candidate `sizePosition(close_T, ATR_T, currentEquity)`
     → queue buy orders for T+1 open. Candidates that can't be sized are skipped so the
     next-ranked name backfills the slot (#85 parity).
4. **Mark-to-market at D's close** → `NAV = cash + Σ shares × close_D`; append
   `{ date: D, nav }` to `equityCurve`; update `peakEquity = max(peakEquity, NAV)`.

Non-review sessions run only steps 1, 2, 4. This is faithful to live: the scanner
"sees" each name weekly for rank/trend (step 3), but the stop is live every day
(step 2) — exactly how the live scanner + labeler split the work.

### End-of-run

Any position still open at the final session is closed at the last close (after cost)
and recorded with `exitReason = end_of_backtest`, so the ledger and the equity curve
agree and no open risk is silently dropped.

---

## 4. Next-open fills and the single cost model

- **Decision at T-close, fill at T+1-open** — for **both** entries and rank/trend
  exits. You cannot trade at the close you used to decide; modeling otherwise is the
  same-bar lookahead that makes backtests lie. **Stops are the one exception** — a stop
  is a resting order, so it fills *intraday* at the stop level (worse of stop vs open),
  never next-open.
- **Sizing locked at the signal (a documented approximation):**
  `shares = sizePosition(close_T, ATR_T, equity_T).shares`. **Fill price = open_{T+1}.**
  `entry = open_{T+1}`, `stop = open_{T+1} − kStop × ATR_T`, `peakClose = open_{T+1}`,
  `entryDate = T+1`. Shares are fixed at the signal; the stop is recomputed from the
  *actual* fill. This is the standard honest convention (size on the signal, fill at
  the next available price) and is called out explicitly as an approximation.
- **The ledger's per-trade `profitPct` is computed by calling
  `afterCostProfitPct(entry, exit, config)` directly** — i.e. the per-trade outcome is
  *literally the labeler's number*, the strongest possible guarantee that the backtest
  and the live labeler cost a trade identically (not "the same idea," the same
  function). The same `feeBps` / `slippageBps` come from `gp-config`.
- **The NAV equity curve applies those same bps as cash haircuts on every fill**, both
  sides, so the curve is **natively after-cost** and compounds correctly:
  `buyCash = shares × price × (1 + (feeBps + slippageBps)/1e4)`;
  `sellProceeds = shares × price × (1 − (feeBps + slippageBps)/1e4)`.
- **Why two forms, and how they're reconciled:** `afterCostProfitPct` subtracts cost
  *additively* in percentage points; the cash haircut applies it *multiplicatively* per
  leg. They are identical to first order and differ only at second order (≈ `cost ×
  return`, negligible at 10 bps). A unit test asserts the ledger `profitPct` and the
  NAV-derived per-trade P&L agree **within a small documented tolerance** for a single
  round-trip — the structural check that the two cost paths track each other and cannot
  silently diverge. (The ledger remains the authoritative per-trade number; the curve is
  the compounding analog.)

---

## 5. Drawdowns feeding the governor (canonical definition)

The live governor is currently **inert in observe** — fed
`{ weeklyPct: 0, monthlyPct: 0, fromPeakPct: 0 }` (`scanner/handler.mjs`, with the
comment *"Real circuit breakers run in the step-5 backtest"*). There is therefore **no
prior live definition to match**; this spec **establishes the canonical definition**,
and the live governor MUST adopt the identical one when its equity curve is activated.

Drawdowns are **trailing-window peak-to-current**, computed from the **daily** NAV
curve (so an intra-week trough registers), and evaluated **at each review** before
`constructBook`:

- `fromPeakPct  = (peakEquity_alltime − NAV) / peakEquity_alltime × 100`
- `weeklyPct    = (peak NAV over the last 5 sessions  − NAV) / that peak × 100`
- `monthlyPct   = (peak NAV over the last 21 sessions − NAV) / that peak × 100`

Window sizes are **fixed session counts: 5 (week) and 21 (month)**, all-time for peak —
exact and deterministic, not "~4 reviews." `riskGovernor` consumes magnitudes (it
already `Math.abs`-es), trips block-new-buys at `weeklyDdLimit`/`monthlyDdLimit` and
halt-all at `maxDdLimit`. This is the one place the backtest legitimately exercises a
code path the inert observe live path cannot.

> **Cross-system note:** these three formulas + the 5/21/all-time windows are the
> canonical governor-drawdown definition. When the live governor is activated (a future
> step), it must use this exact definition, or backtest and live breakers would mean
> different things — an invisible mismatch until it matters.

---

## 6. Metrics (§1) — off the NAV curve, side-by-side with SPY

`metrics.mjs` is pure: `(equityCurve, ledger, config) → table`. All of:

| Metric | Definition |
|---|---|
| After-cost CAGR | `(NAV_end / NAV_start)^(252/tradingDays) − 1` |
| Max drawdown | max daily peak-to-trough on the NAV curve |
| Sharpe | `mean(dailyRet) / std(dailyRet) × √252`, **rf = 0** |
| Sortino | `mean(dailyRet) / downsideStd(dailyRet) × √252`, **rf = 0** |
| Win rate, avg win/loss, expectancy/trade, profit factor | from the ledger (after cost) |
| Annual turnover + avg holding period | `Σ traded notional / avg equity / years`; mean `daysHeld` |
| Total cost drag | `Σ costs / gross return`, as % |
| % time in cash + worst losing streak | fraction of sessions fully in cash; longest run of losing trades |
| Avg exposure + return per invested dollar | `mean(invested / NAV)`; CAGR / avg exposure |

`benchmark.mjs` computes the **identical table** for SPY buy-and-hold over the same
calendar (buy SPY at the first open with the full $100k, hold to the last close, same
cost on the single round-trip). Because Sharpe/Sortino use **rf = 0 on both sides**,
the strategy-vs-SPY comparison (the Scorecard's "Sortino > SPY Sortino", "Sharpe ≥ SPY
Sharpe") is valid — rf cancels. **The report states "Sharpe/Sortino computed with
rf = 0" explicitly** so the convention is visible at the comparison.

---

## 7. Robustness-test harness (A, B, C, E, G, J)

The engine exposes pluggable knobs so the battery re-runs the same engine cheaply:

```
simulate(bars, spyBars, calendar, config, { rankFn, ablation, rebalanceWeekday })
```

- **G — Ablation** (`ablation` flags `{ noRegime, noRanking, noAtrSizing, noGovernor,
  noTrend }`): re-run once per flag, tabulate CAGR / max DD / Sharpe. `noRanking`
  selects eligible names **without** momentum order (deterministic: by 20-day dollar
  volume, descending) — the highest-information test: if removing the momentum ranking
  barely changes results, momentum was never the edge. `noAtrSizing` → equal-weight.
  `noGovernor` → skip breakers. `noTrend` → drop trend exit *and* trend eligibility.
  `noRegime` → skip the SPY filter. **Read on risk-adjusted terms** (per Scorecard §2-G:
  removing the governor often *raises* CAGR while wrecking drawdown — that is expected
  and not a reason to drop it).
- **A — Dumb-baseline** (swap `rankFn`): plain 6-month return, plain 9-month return,
  plain slope, slope×R² (the live metric). Compare CAGR; per §2-A, if slope×R² wins by
  < 1.5 pts, the report flags "switch to the simpler metric."
- **C — Rebalance-day** (`rebalanceWeekday` Mon–Fri): run ×5; the report asserts the
  verdict is the same across all five and the CAGR spread ≤ 3 pts (§3 threshold).
- **E — Cost sensitivity:** re-run at **2× `slippageBps`**; report CAGR + drawdown vs
  the §3 "CAGR ≥ SPY − 4 pts and drawdown still < SPY" bar.
- **B — Edge concentration:** from the monthly-return series derived from the NAV
  curve, strip the best **5% / 10% / 20%** of months and recompute expectancy/CAGR
  (§3: strip 10% → still positive & beats cash; strip 5% → still beats SPY
  risk-adjusted).
- **J — Parameter sweep:** `trendMa ∈ {80, 90, 100, 110, 120, 150}`; confirm graceful
  degradation. **Lock:** the traded value stays the pre-registered 100; the sweep is a
  stability check, never a menu.

Each robustness module is a pure-ish function `(runEngine, baseInputs) → resultObject`
that the runner calls and the report renders. Deferred D/F/H/I are sibling modules with
the same signature — no engine change needed to add them at step 7.

---

## 8. Bar cache (re-runnability)

- `cache.mjs`: one JSON per ticker in `scripts/backtest/.cache/` (gitignored), keyed by
  `ticker + startDate`, storing full adjusted OHLCV **plus `fetchedAt`**.
- `data.mjs` checks the cache → fetches via `getDailyBars` (throttled, ~250ms like the
  existing scripts) only on miss/short, then writes the cache. `--refresh` bypasses and
  re-fetches all.
- **Stale-cache safety (not memory-dependent):** Tiingo adjusts the *whole* series
  retroactively on splits/dividends, so a stale cached series can silently drift. The
  run therefore:
  1. **warns loudly** for any cached series whose `fetchedAt` is older than a threshold
     (default 7 days), and
  2. **detects a likely split** by scanning each cached series for an adjacent-day
     close ratio outside a sane band (e.g. > 1.5× or < 0.67× in one session that is not
     a known move) and flags those tickers.
  Both warnings are surfaced in the report's coverage block (§9), so the artifact
  is **self-policing** rather than relying on remembering to `--refresh`. `--refresh`
  remains the fix.

This is what makes the battery (rebalance ×5, sweep ×6, ablation ×5+) read from disk
instead of re-hitting Tiingo dozens of times.

---

## 9. Report (markdown + JSON)

`report.mjs` is pure: `(runContext) → { markdown, json }`. The runner writes both to
`docs/backtest/Scorecard-run-<ISO-timestamp>.md` and `.json`.

**Header (stamped):** `STRATEGY_VERSION`, **git SHA** (`git rev-parse HEAD`, captured
in `run.mjs`), the frozen §8 param table, the run timestamp, the universe + period, and
the **rf = 0** note for Sharpe/Sortino.

**Body:**

1. **§1 metric table** — strategy vs SPY, side-by-side.
2. **§3 PASS/FAIL checks** — computed against the signed thresholds, but rendered under
   a loud banner: **`PRELIMINARY — survivorship-biased, NOT a verdict until step 7.`**
3. **Structural tests** — one section each for A, B, C, E, G, J.
4. **Survivorship coverage block (quantified, with teeth):** for the full period and
   for each window a test touches, the count of watchlist names **with full data over
   that window** vs the total (e.g. `2008–2009: 42/199 names had data`). Plus the
   §8 stale-cache / split warnings. This sits *next to* the numbers so a deep-history
   CAGR carries its own "only N of 199 existed then" warning instead of a generic
   disclaimer scrolled past.

**JSON:** the same data structured (every metric + test result + coverage counts as
machine-readable fields) so the rebalance-day and sweep tests — and any future
cross-run comparison — can assert consistency programmatically rather than by eye.

---

## 10. Testing (TDD, matching the existing `tests/` runner)

- **`engine.mjs`** against a tiny synthetic universe with hand-computed bars, asserting
  each load-bearing invariant in isolation:
  - next-open fill price (entry fills at T+1 open, not T close);
  - daily stop fires intraday at `min(stop, open)`;
  - rank/trend exit fills at next open;
  - exits free a slot in the same cycle (a rank-exiting name's slot is reused by a buy);
  - the governor blocks new buys after a manufactured weekly/monthly drawdown, and
    halts at the max-DD threshold;
  - the trail advances only at the review, never intraday;
  - **cost reconciliation** (§4): the ledger `profitPct` (a direct
    `afterCostProfitPct` call) and the NAV-derived per-trade P&L agree within the
    documented tolerance for a single round-trip.
- **`metrics.mjs`** against a known equity curve with hand-computed CAGR / max DD /
  Sharpe / Sortino.
- **`benchmark.mjs`** against a known SPY series.
- **`report.mjs`** snapshot of the rendered markdown incl. the coverage counts and the
  PRELIMINARY banner.

The test runner/framework will match whatever `tests/` already uses (same as the rest
of the build, which has been TDD throughout).

---

## 11. Honesty discipline (the soul of this step)

- Every report is stamped **PRELIMINARY / survivorship-biased / not a verdict until
  step 7**, with coverage **quantified per window**.
- The structural tests (A/B/C/E/G/J) are read for *structure* — does the edge come from
  momentum (G)? does it beat a dumb baseline (A)? is it a calendar artifact (C)? does it
  survive 2× costs (E)? — not for an absolute verdict.
- No `STRATEGY_VERSION` bump, no `gp-config` write, no `alertMode: live` is part of this
  step. Going live remains a human act gated on a genuine step-7 PASS.
