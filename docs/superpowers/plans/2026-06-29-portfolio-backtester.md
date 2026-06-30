# Portfolio Backtester Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a portfolio NAV backtester that replays the `gp-momentum-1.0.0` strategy's decisions over historical bars and emits the Validation-Scorecard §1 metric table plus the in-scope structural robustness tests, side-by-side with SPY.

**Architecture:** A dedicated portfolio simulator (`scripts/backtest/`) that *imports* the live pure decision primitives (`portfolio.mjs`, `momentum.mjs`) and indicator primitives (`marketdata.mjs`: `atrWilder`, `sma`) and never re-implements exit/cost/ranking math, wrapped in its own compounding equity-curve loop with next-open fills, a daily stop-walk between weekly reviews, and real drawdowns that trip the circuit breakers. Pure modules (engine, metrics, benchmark, report) are unit-tested against known series; the I/O modules (cache, data, run) are thin shells.

**Tech Stack:** Node 22 ESM (`.mjs`), `node --test` + `node:assert/strict`, no new dependencies. Reuses `lambdas/shared/*`.

**Design spec:** `docs/superpowers/specs/2026-06-29-portfolio-backtester-design.md` (read it first).

## Global Constraints

- **Reuse, never re-implement** exit/cost/ranking math. Import `isEligible`, `rankByMomentum`, `sizePosition`, `updateTrailingStop`, `evaluateExits`, `riskGovernor`, `constructBook` from `lambdas/shared/portfolio.mjs`; `atrWilder`, `sma` from `lambdas/shared/marketdata.mjs`; `afterCostProfitPct`, `excursion` from `lambdas/shared/labeling.mjs`. Do NOT route decisions through `buildMomentumData` (its freshness gate is wall-clock-coupled and wrong for historical slices).
- **Next-open fills:** decisions at T-close fill at T+1-open, for both entries and rank/trend exits. Stops are the exception — intraday at the stop level, `min(stop, open)`.
- **Sizing locked at signal:** `shares = sizePosition(close_T, atr_T, equity_T).shares`; fill at `open_{T+1}`; `stop = open_{T+1} − kStop×atr_T`; `peakClose = open_{T+1}`. Documented approximation.
- **One cost model:** ledger `profitPct` is a direct `afterCostProfitPct(entry, exit, config)` call; the NAV curve applies the same `(feeBps+slippageBps)` bps as cash haircuts both sides; the two reconcile within tolerance (unit-tested).
- **Canonical governor drawdowns** (off the daily NAV curve, evaluated at each review): `fromPeakPct` = all-time peak→current; `weeklyPct` = peak over last **5** sessions → current; `monthlyPct` = peak over last **21** sessions → current. Magnitudes; `riskGovernor` already `Math.abs`-es.
- **Compute rank/eligibility/sizing ONLY on review days;** the daily loop between reviews does fills + stop-walk + MTM only.
- **Determinism:** no randomness. Any ablation "remove ranking" uses a deterministic substitute (by 20-day dollar volume, descending).
- **Frozen §8 params** come from `gp-config` (read at runtime in `run.mjs`); tests use inline literal configs.
- **Sharpe/Sortino use rf = 0** on both strategy and SPY (stated in the report).
- **Honesty frame:** every report stamped `PRELIMINARY — survivorship-biased, NOT a verdict until step 7`, coverage quantified per window.
- **Nothing live:** no `STRATEGY_VERSION` bump, no `gp-config` write, no `alertMode` change, no template/schedule change.
- **Test command:** `node --test tests/<file>.test.mjs`. Tests live in `tests/`, named `backtest-<module>.test.mjs`.
- **Commit style:** Conventional commits; one PR per task. End each commit body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

```
scripts/backtest/
  engine.mjs        # PURE: simulate(inputs, opts) -> { equityCurve, ledger, finalPositions }
  rankers.mjs       # PURE: ranking fns for test A + the zone-tagging helper (NOT the prod ranker)
  metrics.mjs       # PURE: computeMetrics(equityCurve, ledger, config) -> §1 table
  benchmark.mjs     # PURE: spyBuyHold(spyBars, calendar, startEquity, config) -> { equityCurve, ledger }
  report.mjs        # PURE: buildReport(ctx) -> { markdown, json }
  cache.mjs         # I/O: disk bar cache (readCache/writeCache)
  data.mjs          # I/O: loadUniverse, buildCalendar, coverageByWindow, detectStale
  run.mjs           # I/O: CLI entrypoint; wires everything; writes artifacts
  robustness/
    ablation.mjs        # G
    baseline.mjs        # A
    rebalance-day.mjs   # C
    cost.mjs            # E
    concentration.mjs   # B
    sweep.mjs           # J
docs/backtest/        # committed reports (gitignored cache below)
tests/
  backtest-engine.test.mjs
  backtest-metrics.test.mjs
  backtest-benchmark.test.mjs
  backtest-report.test.mjs
  backtest-cache.test.mjs
  backtest-data.test.mjs
  backtest-robustness.test.mjs
```

`.gitignore`: add `scripts/backtest/.cache/`.

---

## Shared data shapes (referenced by every task)

```js
// A bar (ascending, adjusted OHLCV):
{ date: "YYYY-MM-DD", open, high, low, close, volume }

// universe input to simulate(): array of
{ ticker, bars }                       // bars ascending

// Position (engine internal state):
{ ticker, shares, entry, entryDate, stop, peakClose, entryAtr }

// equityCurve entry (one per session):
{ date, nav, invested, cash }          // invested = Σ shares×close; nav = invested + cash

// ledger entry (one per closed trade):
{ ticker, entryDate, entry, shares, exitDate, exit, exitReason,
  profitPct, daysHeld, costPaid }      // exitReason ∈ hard_stop|trailing_stop|rank_exit|trend_exit|end_of_backtest

// config (frozen §8 + cost + sizing), e.g.:
{ regimeMa:200, trendMa:100, minPrice:5, minDollarVol:10_000_000,
  gapFilterPct:15, gapFilterWindow:90, momentumLookback:90,
  entryRankPct:20, exitRankPct:30, atrPeriod:20, kStop:2.5,
  riskPctPerTrade:0.75, targetPositions:15, maxPositions:20, positionCapPct:15,
  weeklyDdLimit:8, monthlyDdLimit:15, maxDdLimit:25,
  feeBps:0, slippageBps:10, timeoutTradingDays:252, accountSize:100000 }
```

---

## Task 1: Engine — core loop, next-open fills, daily stops, weekly review

**Files:**
- Create: `scripts/backtest/engine.mjs`
- Create: `scripts/backtest/rankers.mjs`
- Test: `tests/backtest-engine.test.mjs`

**Interfaces:**
- Consumes: `isEligible`, `rankByMomentum`, `sizePosition`, `evaluateExits`, `riskGovernor`, `constructBook` (portfolio.mjs); `atrWilder`, `sma` (marketdata.mjs); `afterCostProfitPct` (labeling.mjs).
- Produces:
  - `rankers.mjs`: `applyRankZones(scoredDesc, config)` → tags `{rank, rankPct, inEntryZone, inExitZone}` (mirrors rankByMomentum's zone math, for the test-A rankers only). `momentumRanker(items, config)` = thin wrapper over `rankByMomentum`.
  - `engine.mjs`: `simulate({ universe, spyBars, calendar, config }, { rankFn = momentumRanker, ablation = {}, rebalanceWeekday = 5, startEquity = config.accountSize ?? 100000 } = {})` → `{ equityCurve, ledger, finalPositions }`.

### rankers.mjs first (small, pure)

- [ ] **Step 1: Write the failing test** — append to `tests/backtest-engine.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRankZones, momentumRanker } from "../scripts/backtest/rankers.mjs";

const CFG = { momentumLookback: 90, entryRankPct: 20, exitRankPct: 30 };

test("applyRankZones: top entryRankPct inEntryZone, below exitRankPct inExitZone", () => {
  // 10 names already sorted strongest-first by some score.
  const scored = Array.from({ length: 10 }, (_, i) => ({ ticker: `T${i}`, score: 100 - i }));
  const ranked = applyRankZones(scored, CFG);
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[0].inEntryZone, true);   // top 20% → ranks 1-2
  assert.equal(ranked[1].inEntryZone, true);
  assert.equal(ranked[2].inEntryZone, false);  // rank 3 outside top 20%
  assert.equal(ranked[9].inExitZone, true);    // below top 30% (ranks >3)
  assert.equal(ranked[2].inExitZone, false);   // rank 3 == exitCut (ceil(0.3*10)=3) → not below
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/backtest-engine.test.mjs`
Expected: FAIL — `Cannot find module ... rankers.mjs`.

- [ ] **Step 3: Write `scripts/backtest/rankers.mjs`**

```js
// rankers.mjs — ranking helpers for the backtest. The PRODUCTION ranker is
// rankByMomentum (portfolio.mjs) and is reused untouched via momentumRanker.
// applyRankZones mirrors rankByMomentum's entry/exit zone tagging so the
// test-A baseline rankers (alternative metrics) produce the same shape.
import { rankByMomentum } from "../../lambdas/shared/portfolio.mjs";

const round = (n, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

// scoredDesc: array already sorted strongest-first, each { ticker, score, ... }.
export function applyRankZones(scoredDesc, config) {
  const n = scoredDesc.length;
  const entryCut = Math.ceil((config.entryRankPct / 100) * n);
  const exitCut = Math.ceil((config.exitRankPct / 100) * n);
  return scoredDesc.map((s, i) => {
    const rank = i + 1;
    const rankPct = n > 1 ? round(((n - rank) / (n - 1)) * 100, 2) : 100;
    return { ...s, rank, rankPct, inEntryZone: rank <= entryCut, inExitZone: rank > exitCut };
  });
}

// The production momentum ranker, reused as-is. items: [{ ticker, closes }].
export function momentumRanker(items, config) {
  return rankByMomentum(items, config);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/backtest-engine.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/backtest/rankers.mjs tests/backtest-engine.test.mjs
git commit -m "feat(backtest): rank-zone helper + production ranker wrapper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### engine.mjs — the simulation loop

- [ ] **Step 6: Write the failing test (next-open fill + daily stop)** — append to `tests/backtest-engine.test.mjs`:

```js
import { simulate } from "../scripts/backtest/engine.mjs";

// Minimal config: tiny windows so a short synthetic series is "eligible".
const ECFG = {
  regimeMa: 3, trendMa: 3, minPrice: 1, minDollarVol: 0,
  gapFilterPct: 100, gapFilterWindow: 3, momentumLookback: 3,
  entryRankPct: 100, exitRankPct: 100, atrPeriod: 3, kStop: 2.5,
  riskPctPerTrade: 0.75, targetPositions: 1, maxPositions: 1, positionCapPct: 100,
  weeklyDdLimit: 99, monthlyDdLimit: 99, maxDdLimit: 99,
  feeBps: 0, slippageBps: 0, timeoutTradingDays: 999, accountSize: 100000,
};

// Helper: build a session list of N weekdays starting 2020-01-06 (a Monday).
function sessions(n) {
  const out = [];
  let d = new Date(Date.UTC(2020, 0, 6));
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd >= 1 && wd <= 5) out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}

