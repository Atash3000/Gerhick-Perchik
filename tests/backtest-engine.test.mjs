// tests/backtest-engine.test.mjs — TDD suite for backtest/rankers.mjs and
// backtest/engine.mjs (build-order step 5, Task 1).
//
// Warmup note: isEligible needs ≥20 bars (DOLLAR_VOL_WINDOW). With
// rebalanceWeekday:1 (Mondays) and sessions starting 2020-01-06, the first
// Monday where the slice has ≥20 bars is cal[20] (the 21st session); fills
// happen at cal[21] open. Tests therefore use sessions(30) minimum and assert
// fills RELATIONALLY (opened.entry == bar.open for that date).

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRankZones } from "../scripts/backtest/rankers.mjs";
import { simulate } from "../scripts/backtest/engine.mjs";

// ─── A: rankers.mjs ──────────────────────────────────────────────────────────

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

// ─── B: engine.mjs ───────────────────────────────────────────────────────────

// Minimal config: tiny windows so a short synthetic series is "eligible".
// DOLLAR_VOL_WINDOW (20) is the binding minimum for isEligible; trendMa:3 and
// gapFilterWindow:3 are shorter. Limits disabled (weeklyDdLimit:99 etc.).
const ECFG = {
  regimeMa: 3, trendMa: 3, minPrice: 1, minDollarVol: 0,
  gapFilterPct: 100, gapFilterWindow: 3, momentumLookback: 3,
  entryRankPct: 100, exitRankPct: 100, atrPeriod: 3, kStop: 2.5,
  riskPctPerTrade: 0.75, targetPositions: 1, maxPositions: 1, positionCapPct: 100,
  weeklyDdLimit: 99, monthlyDdLimit: 99, maxDdLimit: 99,
  feeBps: 0, slippageBps: 0, timeoutTradingDays: 999, accountSize: 100000,
};

// Helper: build N weekday sessions starting 2020-01-06 (a Monday).
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
  const cal = sessions(30);
  // Rising series: open = close − 0.5 so open ≠ close (fill price is unambiguous).
  const mk = (dates, fn) =>
    dates.map((date, i) => {
      const c = fn(i);
      return { date, open: c - 0.5, high: c + 1, low: c - 1, close: c, volume: 1e6 };
    });
  const name = { ticker: "AAA", bars: mk(cal, (i) => 10 + i) };
  const spy  = mk(cal, (i) => 100 + i);

  const { ledger, equityCurve } = simulate(
    { universe: [name], spyBars: spy, calendar: cal, config: ECFG },
    { rebalanceWeekday: 1 },
  );

  // First review with ≥20 prior bars is cal[20] (Monday); buy fills at cal[21].
  const opened = ledger.find((t) => t.ticker === "AAA");
  assert.ok(opened, "AAA should have at least one trade in the ledger");
  const entryBar = name.bars.find((b) => b.date === opened.entryDate);
  assert.ok(entryBar, "entry bar must exist in name.bars");
  // Relational assertion: proves next-open fill without hard-coding the price.
  assert.equal(opened.entry, entryBar.open);
  assert.equal(equityCurve.length, cal.length);
});

test("daily stop fills intraday at min(stop, open), reason hard_stop near entry", () => {
  const cal = sessions(30);
  // Tiny range (±0.01) → ATR(3) ≈ 0.02 → stop ≈ entry − 0.05 (just below entry).
  // Tiny upward drift so close > trendMa(3) → trend-eligible.
  // open = c − 0.01 so the fill at next open is slightly BELOW the signal close,
  // keeping cost within available cash when positionCapPct:100.
  // Crash at cal[22] (one day after fill at cal[21]): open=9.9, low=5.
  // stop(≈entry−0.05) > crash-open(9.9) → fill = min(stop, 9.9) = 9.9.
  const DRIFT = 0.001;
  const bars = cal.map((date, i) => {
    if (i === 22) return { date, open: 9.9, high: 10, low: 5, close: 6, volume: 1e6 };
    const c = 10 + (i + 1) * DRIFT;
    return { date, open: c - 0.01, high: c + 0.01, low: c - 0.01, close: c, volume: 1e6 };
  });
  const spy = cal.map((date, i) => ({
    date, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1e6,
  }));

  const { ledger } = simulate(
    { universe: [{ ticker: "BBB", bars }], spyBars: spy, calendar: cal, config: ECFG },
    { rebalanceWeekday: 1 },
  );

  // First trade: entered cal[21], stop triggered cal[22].
  const t = ledger.find((x) => x.ticker === "BBB");
  assert.ok(t, "BBB should have a trade");
  assert.equal(t.exitDate, cal[22]);
  assert.equal(t.exitReason, "hard_stop");
  // stop ≈ entry−0.05 (> crash open 9.9) → fill = min(stop, 9.9) = 9.9.
  assert.equal(t.exit, 9.9);
  assert.ok(t.exit < t.entry, "exit below entry confirms a loss on a hard_stop near entry");
});

test("governor blocks new buys after a weekly drawdown >8%", () => {
  const cal = sessions(30);
  const DRIFT = 0.001;

  // AAA: 30 bars from cal[0]. Opens at cal[21]; crashes at cal[22] (stop hit, NAV −30%).
  // open = c − 0.01 (pre-crash) so fill cost stays within cash when positionCapPct:100.
  const aaaBars = cal.map((date, i) => {
    if (i === 22) return { date, open: 7, high: 8, low: 4, close: 5, volume: 1e6 };
    if (i  > 22) {
      const c = 5 + (i - 22) * DRIFT;
      return { date, open: c - 0.01, high: c + 0.01, low: c - 0.01, close: c, volume: 1e6 };
    }
    const c = 10 + (i + 1) * DRIFT;
    return { date, open: c - 0.01, high: c + 0.01, low: c - 0.01, close: c, volume: 1e6 };
  });

  // BBB: starts at cal[5] → only 16 bars at cal[20] (need 20 → ineligible), but
  // 21 bars at cal[25]. At cal[25] review the governor fires (weekly DD ≈ 30% > 8%)
  // and blocks the buy. sessions(30) ends before the next review (cal[30] is outside
  // the window), so BBB never gets a second chance.
  const bbbBars = cal.slice(5).map((date, i) => {
    const c = 10 + (i + 1) * DRIFT;
    return { date, open: c, high: c + 0.01, low: c - 0.01, close: c, volume: 1e6 };
  });

  const spy = cal.map((date, i) => ({
    date, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1e6,
  }));

  const GOV_CFG = { ...ECFG, weeklyDdLimit: 8 };
  const { ledger } = simulate(
    {
      universe: [
        { ticker: "AAA", bars: aaaBars },
        { ticker: "BBB", bars: bbbBars },
      ],
      spyBars: spy,
      calendar: cal,
      config: GOV_CFG,
    },
    { rebalanceWeekday: 1 },
  );

  // AAA was bought and hard-stopped at cal[22].
  const aaaTrade = ledger.find((t) => t.ticker === "AAA");
  assert.ok(aaaTrade, "AAA should have a trade (bought then stopped)");
  assert.equal(aaaTrade.exitReason, "hard_stop");

  // BBB must NOT appear in the ledger — the weekly governor blocked its buy at cal[25].
  const bbbTrade = ledger.find((t) => t.ticker === "BBB");
  assert.equal(bbbTrade, undefined, "BBB should NOT be bought — weekly DD governor blocked it");
});
