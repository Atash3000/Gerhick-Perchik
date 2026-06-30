// engine.mjs — portfolio NAV simulator (gp-momentum-1.0.0). PURE: bars in,
// equity curve + trade ledger out. Imports the live decision primitives and
// indicator helpers; re-implements no exit/cost/ranking math.
//
// Per-session order of operations (spec §3):
//   1. Execute queued orders at open (decision-sells then buys).
//      • A decision-sell with no bar for today is RE-QUEUED to the next session
//        (it waits for the next tradable open). Buys with no bar are dropped
//        (re-decided at next weekly review).
//   2. Daily stop-walk (every session): if bar.low ≤ pos.stop → exit intraday.
//   3. Mark-to-market at close → append to equityCurve.
//   4. If review day: run regime/eligibility/rank → advance trails → queue rank/
//      trend exits → run governor + constructBook + sizing → queue buys.
// End of run: force-close all open positions at last close; overwrite final NAV.

import { isEligible, sizePosition, evaluateExits, riskGovernor, constructBook }
  from "../../lambdas/shared/portfolio.mjs";
import { atrWilder, sma } from "../../lambdas/shared/marketdata.mjs";
import { afterCostProfitPct } from "../../lambdas/shared/labeling.mjs";
import { momentumRanker } from "./rankers.mjs";