test("entry fills at next-day OPEN, not the signal-day close", () => {
  const cal = sessions(12);
  // One name rising steadily; SPY rising (regime on). open != close so the fill
  // price is unambiguous: open is distinct from prior close.
  const mk = (dates, fn) => dates.map((date, i) => {
    const c = fn(i);
    return { date, open: c - 0.5, high: c + 1, low: c - 1, close: c, volume: 1e6 };
  });
  const name = { ticker: "AAA", bars: mk(cal, (i) => 10 + i) };
  const spy = mk(cal, (i) => 100 + i);
  const { ledger, equityCurve, finalPositions } = simulate(
    { universe: [name], spyBars: spy, calendar: cal, config: ECFG },
    { rebalanceWeekday: 1 } // review on Mondays
  );
  // First review is cal[0] (Mon). Fill at cal[1] OPEN = close(cal[1]) - 0.5 = 11 - 0.5 = 10.5.
  assert.ok(finalPositions.length === 1);
  assert.equal(finalPositions[0].entry, 10.5);
  assert.equal(equityCurve.length, cal.length);
});
```

- [ ] **Step 7: Run to verify it fails**

Run: `node --test tests/backtest-engine.test.mjs`
Expected: FAIL — `simulate is not a function` / module missing.

- [ ] **Step 8: Write `scripts/backtest/engine.mjs`**

```js
// engine.mjs — portfolio NAV simulator (gp-momentum-1.0.0). PURE: bars in,
// equity curve + trade ledger out. Imports the live decision primitives and
// indicator primitives; re-implements no exit/cost/ranking math. See
// docs/superpowers/specs/2026-06-29-portfolio-backtester-design.md.
import { isEligible, sizePosition, evaluateExits, riskGovernor, constructBook }
  from "../../lambdas/shared/portfolio.mjs";
import { atrWilder, sma } from "../../lambdas/shared/marketdata.mjs";
import { afterCostProfitPct } from "../../lambdas/shared/labeling.mjs";
import { momentumRanker } from "./rankers.mjs";

const round = (n, dp = 4) => (Number.isFinite(n) ? Math.round(n * 10 ** dp) / 10 ** dp : n);
const weekdayOf = (isoDate) => new Date(`${isoDate}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat

// Drawdown magnitudes (%) off the daily NAV curve. peakWindow over the last
// `win` sessions (all-time when win=null). Returns a positive magnitude.
function ddOverWindow(curve, win) {
  if (curve.length === 0) return 0;
  const slice = win == null ? curve : curve.slice(-win);
  const peak = Math.max(...slice.map((p) => p.nav));
  const cur = curve[curve.length - 1].nav;
  return peak > 0 ? ((peak - cur) / peak) * 100 : 0;
}

export function simulate({ universe, spyBars, calendar, config }, opts = {}) {
  const { rankFn = momentumRanker, ablation = {}, rebalanceWeekday = 5,
          startEquity = config.accountSize ?? 100000 } = opts;
  const COST = (config.feeBps + config.slippageBps) / 1e4;

  // Per-name lookup of date -> bar index, and an ascending bars ref.
  const byTicker = new Map(universe.map((u) => [u.ticker, u]));
  const idxOf = new Map(); // ticker -> Map(date -> index)
  for (const u of universe) idxOf.set(u.ticker, new Map(u.bars.map((b, i) => [b.date, i])));
  const spyClose = new Map(spyBars.map((b) => [b.date, b.close]));
  const spyCloseAsc = spyBars.map((b) => b.close); // for regime SMA (point-in-time slice below)
  const spyIdx = new Map(spyBars.map((b, i) => [b.date, i]));

  let cash = startEquity;
  const positions = []; // {ticker, shares, entry, entryDate, stop, peakClose, entryAtr}
  const equityCurve = [];
  const ledger = [];
  let pending = { buys: [], sells: [] }; // filled at the NEXT session's open

  // Slice a name's bars up to and including `date` (null if name has no bar yet).
  const sliceTo = (ticker, date) => {
    const i = idxOf.get(ticker).get(date);
    if (i == null) return null;
    return byTicker.get(ticker).bars.slice(0, i + 1);
  };
  const barOn = (ticker, date) => {
    const i = idxOf.get(ticker).get(date);
    return i == null ? null : byTicker.get(ticker).bars[i];
  };
  const closeTrade = (pos, exitPrice, exitDate, exitReason) => {
    const profitPct = afterCostProfitPct(pos.entry, exitPrice, config);
    const costPaid = round(pos.shares * (pos.entry + exitPrice) * COST, 2);
    cash += pos.shares * exitPrice * (1 - COST);
    // daysHeld = trading sessions from entry to exit (inclusive of exit).
    const ei = calendar.indexOf(pos.entryDate), xi = calendar.indexOf(exitDate);
    ledger.push({
      ticker: pos.ticker, entryDate: pos.entryDate, entry: round(pos.entry),
      shares: pos.shares, exitDate, exit: round(exitPrice), exitReason,
      profitPct, daysHeld: xi - ei, costPaid,
    });
  };

  for (const date of calendar) {
    // --- 1. Execute queued orders at TODAY's open (sells first, then buys) ---
    for (const sell of pending.sells) {
      const pi = positions.findIndex((p) => p.ticker === sell.ticker);
      if (pi < 0) continue;
      const bar = barOn(sell.ticker, date);
      const fill = bar ? bar.open : positions[pi].entry; // no bar → exit flat
      closeTrade(positions[pi], fill, date, sell.reason);
      positions.splice(pi, 1);
    }
    for (const buy of pending.buys) {
      const bar = barOn(buy.ticker, date);
      if (!bar) continue; // no bar to fill against → drop the order
      const entry = bar.open;
      cash -= buy.shares * entry * (1 + COST);
      positions.push({
        ticker: buy.ticker, shares: buy.shares, entry, entryDate: date,
        stop: round(entry - config.kStop * buy.entryAtr), peakClose: entry, entryAtr: buy.entryAtr,
      });
    }
    pending = { buys: [], sells: [] };

    // --- 2. Daily stop-walk (every session; stored stop, no indicator recompute) ---
    for (let pi = positions.length - 1; pi >= 0; pi--) {
      const pos = positions[pi];
      const bar = barOn(pos.ticker, date);
      if (!bar) continue;
      if (bar.low <= pos.stop) {
        const fill = Math.min(pos.stop, bar.open); // pessimistic gap-through
        const reason = pos.stop <= pos.entry ? "hard_stop" : "trailing_stop";
        closeTrade(pos, fill, date, reason);
        positions.splice(pi, 1);
      }
    }

    // --- 3. Mark-to-market at TODAY's close → append NAV (used for drawdowns + decisions) ---
    let invested = 0;
    for (const pos of positions) {
      const bar = barOn(pos.ticker, date);
      const c = bar ? bar.close : pos.entry;
      invested += pos.shares * c;
    }
    equityCurve.push({ date, nav: round(cash + invested, 2), invested: round(invested, 2), cash: round(cash, 2) });

    // --- 4. Weekly review (only on the rebalance weekday) → queue next-open orders ---
    if (weekdayOf(date) !== rebalanceWeekday) continue;
    const equityNow = cash + invested;

    // Regime gate (ablation: noRegime skips it).
    let regimeOn = true;
    if (!ablation.noRegime) {
      const si = spyIdx.get(date);
      if (si == null || si + 1 < config.regimeMa) regimeOn = false;
      else {
        const spySlice = spyCloseAsc.slice(0, si + 1);
        const ma = sma(spySlice, config.regimeMa);
        regimeOn = ma != null && spySlice[spySlice.length - 1] > ma;
      }
    }

    // Eligibility + ranking over the universe, point-in-time.
    const trendMa = ablation.noTrend ? 1 : config.trendMa; // noTrend relaxes the trend screen
    const eligItems = [];
    const sliceCache = new Map();
    for (const u of universe) {
      const slice = sliceTo(u.ticker, date);
      if (!slice) continue;
      sliceCache.set(u.ticker, slice);
      const elig = isEligible(slice, { ...config, trendMa });
      if (elig.eligible) eligItems.push({ ticker: u.ticker, closes: slice.map((b) => b.close) });
    }
    const ranked = rankFn(eligItems, config);
    const rankByT = new Map(ranked.map((r) => [r.ticker, r]));

    // --- 4a. Exits BEFORE fills (rank/trend); STOP already owned by the daily walk ---
    const exiting = new Set();
    for (const pos of positions) {
      const slice = sliceCache.get(pos.ticker) ?? sliceTo(pos.ticker, date);
      if (!slice) continue;
      const bar = slice[slice.length - 1];
      const atr = atrWilder(slice, config.atrPeriod);
      const trendSma = ablation.noTrend ? null : sma(slice.map((b) => b.close), config.trendMa);
      const inExitZone = rankByT.get(pos.ticker)?.inExitZone ?? true; // not ranked → fell out → exit
      const res = evaluateExits(
        { entry: pos.entry, stop: pos.stop, peakClose: pos.peakClose },
        bar, { atr, trendSma, inExitZone }, config,
      );
      // Advance the trail for the NEXT week regardless (ratchets up only).
      pos.stop = res.stop; pos.peakClose = res.peakClose;
      if (res.exit && (res.reason === "RANK" || res.reason === "TREND")) {
        pending.sells.push({ ticker: pos.ticker, reason: res.reason === "RANK" ? "rank_exit" : "trend_exit" });
        exiting.add(pos.ticker);
      }
    }

    // --- 4b. Construct fills (regime + governor gate; size on current equity) ---
    if (!regimeOn) continue;
    const drawdowns = ablation.noGovernor
      ? { weeklyPct: 0, monthlyPct: 0, fromPeakPct: 0 }
      : { weeklyPct: ddOverWindow(equityCurve, 5), monthlyPct: ddOverWindow(equityCurve, 21), fromPeakPct: ddOverWindow(equityCurve, null) };
    const governor = riskGovernor(drawdowns, config);
    const heldNow = new Set(positions.map((p) => p.ticker).filter((t) => !exiting.has(t)));
    const { candidates, slots } = constructBook(ranked, heldNow, governor, config);
    let filled = 0;
    for (const r of candidates) {
      if (filled >= slots) break;
      const slice = sliceCache.get(r.ticker);
      if (!slice) continue;
      const atr = atrWilder(slice, config.atrPeriod);
      const signalClose = slice[slice.length - 1].close;
      let shares;
      if (ablation.noAtrSizing) {
        // Equal-weight: target an equal $ slice of equity, capped.
        const target = equityNow / Math.min(config.targetPositions, config.maxPositions);
        shares = Math.floor(target / signalClose);
        if (shares <= 0) continue;
      } else {
        const sized = sizePosition(signalClose, atr, equityNow, config);
        if (!sized) continue; // unsizable → next candidate backfills the slot
        shares = sized.shares;
      }
      pending.buys.push({ ticker: r.ticker, shares, entryAtr: atr });
      filled += 1;
    }
  }

  // --- End of run: close any open position at the last close (after cost) ---
  const lastDate = calendar[calendar.length - 1];
  for (const pos of [...positions]) {
    const bar = barOn(pos.ticker, lastDate);
    const fill = bar ? bar.close : pos.entry;
    closeTrade(pos, fill, lastDate, "end_of_backtest");
  }
  const finalPositions = []; // all closed at end-of-run
  return { equityCurve, ledger, finalPositions };
}
```

> **Note:** the test in Step 6 asserts `finalPositions.length === 1`, but the engine closes all positions at end-of-run. **Fix the test** to read the position from the ledger instead (the entry price is what we're checking): change the assertions to
> ```js
> const opened = ledger.find((t) => t.ticker === "AAA");
> assert.equal(opened.entry, 10.5);
> assert.equal(equityCurve.length, cal.length);
> ```
> (This is the correct contract — positions are flat at the end; entries are observable in the ledger.)

- [ ] **Step 9: Apply the test fix above, then run to verify it passes**

Run: `node --test tests/backtest-engine.test.mjs`
Expected: PASS.

- [ ] **Step 10: Add the daily-stop + exits-before-fills + governor tests**

```js
test("daily stop fills intraday at min(stop, open), reason hard_stop near entry", () => {
  const cal = sessions(12);
  // Name flat at 10 for warmup, then a one-day crash on cal[2] (the day AFTER fill).
  const bars = cal.map((date, i) => {
    if (i === 2) return { date, open: 9.9, high: 10, low: 5, close: 6, volume: 1e6 }; // gap+crash
    const c = 10;
    return { date, open: c, high: c + 0.2, low: c - 0.2, close: c, volume: 1e6 };
  });
  const spy = cal.map((date, i) => ({ date, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1e6 }));
  const { ledger } = simulate(
    { universe: [{ ticker: "BBB", bars }], spyBars: spy, calendar: cal, config: ECFG },
    { rebalanceWeekday: 1 }, // review Mon cal[0]; fill cal[1] open=10
  );
  const t = ledger.find((x) => x.ticker === "BBB");
  assert.equal(t.exitDate, cal[2]);
  assert.equal(t.exitReason, "hard_stop");          // stop set at entry-2.5*atr ≤ entry
  assert.equal(t.exit, Math.min(t.entry - 2.5 * 0, 9.9) === 9.9 ? t.exit : t.exit, ); // see note
  assert.ok(t.exit <= 9.9);                          // filled at worse of stop vs open(9.9)
});

test("governor blocks new buys after a manufactured weekly drawdown", () => {
  // A 2-name universe where, once equity drops >8% in a week, no NEW buys open.
  // Construct so a position is opened, craters (NAV down >8% over 5 sessions),
  // and a fresh candidate that becomes eligible is NOT bought that review.
  // (Full fixture in the test file; assert ledger has no entry dated after the
  //  drawdown review for the second name.)
  // This is a behavioral test — see the helper `manufactureDrawdown()` below.
});
```

> For the `hard_stop` exit-price assertion, with `slippageBps:0` and `atrPeriod:3` the ATR over a flat-10 series is ~0, so `stop ≈ entry = 10`; the crash day has `low=5 ≤ 10` and `open=9.9`, so `exit = min(10, 9.9) = 9.9`. Simplify the assertion to `assert.equal(t.exit, 9.9)`.

- [ ] **Step 11: Run to verify the stop test passes** (implement `manufactureDrawdown` fixture so the governor test is concrete, or mark it `test.skip` with a TODO referencing Task 1 follow-up if the fixture is large — but prefer concrete).

Run: `node --test tests/backtest-engine.test.mjs`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add scripts/backtest/engine.mjs tests/backtest-engine.test.mjs
git commit -m "feat(backtest): portfolio NAV engine — next-open fills, daily stops, weekly review

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Metrics — §1 table off the equity curve + ledger

**Files:**
- Create: `scripts/backtest/metrics.mjs`
- Test: `tests/backtest-metrics.test.mjs`

**Interfaces:**
- Produces: `computeMetrics(equityCurve, ledger, { startEquity })` → `{ cagr, maxDrawdown, sharpe, sortino, winRate, avgWin, avgLoss, expectancy, profitFactor, annualTurnover, avgHoldingDays, costDragPct, pctTimeInCash, worstLosingStreak, avgExposure, returnPerInvested, nTrades, finalNav }`. All numbers rounded; nulls where undefined (e.g. profitFactor with no losses).

- [ ] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMetrics } from "../scripts/backtest/metrics.mjs";

test("computeMetrics: CAGR and maxDrawdown on a known curve", () => {
  // 253 sessions (≈1 year), NAV 100k → 110k linearly, with a dip to 99k mid-way.
  const curve = [];
  for (let i = 0; i < 253; i++) {
    let nav = 100000 + (10000 * i) / 252;
    if (i === 120) nav = 99000; // a trough below the running peak
    curve.push({ date: `d${i}`, nav, invested: nav, cash: 0 });
  }
  const ledger = [
    { profitPct: 5, daysHeld: 10, exitDate: "d50", costPaid: 1 },
    { profitPct: -2, daysHeld: 8, exitDate: "d80", costPaid: 1 },
  ];
  const m = computeMetrics(curve, ledger, { startEquity: 100000 });
  assert.ok(Math.abs(m.cagr - 10) < 0.5);            // ≈10% over ~1y
  assert.ok(m.maxDrawdown > 0);                       // the dip registers
  assert.equal(m.nTrades, 2);
  assert.equal(m.winRate, 50);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/backtest-metrics.test.mjs`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `scripts/backtest/metrics.mjs`**

```js
// metrics.mjs — Validation-Scorecard §1 metrics from an equity curve + ledger.
// PURE. Sharpe/Sortino use rf = 0 (stated in the report). All after-cost.
const round = (n, dp = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** dp) / 10 ** dp : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const std = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};

export function computeMetrics(equityCurve, ledger, { startEquity }) {
  const n = equityCurve.length;
  const navStart = startEquity;
  const navEnd = n ? equityCurve[n - 1].nav : startEquity;
  const years = n / 252;

  const cagr = years > 0 && navStart > 0 ? (Math.pow(navEnd / navStart, 1 / years) - 1) * 100 : null;

  // Max drawdown on the daily NAV curve.
  let peak = -Infinity, maxDD = 0;
  for (const p of equityCurve) { peak = Math.max(peak, p.nav); maxDD = Math.max(maxDD, (peak - p.nav) / peak); }

  // Daily returns.
  const rets = [];
  for (let i = 1; i < n; i++) rets.push(equityCurve[i].nav / equityCurve[i - 1].nav - 1);
  const rMean = mean(rets), rStd = std(rets);
  const downside = rets.filter((r) => r < 0);
  const dStd = downside.length >= 2 ? Math.sqrt(downside.reduce((a, r) => a + r * r, 0) / downside.length) : null;
  const sharpe = rStd ? (rMean / rStd) * Math.sqrt(252) : null;
  const sortino = dStd ? (rMean / dStd) * Math.sqrt(252) : null;

  // Trade stats.
  const p = ledger.map((t) => t.profitPct);
  const wins = p.filter((x) => x > 0), losses = p.filter((x) => x <= 0);
  const grossW = wins.reduce((a, b) => a + b, 0), grossL = Math.abs(losses.reduce((a, b) => a + b, 0));

  // Exposure + cash.
  const inCash = equityCurve.filter((e) => e.invested === 0).length;
  const avgExposure = mean(equityCurve.map((e) => (e.nav > 0 ? e.invested / e.nav : 0)));

  // Turnover (one-sided): Σ buy notional / avg equity / years. Buy notional ≈
  // entry value per ledger trade.
  const buyNotional = ledger.reduce((a, t) => a + t.entry * t.shares, 0);
  const avgEquity = mean(equityCurve.map((e) => e.nav)) ?? startEquity;
  const annualTurnover = avgEquity > 0 && years > 0 ? buyNotional / avgEquity / years : null;

  // Cost drag as % of gross return.
  const totalCost = ledger.reduce((a, t) => a + (t.costPaid ?? 0), 0);
  const grossReturn$ = navEnd - navStart + totalCost;
  const costDragPct = grossReturn$ > 0 ? (totalCost / grossReturn$) * 100 : null;

  // Worst losing streak (consecutive losing trades by exitDate).
  const ordered = [...ledger].sort((a, b) => String(a.exitDate).localeCompare(String(b.exitDate)));
  let streak = 0, worst = 0;
  for (const t of ordered) { if (t.profitPct <= 0) { streak += 1; worst = Math.max(worst, streak); } else streak = 0; }

  const totalReturnPct = navStart > 0 ? (navEnd / navStart - 1) * 100 : null;
  const returnPerInvested = avgExposure > 0 && totalReturnPct != null ? totalReturnPct / avgExposure : null;

  return {
    cagr: round(cagr), maxDrawdown: round(maxDD * 100), sharpe: round(sharpe), sortino: round(sortino),
    winRate: round(p.length ? (wins.length / p.length) * 100 : null), avgWin: round(mean(wins)), avgLoss: round(mean(losses)),
    expectancy: round(mean(p)), profitFactor: grossL > 0 ? round(grossW / grossL) : null,
    annualTurnover: round(annualTurnover), avgHoldingDays: round(mean(ledger.map((t) => t.daysHeld))),
    costDragPct: round(costDragPct), pctTimeInCash: round(n ? (inCash / n) * 100 : null),
    worstLosingStreak: worst, avgExposure: round(avgExposure), returnPerInvested: round(returnPerInvested),
    nTrades: ledger.length, finalNav: round(navEnd),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/backtest-metrics.test.mjs`
Expected: PASS.

- [ ] **Step 5: Add a Sharpe/Sortino test on a known return series, then commit**

```js
test("computeMetrics: Sharpe positive for steady gains, Sortino ≥ Sharpe", () => {
  const curve = [{ date: "d0", nav: 100000, invested: 0, cash: 100000 }];
  for (let i = 1; i < 60; i++) curve.push({ date: `d${i}`, nav: curve[i - 1].nav * 1.001, invested: 0, cash: curve[i - 1].nav * 1.001 });
  const m = computeMetrics(curve, [], { startEquity: 100000 });
  assert.ok(m.sharpe > 0);
  assert.ok(m.sortino === null || m.sortino >= m.sharpe); // no/low downside → Sortino ≥ Sharpe
});
```

```bash
git add scripts/backtest/metrics.mjs tests/backtest-metrics.test.mjs
git commit -m "feat(backtest): §1 metric table (CAGR/DD/Sharpe/Sortino/turnover/exposure)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Benchmark — SPY buy-and-hold over the identical calendar

**Files:**
- Create: `scripts/backtest/benchmark.mjs`
- Test: `tests/backtest-benchmark.test.mjs`

**Interfaces:**
- Consumes: nothing (uses fractional shares; pure).
- Produces: `spyBuyHold(spyBars, calendar, startEquity, config)` → `{ equityCurve, ledger }` in the SAME shape as the engine, so `computeMetrics` runs over it unchanged. Buy at `calendar[0]` open with all equity (one cost), hold to last close (one cost on the closing round-trip).

- [ ] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spyBuyHold } from "../scripts/backtest/benchmark.mjs";
import { computeMetrics } from "../scripts/backtest/metrics.mjs";

test("spyBuyHold: curve tracks SPY, one round-trip trade, metrics computable", () => {
  const cal = Array.from({ length: 100 }, (_, i) => `d${String(i).padStart(3, "0")}`);
  const spy = cal.map((date, i) => ({ date, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1e6 }));
  const cfg = { feeBps: 0, slippageBps: 10 };
  const { equityCurve, ledger } = spyBuyHold(spy, cal, 100000, cfg);
  assert.equal(equityCurve.length, cal.length);
  assert.equal(ledger.length, 1);
  const m = computeMetrics(equityCurve, ledger, { startEquity: 100000 });
  assert.ok(m.cagr !== null);
  assert.ok(m.finalNav > 100000); // SPY rose ~99% over the window, minus costs
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test tests/backtest-benchmark.test.mjs` → FAIL (module missing).

- [ ] **Step 3: Write `scripts/backtest/benchmark.mjs`**

```js
// benchmark.mjs — SPY buy-and-hold over the identical calendar, same cost model
// and same curve/ledger shape as the engine so computeMetrics is reused verbatim.
import { afterCostProfitPct } from "../../lambdas/shared/labeling.mjs";
const round = (n, dp = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** dp) / 10 ** dp : n);

export function spyBuyHold(spyBars, calendar, startEquity, config) {
  const COST = (config.feeBps + config.slippageBps) / 1e4;
  const byDate = new Map(spyBars.map((b) => [b.date, b]));
  const first = byDate.get(calendar[0]);
  const last = byDate.get(calendar[calendar.length - 1]);
  // Fractional shares; full deployment at the first open (cost on the buy).
  const entry = first.open;
  const shares = (startEquity / (entry * (1 + COST)));
  const equityCurve = calendar.map((date) => {
    const b = byDate.get(date);
    const px = b ? b.close : entry;
    const nav = shares * px; // fully invested; cash ≈ 0
    return { date, nav: round(nav, 2), invested: round(nav, 2), cash: 0 };
  });
  const exit = last.close;
  const ledger = [{
    ticker: "SPY", entryDate: calendar[0], entry: round(entry), shares: round(shares, 6),
    exitDate: calendar[calendar.length - 1], exit: round(exit), exitReason: "end_of_backtest",
    profitPct: afterCostProfitPct(entry, exit, config), daysHeld: calendar.length - 1,
    costPaid: round(shares * (entry + exit) * COST, 2),
  }];
  return { equityCurve, ledger };
}
```

- [ ] **Step 4: Run to verify it passes** — `node --test tests/backtest-benchmark.test.mjs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/backtest/benchmark.mjs tests/backtest-benchmark.test.mjs
git commit -m "feat(backtest): SPY buy-and-hold benchmark (engine-shaped curve+ledger)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Cost reconciliation test (load-bearing — §4/§10)

**Files:**
- Test: `tests/backtest-engine.test.mjs` (append)

**Interfaces:** Consumes `simulate`, `afterCostProfitPct`. Produces nothing new — this task is the structural guarantee that the NAV cash-haircut cost and the ledger `afterCostProfitPct` agree.

- [ ] **Step 1: Write the reconciliation test**

```js
import { afterCostProfitPct as acpp } from "../lambdas/shared/labeling.mjs";

test("cost reconciliation: ledger profitPct ≡ NAV-derived per-trade P&L (within tolerance)", () => {
  // Single round-trip, nonzero cost. One name bought then trend-exited.
  const cal = sessions(20);
  const bars = cal.map((date, i) => {
    const c = i < 8 ? 10 + i : 18 - (i - 8) * 2; // rises then falls below trend → trend/rank exit
    return { date, open: c, high: c + 0.1, low: c - 0.1, close: c, volume: 1e6 };
  });
  const spy = cal.map((date, i) => ({ date, open: 100, high: 100, low: 100, close: 100, volume: 1e6 }));
  const cfg = { ...ECFG, slippageBps: 10, feeBps: 5 };
  const { ledger, equityCurve } = simulate(
    { universe: [{ ticker: "CCC", bars }], spyBars: spy, calendar: cal, config: cfg },
    { rebalanceWeekday: 1 },
  );
  const t = ledger[0];
  // (a) ledger profitPct is exactly afterCostProfitPct(entry, exit):
  assert.equal(t.profitPct, acpp(t.entry, t.exit, cfg));
  // (b) NAV-derived per-trade P&L (cash haircuts) agrees within tolerance:
  const COST = (cfg.feeBps + cfg.slippageBps) / 1e4;
  const buyCash = t.shares * t.entry * (1 + COST);
  const sellProceeds = t.shares * t.exit * (1 - COST);
  const navPnlPct = ((sellProceeds - buyCash) / buyCash) * 100;
  assert.ok(Math.abs(navPnlPct - t.profitPct) < 0.05, `navPnl=${navPnlPct} ledger=${t.profitPct}`);
});
```

- [ ] **Step 2: Run to verify it passes** (the engine already implements both paths)

Run: `node --test tests/backtest-engine.test.mjs`
Expected: PASS. If (a) fails, the engine isn't calling `afterCostProfitPct` for the ledger — fix `closeTrade`. If (b) fails beyond tolerance, re-examine the second-order cost difference noted in spec §4.

- [ ] **Step 3: Commit**

```bash
git add tests/backtest-engine.test.mjs
git commit -m "test(backtest): cost reconciliation — ledger profitPct ≡ NAV cash-haircut P&L

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Report — markdown + JSON, stamped, with quantified coverage

**Files:**
- Create: `scripts/backtest/report.mjs`
- Test: `tests/backtest-report.test.mjs`

**Interfaces:**
- Produces: `buildReport(ctx)` → `{ markdown, json }`. `ctx` shape:
  ```js
  { strategyVersion, gitSha, runTimestamp, period: { start, end }, universeSize,
    params,                       // the frozen §8 config (object)
    strategy: <metrics object>, spy: <metrics object>,
    tests: { ablation, baseline, rebalanceDay, cost, concentration, sweep }, // each: array/object of rows (may be null if not run)
    coverage: [ { window, namesWithData, total } ],
    warnings: [ "..." ] }        // stale-cache / split-discontinuity notes
  ```
- `json` = the `ctx` plus a computed `passFail` array. `markdown` renders all of it under the PRELIMINARY banner with the rf=0 note.

- [ ] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport } from "../scripts/backtest/report.mjs";

const M = { cagr: 9, maxDrawdown: 18, sharpe: 0.8, sortino: 1.1, winRate: 45, avgWin: 12, avgLoss: -6,
  expectancy: 2, profitFactor: 1.4, annualTurnover: 3, avgHoldingDays: 40, costDragPct: 8,
  pctTimeInCash: 22, worstLosingStreak: 4, avgExposure: 0.7, returnPerInvested: 13, nTrades: 50, finalNav: 142000 };
const SPY = { ...M, cagr: 11, maxDrawdown: 34, sharpe: 0.6, sortino: 0.7, finalNav: 150000 };

test("buildReport: stamps PRELIMINARY, rf=0, SHA, and quantified coverage", () => {
  const { markdown, json } = buildReport({
    strategyVersion: "gp-momentum-1.0.0", gitSha: "abc1234", runTimestamp: "2026-06-29T00:00:00Z",
    period: { start: "2015-01-02", end: "2026-06-26" }, universeSize: 199,
    params: { trendMa: 100, kStop: 2.5 },
    strategy: M, spy: SPY, tests: {},
    coverage: [{ window: "2008-2009", namesWithData: 42, total: 199 }],
    warnings: ["AAPL cache age 9d > 7d threshold"],
  });
  assert.match(markdown, /PRELIMINARY/);
  assert.match(markdown, /rf\s*=\s*0/);
  assert.match(markdown, /abc1234/);
  assert.match(markdown, /2008-2009: 42\/199/);
  assert.match(markdown, /cache age 9d/);
  assert.ok(Array.isArray(json.passFail));
  // Max-DD criterion: 18 ≤ 0.65*34 = 22.1 → pass.
  const dd = json.passFail.find((c) => /drawdown/i.test(c.criterion));
  assert.equal(dd.pass, true);
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test tests/backtest-report.test.mjs` → FAIL.

- [ ] **Step 3: Write `scripts/backtest/report.mjs`**

```js
// report.mjs — render the Scorecard run as markdown + JSON. PURE. The §3 PASS/
// FAIL checks are computed but rendered under a loud PRELIMINARY banner: nothing
// here is a verdict until the step-7 survivorship-free re-run.
const fmt = (v) => (v == null ? "—" : String(v));

function passFail(s, spy) {
  const checks = [];
  const cagrOk = s.cagr != null && spy.cagr != null && s.cagr >= spy.cagr - 2;
  checks.push({ criterion: "After-cost CAGR ≥ SPY − 2 pts", strategy: s.cagr, spy: spy.cagr, pass: cagrOk });
  const ddOk = s.maxDrawdown != null && spy.maxDrawdown != null && s.maxDrawdown <= 0.65 * spy.maxDrawdown;
  checks.push({ criterion: "Max drawdown ≤ 0.65 × SPY", strategy: s.maxDrawdown, spy: spy.maxDrawdown, pass: ddOk });
  const sortOk = s.sortino != null && spy.sortino != null && s.sortino > spy.sortino && s.sharpe >= spy.sharpe;
  checks.push({ criterion: "Sortino > SPY and Sharpe ≥ SPY", strategy: `${s.sortino}/${s.sharpe}`, spy: `${spy.sortino}/${spy.sharpe}`, pass: sortOk });
  return checks;
}

const METRIC_ROWS = [
  ["After-cost CAGR %", "cagr"], ["Max drawdown %", "maxDrawdown"], ["Sharpe (rf=0)", "sharpe"],
  ["Sortino (rf=0)", "sortino"], ["Win rate %", "winRate"], ["Avg win %", "avgWin"], ["Avg loss %", "avgLoss"],
  ["Expectancy %/trade", "expectancy"], ["Profit factor", "profitFactor"], ["Annual turnover", "annualTurnover"],
  ["Avg holding days", "avgHoldingDays"], ["Cost drag %", "costDragPct"], ["% time in cash", "pctTimeInCash"],
  ["Worst losing streak", "worstLosingStreak"], ["Avg exposure", "avgExposure"], ["Return / invested $", "returnPerInvested"],
  ["# trades", "nTrades"], ["Final NAV", "finalNav"],
];

export function buildReport(ctx) {
  const { strategy: s, spy, coverage = [], warnings = [], tests = {} } = ctx;
  const checks = passFail(s, spy);
  const json = { ...ctx, passFail: checks };

  const lines = [];
  lines.push(`# Validation Scorecard Run — ${ctx.strategyVersion}`);
  lines.push("");
  lines.push(`> **PRELIMINARY — survivorship-biased, NOT a verdict until step 7.** Run on the hand-curated watchlist; absolute numbers are optimistic. Structural tests (A/B/C/E/G/J) are read for structure, not for a verdict.`);
  lines.push("");
  lines.push(`- **git SHA:** \`${ctx.gitSha}\`  •  **run:** ${ctx.runTimestamp}`);
  lines.push(`- **period:** ${ctx.period.start} → ${ctx.period.end}  •  **universe:** ${ctx.universeSize} names`);
  lines.push(`- **Sharpe/Sortino computed with rf = 0** (both strategy and SPY, so the comparison cancels).`);
  lines.push(`- **params:** \`${JSON.stringify(ctx.params)}\``);
  lines.push("");
  lines.push(`## §1 Metrics — strategy vs SPY buy-and-hold`);
  lines.push("");
  lines.push(`| Metric | Strategy | SPY |`);
  lines.push(`|---|---|---|`);
  for (const [label, key] of METRIC_ROWS) lines.push(`| ${label} | ${fmt(s[key])} | ${fmt(spy[key])} |`);
  lines.push("");
  lines.push(`## §3 PASS/FAIL — PRELIMINARY (not a verdict)`);
  lines.push("");
  lines.push(`| Criterion | Strategy | SPY | Pass? |`);
  lines.push(`|---|---|---|---|`);
  for (const c of checks) lines.push(`| ${c.criterion} | ${fmt(c.strategy)} | ${fmt(c.spy)} | ${c.pass ? "✅" : "❌"} |`);
  lines.push("");
  lines.push(`## Survivorship coverage (quantified)`);
  lines.push("");
  for (const cov of coverage) lines.push(`- **${cov.window}: ${cov.namesWithData}/${cov.total}** names had full data over this window.`);
  if (warnings.length) {
    lines.push("");
    lines.push(`### ⚠️ Data warnings`);
    for (const w of warnings) lines.push(`- ${w}`);
  }
  // Structural test sections (rendered only when present).
  for (const [name, body] of Object.entries(tests)) {
    if (body == null) continue;
    lines.push("");
    lines.push(`## Robustness — ${name}`);
    lines.push("```json");
    lines.push(JSON.stringify(body, null, 2));
    lines.push("```");
  }
  return { markdown: lines.join("\n"), json };
}
```

- [ ] **Step 4: Run to verify it passes** — `node --test tests/backtest-report.test.mjs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/backtest/report.mjs tests/backtest-report.test.mjs
git commit -m "feat(backtest): markdown+JSON report — PRELIMINARY banner, rf=0, coverage

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Cache + Data (I/O) — disk cache, universe load, calendar, coverage, stale/split detection

**Files:**
- Create: `scripts/backtest/cache.mjs`
- Create: `scripts/backtest/data.mjs`
- Modify: `.gitignore` (add `scripts/backtest/.cache/`)
- Test: `tests/backtest-cache.test.mjs`, `tests/backtest-data.test.mjs`

**Interfaces:**
- `cache.mjs`: `readCache(dir, ticker, startDate)` → `{ bars, fetchedAt } | null`; `writeCache(dir, ticker, startDate, bars, fetchedAt)` → void.
- `data.mjs`:
  - `loadUniverse({ tickers, startDate, dir, fetchBars, now })` → `[{ ticker, bars }]` (cache-first; `fetchBars(ticker, startDate)` injected so tests pass a fake).
  - `buildCalendar(spyBars, start, end)` → array of date strings (SPY sessions in range).
  - `coverageByWindow(universe, windows)` → `[{ window, namesWithData, total }]` (a name "has data" over `[a,b]` if its first bar ≤ a and last bar ≥ b).
  - `detectStaleAndSplits(universe, { now, maxAgeDays, fetchedAtByTicker })` → `[warning strings]` (age > threshold; adjacent-close ratio outside [0.67, 1.5]).

- [ ] **Step 1: Cache round-trip test** (`tests/backtest-cache.test.mjs`)

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCache, writeCache } from "../scripts/backtest/cache.mjs";

test("cache: write then read returns the same bars + fetchedAt", () => {
  const dir = mkdtempSync(join(tmpdir(), "gp-cache-"));
  const bars = [{ date: "2020-01-02", open: 1, high: 2, low: 1, close: 1.5, volume: 100 }];
  writeCache(dir, "AAA", "2010-01-01", bars, "2026-06-29T00:00:00Z");
  const got = readCache(dir, "AAA", "2010-01-01");
  assert.deepEqual(got.bars, bars);
  assert.equal(got.fetchedAt, "2026-06-29T00:00:00Z");
  assert.equal(readCache(dir, "MISSING", "2010-01-01"), null);
});
```

- [ ] **Step 2: Run → FAIL.** `node --test tests/backtest-cache.test.mjs`

- [ ] **Step 3: Write `scripts/backtest/cache.mjs`**

```js
// cache.mjs — disk bar cache so the robustness battery doesn't re-hit Tiingo.
// Keyed by ticker + startDate. Stores adjusted OHLCV + fetchedAt for staleness.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const keyFile = (dir, ticker, startDate) => join(dir, `${ticker}_${startDate}.json`);

export function readCache(dir, ticker, startDate) {
  const f = keyFile(dir, ticker, startDate);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
}

export function writeCache(dir, ticker, startDate, bars, fetchedAt) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(keyFile(dir, ticker, startDate), JSON.stringify({ bars, fetchedAt }));
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Data tests** (`tests/backtest-data.test.mjs`)

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUniverse, buildCalendar, coverageByWindow, detectStaleAndSplits } from "../scripts/backtest/data.mjs";

test("loadUniverse: cache-first, fetches only on miss", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gp-data-"));
  let calls = 0;
  const fetchBars = async (t) => { calls += 1; return [{ date: "2020-01-02", open: 1, high: 1, low: 1, close: 1, volume: 9 }]; };
  const a = await loadUniverse({ tickers: ["AAA"], startDate: "2010-01-01", dir, fetchBars, now: "2026-06-29T00:00:00Z" });
  const b = await loadUniverse({ tickers: ["AAA"], startDate: "2010-01-01", dir, fetchBars, now: "2026-06-29T00:00:00Z" });
  assert.equal(calls, 1);                  // second load hits the cache
  assert.equal(a[0].ticker, "AAA");
  assert.equal(b[0].bars.length, 1);
});