const round      = (n, dp = 4) => (Number.isFinite(n) ? Math.round(n * 10 ** dp) / 10 ** dp : n);
const weekdayOf  = (isoDate)   => new Date(`${isoDate}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat

// Drawdown magnitude (%) off the daily NAV curve, over the last `win` sessions
// (null → all-time). Returns a positive magnitude.
function ddOverWindow(curve, win) {
  if (curve.length === 0) return 0;
  const slice = win == null ? curve : curve.slice(-win);
  const peak  = Math.max(...slice.map((p) => p.nav));
  const cur   = curve[curve.length - 1].nav;
  return peak > 0 ? ((peak - cur) / peak) * 100 : 0;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function simulate({ universe, spyBars, calendar, config }, opts = {}) {
  const {
    rankFn             = momentumRanker,
    ablation           = {},
    rebalanceWeekday   = 5,
    startEquity        = config.accountSize ?? 100_000,
  } = opts;

  const COST = ((config.feeBps ?? 0) + (config.slippageBps ?? 0)) / 1e4;

  // Per-name lookup helpers.
  const byTicker = new Map(universe.map((u) => [u.ticker, u]));
  const idxOf    = new Map(
    universe.map((u) => [u.ticker, new Map(u.bars.map((b, i) => [b.date, i]))])
  );
  const spyCloseAsc = spyBars.map((b) => b.close);
  const spyIdx      = new Map(spyBars.map((b, i) => [b.date, i]));

  // Slice a name's bars up to and including `date` (null if name has no bar on/before date).
  const sliceTo = (ticker, date) => {
    const i = idxOf.get(ticker)?.get(date);
    if (i == null) return null;
    return byTicker.get(ticker).bars.slice(0, i + 1);
  };
  const barOn = (ticker, date) => {
    const i = idxOf.get(ticker)?.get(date);
    return i == null ? null : byTicker.get(ticker).bars[i];
  };

  let cash          = startEquity;
  const positions   = [];      // {ticker, shares, entry, entryDate, stop, peakClose, entryAtr, lastClose}
  const equityCurve = [];
  const ledger      = [];
  let pending       = { buys: [], sells: [] };

  const closeTrade = (pos, exitPrice, exitDate, exitReason) => {
    const profitPct = afterCostProfitPct(pos.entry, exitPrice, config);
    const costPaid  = round(pos.shares * (pos.entry + exitPrice) * COST, 2);
    cash += pos.shares * exitPrice * (1 - COST);
    const ei = calendar.indexOf(pos.entryDate);
    const xi = calendar.indexOf(exitDate);
    ledger.push({
      ticker: pos.ticker, entryDate: pos.entryDate, entry: round(pos.entry),
      shares: pos.shares, exitDate, exit: round(exitPrice), exitReason,
      profitPct, daysHeld: xi - ei, costPaid,
    });
  };

  for (const date of calendar) {
    // ── 1. Execute queued orders at TODAY's open (decision-sells then buys) ──

    const nextSells = []; // decision-sells that could not fill today (re-queued)

    for (const sell of pending.sells) {
      const pi  = positions.findIndex((p) => p.ticker === sell.ticker);
      if (pi < 0) continue; // position already gone
      const bar = barOn(sell.ticker, date);
      if (!bar) {
        // No tradeable bar today — re-queue this decision-sell for the next session.
        // (The position keeps its stop in the meantime; the end-of-run is the backstop.)
        nextSells.push(sell);
        continue;
      }
      closeTrade(positions[pi], bar.open, date, sell.reason);
      positions.splice(pi, 1);
    }

    for (const buy of pending.buys) {
      const bar = barOn(buy.ticker, date);
      if (!bar) continue; // no bar → drop; re-decided at next weekly review

      const entry = bar.open;
      const cost  = buy.shares * entry * (1 + COST);
      // No-leverage rule: skip this buy if it would exceed available cash.
      if (cost > cash) continue;
      cash -= cost;
      positions.push({
        ticker: buy.ticker, shares: buy.shares, entry, entryDate: date,
        stop:       round(entry - config.kStop * buy.entryAtr),
        peakClose:  entry,
        entryAtr:   buy.entryAtr,
        lastClose:  entry,  // tracks the most recent known close for missing-bar MTM
      });
    }

    pending = { buys: [], sells: nextSells };

    // ── 2. Daily stop-walk (every session) ────────────────────────────────────

    for (let pi = positions.length - 1; pi >= 0; pi--) {
      const pos = positions[pi];
      const bar = barOn(pos.ticker, date);
      if (bar) pos.lastClose = bar.close; // update last known close
      if (!bar) continue;                 // no bar → stop cannot trigger; skip

      if (bar.low <= pos.stop) {
        // Pessimistic fill: if stop gaps through, exit at the worse of stop vs open.
        const fill   = Math.min(pos.stop, bar.open);
        const reason = pos.stop <= pos.entry ? "hard_stop" : "trailing_stop";
        closeTrade(pos, fill, date, reason);
        positions.splice(pi, 1);
      }
    }

    // ── 3. Mark-to-market at TODAY's close ────────────────────────────────────

    let invested = 0;
    for (const pos of positions) {
      const bar = barOn(pos.ticker, date);
      // Use last known close if today's bar is absent (halted / partial calendar).
      const c = bar ? bar.close : pos.lastClose;
      invested += pos.shares * c;
    }
    equityCurve.push({
      date,
      nav:      round(cash + invested, 2),
      invested: round(invested, 2),
      cash:     round(cash, 2),
    });

    // ── 4. Weekly review (only on the rebalance weekday) ──────────────────────

    if (weekdayOf(date) !== rebalanceWeekday) continue;
    const equityNow = cash + invested;

    // ── 4.0 Regime gate ──────────────────────────────────────────────────────

    let regimeOn = true;
    if (!ablation.noRegime) {
      const si = spyIdx.get(date);
      if (si == null || si + 1 < config.regimeMa) {
        regimeOn = false;
      } else {
        const spySlice = spyCloseAsc.slice(0, si + 1);
        const ma       = sma(spySlice, config.regimeMa);
        regimeOn = ma != null && spySlice[spySlice.length - 1] > ma;
      }
    }

    // ── 4.1 Eligibility + ranking (point-in-time) ────────────────────────────

    const eligItems  = [];
    const sliceCache = new Map();

    for (const u of universe) {
      const slice = sliceTo(u.ticker, date);
      if (!slice) continue;
      sliceCache.set(u.ticker, slice);

      // noTrend ablation: skip the trend sub-check, keep the other three.
      // (Setting trendMa=1 is wrong: sma(closes,1)==close → close>close is always
      // false, which BLOCKS rather than removes the trend gate.)
      if (ablation.noTrend) {
        const e = isEligible(slice, config);
        const eligible = !!(e.checks && e.checks.price && e.checks.dollarVol && e.checks.noBigMove);
        if (eligible) eligItems.push({ ticker: u.ticker, closes: slice.map((b) => b.close) });
      } else {
        const e = isEligible(slice, config);
        if (e.eligible) eligItems.push({ ticker: u.ticker, closes: slice.map((b) => b.close) });
      }
    }

    const ranked   = rankFn(eligItems, config);
    const rankByT  = new Map(ranked.map((r) => [r.ticker, r]));

    // ── 4.2 Exits BEFORE fills (rank / trend); stop handled by the daily walk ─

    const exiting = new Set();
    for (const pos of positions) {
      const slice = sliceCache.get(pos.ticker) ?? sliceTo(pos.ticker, date);
      if (!slice) continue;
      const bar      = slice[slice.length - 1];
      const atr      = atrWilder(slice, config.atrPeriod);
      if (atr == null) continue; // not enough history for ATR — skip this position
      const trendSma = ablation.noTrend ? null : sma(slice.map((b) => b.close), config.trendMa);
      // A name that fell out of the eligible set is in the exit zone by default.
      const inExitZone = rankByT.get(pos.ticker)?.inExitZone ?? true;

      const res = evaluateExits(
        { entry: pos.entry, stop: pos.stop, peakClose: pos.peakClose },
        bar, { atr, trendSma, inExitZone }, config,
      );
      // Advance the chandelier trail regardless (ratchets up, never down).
      pos.stop = res.stop; pos.peakClose = res.peakClose;

      if (res.exit && (res.reason === "RANK" || res.reason === "TREND")) {
        pending.sells.push({
          ticker: pos.ticker,
          reason: res.reason === "RANK" ? "rank_exit" : "trend_exit",
        });
        exiting.add(pos.ticker);
      }
    }

    // ── 4.3 Governor + portfolio construction → queue buys ───────────────────

    if (!regimeOn) continue;

    const drawdowns = ablation.noGovernor
      ? { weeklyPct: 0, monthlyPct: 0, fromPeakPct: 0 }
      : {
          weeklyPct:   ddOverWindow(equityCurve, 5),
          monthlyPct:  ddOverWindow(equityCurve, 21),
          fromPeakPct: ddOverWindow(equityCurve, null),
        };
    const governor = riskGovernor(drawdowns, config);

    // Tickers currently held and NOT queued for exit (they occupy a slot).
    const heldNow = new Set(
      positions.map((p) => p.ticker).filter((t) => !exiting.has(t))
    );
    const { candidates, slots } = constructBook(ranked, heldNow, governor, config);

    let filled = 0;
    for (const r of candidates) {
      if (filled >= slots) break;
      const slice = sliceCache.get(r.ticker);
      if (!slice) continue;
      const atr         = atrWilder(slice, config.atrPeriod);
      const signalClose = slice[slice.length - 1].close;

      let shares;
      if (ablation.noAtrSizing) {
        // Equal-weight: each position gets an equal $ slice, capped at positionCapPct.
        const target = equityNow / Math.min(config.targetPositions, config.maxPositions);
        shares = Math.floor(target / signalClose);
        if (shares <= 0) continue;
      } else {
        const sized = sizePosition(signalClose, atr, equityNow, config);
        if (!sized) continue; // unsizable (e.g. ATR=0) → next candidate backfills the slot
        shares = sized.shares;
      }

      pending.buys.push({ ticker: r.ticker, shares, entryAtr: atr ?? 0 });
      filled += 1;
    }
  }

  // ── End of run: force-close all open positions at the last close ─────────────

  const lastDate = calendar[calendar.length - 1];
  for (const pos of [...positions]) {
    const bar  = barOn(pos.ticker, lastDate);
    const fill = bar ? bar.close : pos.lastClose;
    closeTrade(pos, fill, lastDate, "end_of_backtest");
    positions.splice(positions.indexOf(pos), 1);
  }

  // Overwrite the final equity-curve point to reflect the realized (post-liquidation)
  // cash balance — so the ledger and the equity curve agree (spec §3).
  if (equityCurve.length > 0) {
    equityCurve[equityCurve.length - 1] = {
      date:     lastDate,
      nav:      round(cash, 2),
      invested: 0,
      cash:     round(cash, 2),
    };
  }

  return {
    equityCurve,
    ledger,
    finalPositions: [], // all positions force-closed at end-of-run
  };
}