test("buildCalendar: SPY sessions within range, ascending", () => {
  const spy = ["d1", "d2", "d3", "d4"].map((date, i) => ({ date, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
  assert.deepEqual(buildCalendar(spy, "d2", "d3"), ["d2", "d3"]);
});

test("coverageByWindow: counts names spanning the window", () => {
  const uni = [
    { ticker: "OLD", bars: [{ date: "2005-01-01" }, { date: "2026-01-01" }] },
    { ticker: "NEW", bars: [{ date: "2019-01-01" }, { date: "2026-01-01" }] },
  ];
  const cov = coverageByWindow(uni, [{ window: "2008-2009", start: "2008-01-01", end: "2009-12-31" }]);
  assert.equal(cov[0].namesWithData, 1); // only OLD spans 2008-2009
  assert.equal(cov[0].total, 2);
});

test("detectStaleAndSplits: flags old cache + a price discontinuity", () => {
  const uni = [{ ticker: "SPLIT", bars: [{ date: "d1", close: 100 }, { date: "d2", close: 49 }] }];
  const w = detectStaleAndSplits(uni, { now: "2026-06-29T00:00:00Z", maxAgeDays: 7,
    fetchedAtByTicker: { SPLIT: "2026-06-01T00:00:00Z" } });
  assert.ok(w.some((s) => /SPLIT/.test(s) && /age/.test(s)));        // 28d > 7d
  assert.ok(w.some((s) => /SPLIT/.test(s) && /discontinuit/i.test(s))); // 49/100 < 0.67
});
```

- [ ] **Step 6: Run → FAIL.** `node --test tests/backtest-data.test.mjs`

- [ ] **Step 7: Write `scripts/backtest/data.mjs`**

```js
// data.mjs — universe loading (cache-first), calendar, survivorship coverage,
// and stale-cache / split-discontinuity detection. fetchBars is injected so the
// engine/tests stay offline; run.mjs passes the real getDailyBars wrapper.
import { readCache, writeCache } from "./cache.mjs";

export async function loadUniverse({ tickers, startDate, dir, fetchBars, now, throttleMs = 0 }) {
  const out = [];
  for (const ticker of tickers) {
    const cached = readCache(dir, ticker, startDate);
    if (cached) { out.push({ ticker, bars: cached.bars, fetchedAt: cached.fetchedAt }); continue; }
    if (throttleMs) await new Promise((r) => setTimeout(r, throttleMs));
    const bars = await fetchBars(ticker, startDate);
    writeCache(dir, ticker, startDate, bars, now);
    out.push({ ticker, bars, fetchedAt: now });
  }
  return out;
}

export function buildCalendar(spyBars, start, end) {
  return spyBars.map((b) => b.date).filter((d) => d >= start && d <= end);
}

export function coverageByWindow(universe, windows) {
  return windows.map(({ window, start, end }) => {
    const namesWithData = universe.filter((u) => {
      if (!u.bars.length) return false;
      return u.bars[0].date <= start && u.bars[u.bars.length - 1].date >= end;
    }).length;
    return { window, namesWithData, total: universe.length };
  });
}

export function detectStaleAndSplits(universe, { now, maxAgeDays = 7, fetchedAtByTicker = {} }) {
  const warnings = [];
  const nowMs = new Date(now).getTime();
  for (const u of universe) {
    const fa = fetchedAtByTicker[u.ticker] ?? u.fetchedAt;
    if (fa) {
      const ageDays = (nowMs - new Date(fa).getTime()) / 86400000;
      if (ageDays > maxAgeDays) warnings.push(`${u.ticker}: cache age ${Math.round(ageDays)}d > ${maxAgeDays}d threshold — consider --refresh`);
    }
    for (let i = 1; i < u.bars.length; i++) {
      const prev = u.bars[i - 1].close, cur = u.bars[i].close;
      if (prev > 0) {
        const ratio = cur / prev;
        if (ratio > 1.5 || ratio < 0.67) warnings.push(`${u.ticker}: price discontinuity ${prev}→${cur} (${u.bars[i].date}) — possible unadjusted split, --refresh`);
      }
    }
  }
  return warnings;
}
```

- [ ] **Step 8: Run → PASS.** Add `scripts/backtest/.cache/` to `.gitignore`.

- [ ] **Step 9: Commit**

```bash
git add scripts/backtest/cache.mjs scripts/backtest/data.mjs tests/backtest-cache.test.mjs tests/backtest-data.test.mjs .gitignore
git commit -m "feat(backtest): disk cache + data layer (coverage, stale/split warnings)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Robustness battery (A, B, C, E, G, J)

**Files:**
- Create: `scripts/backtest/robustness/baseline.mjs` (A), `ablation.mjs` (G), `rebalance-day.mjs` (C), `cost.mjs` (E), `concentration.mjs` (B), `sweep.mjs` (J)
- Test: `tests/backtest-robustness.test.mjs`

**Interfaces:** every module exports a function `(baseInputs, run) => result`, where `run = (inputsOverride, optsOverride) => ({ equityCurve, ledger })` is a thin closure the caller supplies that runs `simulate` then is scored by `computeMetrics`. To keep them pure/testable, each returns a plain object.

- `baseline.mjs`: `runBaselines(baseInputs, runMetrics)` → `[{ metric, cagr }]` for rankers: `return126`, `return189`, `slopeOnly`, `slopeR2` (the production default). Needs alternative rankers (return/slope) built on `applyRankZones`.
- `ablation.mjs`: `runAblation(baseInputs, runMetrics)` → `[{ removed, cagr, maxDrawdown, sharpe }]` for flags `noRegime,noRanking,noAtrSizing,noGovernor,noTrend` + a `baseline` row (nothing removed).
- `rebalance-day.mjs`: `runRebalanceDays(baseInputs, runMetrics)` → `{ rows: [{ weekday, cagr }], cagrSpread, sameVerdict }`.
- `cost.mjs`: `runCostSensitivity(baseInputs, runMetrics)` → `{ base: {cagr,maxDrawdown}, double: {cagr,maxDrawdown} }`.
- `concentration.mjs`: `runConcentration(equityCurve)` → `{ full, strip5, strip10, strip20 }` monthly-return-stripped CAGR proxies.
- `sweep.mjs`: `runTrendMaSweep(baseInputs, runMetrics)` → `[{ trendMa, cagr, maxDrawdown }]` for `{80,90,100,110,120,150}`.

> **Ranker note for A:** add `return126Ranker`, `return189Ranker`, `slopeRanker` to `rankers.mjs`, each computing a score per name from `closes` and tagging zones via `applyRankZones`. `slopeR2Ranker` = `momentumRanker`. These are *test scaffolding* — `rankByMomentum` remains the sole production ranker.

- [ ] **Step 1: Write the failing tests** (`tests/backtest-robustness.test.mjs`)

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAblation } from "../scripts/backtest/robustness/ablation.mjs";
import { runRebalanceDays } from "../scripts/backtest/robustness/rebalance-day.mjs";
import { runConcentration } from "../scripts/backtest/robustness/concentration.mjs";

// A fake `runMetrics(inputsOverride, optsOverride)` that returns deterministic
// metrics keyed off the ablation flag / weekday, so we test the harness wiring
// (not the engine, which has its own tests).
test("runAblation: one row per removed rule + a baseline row", () => {
  const runMetrics = (_inputs, opts) => ({ cagr: opts.ablation && Object.keys(opts.ablation).length ? 5 : 9, maxDrawdown: 20, sharpe: 0.5 });
  const rows = runAblation({}, runMetrics);
  const removed = rows.map((r) => r.removed);
  assert.ok(removed.includes("baseline"));
  for (const f of ["noRegime", "noRanking", "noAtrSizing", "noGovernor", "noTrend"]) assert.ok(removed.includes(f));
});

test("runRebalanceDays: 5 rows, computes spread + sameVerdict", () => {
  const runMetrics = (_i, opts) => ({ cagr: 10 + opts.rebalanceWeekday * 0.1, maxDrawdown: 20 });
  const r = runRebalanceDays({}, runMetrics);
  assert.equal(r.rows.length, 5);
  assert.ok(Math.abs(r.cagrSpread - 0.4) < 1e-9); // (10.5 - 10.1)
});

test("runConcentration: stripping best months lowers the return proxy", () => {
  // 24 monthly steps; one huge month dominates.
  const curve = [];
  let nav = 100000;
  for (let i = 0; i < 24 * 21; i++) {
    const monthly = i === 21 * 5 ? 1.5 : 1.001; // one +50% month
    nav *= Math.pow(monthly, 1 / 21);
    curve.push({ date: `2010-${String(1 + Math.floor(i / 21)).padStart(2, "0")}-01`, nav, invested: nav, cash: 0 });
  }
  const c = runConcentration(curve);
  assert.ok(c.strip10 <= c.full); // removing the best months reduces the proxy
});
```

- [ ] **Step 2: Run → FAIL.** `node --test tests/backtest-robustness.test.mjs`

- [ ] **Step 3: Write the six robustness modules + the baseline rankers.** Each is small; here are the load-bearing two (`ablation.mjs`, `rebalance-day.mjs`) and the pattern; implement `cost.mjs`, `sweep.mjs`, `concentration.mjs`, `baseline.mjs` analogously.

`scripts/backtest/robustness/ablation.mjs`:
```js
// G — ablation: remove one rule at a time; read on risk-adjusted terms (removing
// the governor often RAISES CAGR while wrecking drawdown — expected, not a reason
// to drop it; see Scorecard §2-G).
const FLAGS = ["noRegime", "noRanking", "noAtrSizing", "noGovernor", "noTrend"];
export function runAblation(baseInputs, runMetrics) {
  const rows = [{ removed: "baseline", ...pick(runMetrics(baseInputs, {})) }];
  for (const f of FLAGS) rows.push({ removed: f, ...pick(runMetrics(baseInputs, { ablation: { [f]: true } })) });
  return rows;
}
function pick(m) { return { cagr: m.cagr, maxDrawdown: m.maxDrawdown, sharpe: m.sharpe }; }
```

`scripts/backtest/robustness/rebalance-day.mjs`:
```js
// C — rebalance-day stability: same verdict across Mon–Fri; CAGR spread ≤ 3 pts.
export function runRebalanceDays(baseInputs, runMetrics) {
  const rows = [1, 2, 3, 4, 5].map((wd) => ({ weekday: wd, ...sel(runMetrics(baseInputs, { rebalanceWeekday: wd })) }));
  const cagrs = rows.map((r) => r.cagr).filter((x) => x != null);
  const cagrSpread = cagrs.length ? Math.max(...cagrs) - Math.min(...cagrs) : null;
  return { rows, cagrSpread, sameVerdict: cagrSpread != null && cagrSpread <= 3 };
}
function sel(m) { return { cagr: m.cagr, maxDrawdown: m.maxDrawdown }; }
```

`scripts/backtest/robustness/concentration.mjs`:
```js
// B — edge concentration: strip the best k% of MONTHS and recompute a return
// proxy (compounded monthly returns). A real edge survives losing its best months.
export function runConcentration(equityCurve) {
  const monthly = monthlyReturns(equityCurve);
  const proxy = (rs) => (rs.reduce((acc, r) => acc * (1 + r), 1) - 1) * 100;
  const sorted = [...monthly].sort((a, b) => b - a); // best first
  const strip = (pct) => proxy(sorted.slice(Math.ceil((pct / 100) * sorted.length)));
  return { full: proxy(monthly), strip5: strip(5), strip10: strip(10), strip20: strip(20) };
}
function monthlyReturns(curve) {
  const byMonth = new Map();
  for (const p of curve) { const m = String(p.date).slice(0, 7); byMonth.set(m, p.nav); } // last nav of each month
  const navs = [...byMonth.values()];
  const rs = [];
  for (let i = 1; i < navs.length; i++) rs.push(navs[i] / navs[i - 1] - 1);
  return rs;
}
```

`scripts/backtest/robustness/cost.mjs`:
```js
// E — cost sensitivity: re-run at 2× slippage; the edge must survive.
export function runCostSensitivity(baseInputs, runMetrics) {
  const base = runMetrics(baseInputs, {});
  const cfg2 = { ...baseInputs.config, slippageBps: baseInputs.config.slippageBps * 2 };
  const double = runMetrics({ ...baseInputs, config: cfg2 }, {});
  return { base: { cagr: base.cagr, maxDrawdown: base.maxDrawdown }, double: { cagr: double.cagr, maxDrawdown: double.maxDrawdown } };
}
```

`scripts/backtest/robustness/sweep.mjs`:
```js
// J — trend-MA sweep (stability check, NOT optimization). Trade the locked 100.
const VALUES = [80, 90, 100, 110, 120, 150];
export function runTrendMaSweep(baseInputs, runMetrics) {
  return VALUES.map((trendMa) => {
    const m = runMetrics({ ...baseInputs, config: { ...baseInputs.config, trendMa } }, {});
    return { trendMa, cagr: m.cagr, maxDrawdown: m.maxDrawdown };
  });
}
```

`scripts/backtest/robustness/baseline.mjs`:
```js
// A — dumb-baseline: does slope×R² beat plain return / plain slope? If it wins by
// < 1.5 pts CAGR, the report flags "switch to the simpler metric".
import { return126Ranker, return189Ranker, slopeRanker, momentumRanker } from "../rankers.mjs";
const RANKERS = [
  ["return126", return126Ranker], ["return189", return189Ranker],
  ["slopeOnly", slopeRanker], ["slopeR2", momentumRanker],
];
export function runBaselines(baseInputs, runMetrics) {
  return RANKERS.map(([metric, rankFn]) => ({ metric, cagr: runMetrics(baseInputs, { rankFn }).cagr }));
}
```

Add the baseline rankers to `scripts/backtest/rankers.mjs`:
```js
// --- test-A baseline rankers (scaffolding; NOT the production ranker) ---
function rankByScore(items, scoreFn, config) {
  const scored = items.map((it) => ({ ticker: it.ticker, score: scoreFn(it.closes) }))
    .filter((s) => Number.isFinite(s.score))
    .sort((a, b) => b.score - a.score || a.ticker.localeCompare(b.ticker));
  return applyRankZones(scored, config);
}
const retOver = (closes, lookback) => {
  if (closes.length <= lookback) return NaN;
  const a = closes[closes.length - 1 - lookback], b = closes[closes.length - 1];
  return a > 0 ? b / a - 1 : NaN;
};
// Plain slope of log-price over momentumLookback (no R²), via simple least squares.
function logSlope(closes, lookback) {
  if (closes.length <= lookback) return NaN;
  const y = closes.slice(-lookback).map((c) => Math.log(c));
  const n = y.length, xs = Array.from({ length: n }, (_, i) => i);
  const mx = (n - 1) / 2, my = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (y[i] - my); den += (xs[i] - mx) ** 2; }
  return den > 0 ? num / den : NaN;
}
export const return126Ranker = (items, config) => rankByScore(items, (c) => retOver(c, 126), config);
export const return189Ranker = (items, config) => rankByScore(items, (c) => retOver(c, 189), config);
export const slopeRanker = (items, config) => rankByScore(items, (c) => logSlope(c, config.momentumLookback), config);
```

- [ ] **Step 4: Run → PASS.** `node --test tests/backtest-robustness.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add scripts/backtest/robustness tests/backtest-robustness.test.mjs scripts/backtest/rankers.mjs
git commit -m "feat(backtest): robustness battery — ablation/baseline/rebalance/cost/concentration/sweep

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Runner — wire it all, fetch via Tiingo, write artifacts

**Files:**
- Create: `scripts/backtest/run.mjs`
- Modify: `package.json` (add `"backtest": "node scripts/backtest/run.mjs"`)

**Interfaces:** Consumes everything above. Thin I/O shell (like `executePlan` in the live code) — minimal logic, so no unit test; verified by an end-to-end smoke run against the cache.

- [ ] **Step 1: Write `scripts/backtest/run.mjs`**

```js
// run.mjs — CLI entrypoint. Wires data → engine → metrics → benchmark →
// robustness → report, writes docs/backtest/Scorecard-run-<ts>.{md,json}.
// Thin shell: all logic lives in the pure modules. Reuses getActiveConfig +
// getDailyBars from the live stack. Nothing here is live — read-only + local files.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getActiveConfig } from "../../lambdas/shared/config.mjs";
import { getDailyBars } from "../../lambdas/shared/marketdata.mjs";
import { simulate } from "./engine.mjs";
import { computeMetrics } from "./metrics.mjs";
import { spyBuyHold } from "./benchmark.mjs";
import { buildReport } from "./report.mjs";
import { loadUniverse, buildCalendar, coverageByWindow, detectStaleAndSplits } from "./data.mjs";
import { runAblation } from "./robustness/ablation.mjs";
import { runBaselines } from "./robustness/baseline.mjs";
import { runRebalanceDays } from "./robustness/rebalance-day.mjs";
import { runCostSensitivity } from "./robustness/cost.mjs";
import { runConcentration } from "./robustness/concentration.mjs";
import { runTrendMaSweep } from "./robustness/sweep.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dir, ".cache");
const refresh = process.argv.includes("--refresh");
const startDate = "2010-01-01"; // deepest history; coverage block quantifies who actually existed

const config = await getActiveConfig();
const gitSha = execSync("git rev-parse --short HEAD").toString().trim();
const nowIso = new Date().toISOString();

const watchlist = JSON.parse(await readFile(new URL("../../seed/watchlist.json", import.meta.url)));
const tickers = (Array.isArray(watchlist) ? watchlist : watchlist.tickers ?? []).map((w) => (typeof w === "string" ? w : w.ticker));

const fetchBars = async (t) => { await new Promise((r) => setTimeout(r, 250)); return getDailyBars(t, { startDate }); };
if (refresh) console.log("--refresh: ignoring cache");
const spyRaw = (await loadUniverse({ tickers: ["SPY"], startDate, dir: refresh ? join(CACHE_DIR, "x") : CACHE_DIR, fetchBars, now: nowIso }))[0];
const universe = await loadUniverse({ tickers, startDate, dir: CACHE_DIR, fetchBars, now: nowIso, throttleMs: 250 });

const calendar = buildCalendar(spyRaw.bars, startDate, spyRaw.bars[spyRaw.bars.length - 1].date);
const inputs = { universe, spyBars: spyRaw.bars, calendar, config };

// runMetrics closure the robustness modules consume.
const runMetrics = (inp, opts) => {
  const { equityCurve, ledger } = simulate({ ...inputs, ...inp }, opts);
  return computeMetrics(equityCurve, ledger, { startEquity: config.accountSize });
};

// Primary run.
const { equityCurve, ledger } = simulate(inputs, {});
const strategy = computeMetrics(equityCurve, ledger, { startEquity: config.accountSize });
const spyRun = spyBuyHold(spyRaw.bars, calendar, config.accountSize, config);
const spy = computeMetrics(spyRun.equityCurve, spyRun.ledger, { startEquity: config.accountSize });

// Robustness.
const tests = {
  ablation: runAblation(inputs, runMetrics),
  baseline: runBaselines(inputs, runMetrics),
  rebalanceDay: runRebalanceDays(inputs, runMetrics),
  cost: runCostSensitivity(inputs, runMetrics),
  concentration: runConcentration(equityCurve),
  sweep: runTrendMaSweep(inputs, runMetrics),
};

// Coverage + warnings.
const windows = [
  { window: "full period", start: calendar[0], end: calendar[calendar.length - 1] },
  { window: "2008-2009", start: "2008-01-01", end: "2009-12-31" },
  { window: "2020 crash", start: "2020-02-01", end: "2020-04-30" },
  { window: "2022", start: "2022-01-01", end: "2022-12-31" },
];
const coverage = coverageByWindow(universe, windows);
const warnings = detectStaleAndSplits(universe, { now: nowIso, maxAgeDays: 7 });

const { markdown, json } = buildReport({
  strategyVersion: (await import("../../lambdas/shared/version.mjs")).STRATEGY_VERSION,
  gitSha, runTimestamp: nowIso, period: { start: calendar[0], end: calendar[calendar.length - 1] },
  universeSize: universe.length, params: config, strategy, spy, tests, coverage, warnings,
});

const outDir = new URL("../../docs/backtest/", import.meta.url);
await mkdir(outDir, { recursive: true });
const stamp = nowIso.replace(/[:.]/g, "-");
await writeFile(new URL(`Scorecard-run-${stamp}.md`, outDir), markdown);
await writeFile(new URL(`Scorecard-run-${stamp}.json`, outDir), JSON.stringify(json, null, 2));
console.log(`\nPRELIMINARY (survivorship-biased). Strategy CAGR ${strategy.cagr}% vs SPY ${spy.cagr}%. Report → docs/backtest/Scorecard-run-${stamp}.md`);
```

- [ ] **Step 2: Add the npm script** — in `package.json` `scripts`, add:

```json
"backtest": "node scripts/backtest/run.mjs"
```

- [ ] **Step 3: Smoke-run end-to-end** (real Tiingo via the premium key; first run populates the cache — slow, ~minutes)

Run: `npm run backtest`
Expected: prints the PRELIMINARY one-liner; writes `docs/backtest/Scorecard-run-*.md` + `.json`. Open the markdown and confirm: PRELIMINARY banner present, §1 table populated for strategy AND SPY, coverage block shows per-window `N/199` (e.g. 2008-2009 far below 199), rf=0 note present.

- [ ] **Step 4: Sanity-check the artifact, then commit** (commit the runner + a representative report; ensure `.cache/` is gitignored and NOT staged)

```bash
git add scripts/backtest/run.mjs package.json docs/backtest/Scorecard-run-*.md docs/backtest/Scorecard-run-*.json
git status   # confirm no .cache/ files staged, no secrets
git commit -m "feat(backtest): runner — wire pipeline, write Scorecard report (PRELIMINARY)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (each spec section → task):**
- §1 goal/scope → Tasks 1–8. Deferred D/F/H/I explicitly out (sibling-module ready). ✓
- §2 module layout → File Structure + Tasks. ✓
- §3 daily/weekly sequencing → Task 1 engine loop (fills→stopwalk→MTM→review). ✓
- §4 next-open fills + one cost model + reconciliation → Task 1 (fills) + Task 4 (reconciliation test). ✓
- §5 governor drawdowns (5/21/all-time) → Task 1 `ddOverWindow` + review wiring. ✓
- §6 §1 metrics + SPY + rf=0 → Tasks 2, 3; rf=0 surfaced in Task 5 report. ✓
- §7 robustness harness (A/B/C/E/G/J) → Task 7. ✓
- §8 bar cache + stale/split warnings → Task 6. ✓
- §9 report (md+json, SHA/params/coverage/PRELIMINARY) → Task 5 + Task 8 wiring. ✓
- §10 tests → each task is TDD; load-bearing tests (cost reconciliation, next-open fill, governor) in Tasks 1, 4. ✓
- §11 honesty → PRELIMINARY banner (Task 5), coverage quantified (Tasks 6, 8), nothing live. ✓

**Placeholder scan:** Task 1 Step 10 governor test references a `manufactureDrawdown()` fixture — Step 11 instructs to make it concrete (preferred) or `test.skip` with a TODO; the executor must write the concrete fixture (a 2-name series where one position craters >8% over 5 sessions and a newly-eligible name is then NOT bought). All other steps contain full code.

**Type consistency:** `simulate` returns `{ equityCurve, ledger, finalPositions }`; consumed consistently. `computeMetrics(equityCurve, ledger, { startEquity })` — same signature in Tasks 2, 3, 7, 8. `buildReport(ctx)` ctx keys match Task 8's call. Ranker shape (`{ticker, rank, rankPct, inEntryZone, inExitZone}`) consistent between `applyRankZones`, `rankByMomentum`, and the baseline rankers. ✓

**Known deviation from spec (flag to reviewer):** the engine reuses `isEligible`/`rankByMomentum`/`evaluateExits`/`sizePosition` + `atrWilder`/`sma` directly rather than the `buildMomentumData` aggregator (spec §2 wording), because `buildMomentumData`'s freshness gate is wall-clock-coupled and would mark every historical slice stale. Decision functions and indicator primitives are still reused verbatim; only the live-only freshness wrapper is bypassed. This is the right call and is documented in the engine header.
