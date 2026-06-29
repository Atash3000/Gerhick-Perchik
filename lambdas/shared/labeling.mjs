// labeling.mjs — the pure, deterministic outcome labeler (Phase 5).
//
// MATH DECIDES here too: given an open signal and the daily bars after entry, this
// computes the realized outcome with no I/O and no randomness. The labeler Lambda
// does the I/O; this function does the accounting.
//
// Rules (see CLAUDE.md "Outcome labeling"):
//   - First-touch, path-dependent. Walk EVERY trading day from entry forward.
//       day_low  <= stop   -> STOP    (if both hit the same day, STOP wins)
//       day_high >= target -> TARGET
//       else after timeout -> TIMEOUT (exit = that day's close)
//   - Pessimistic fills: a stop can gap through, so the stop exit is the WORSE of
//     the stop and that day's open. A target fill is the target itself (we do not
//     credit a gap-up above it).
//   - After costs: profitPct deducts feeBps + slippageBps PER SIDE (two sides).
//     A cost-free backtest lies upward.

export const OUTCOME = { STOP: "STOP", TARGET: "TARGET", TIMEOUT: "TIMEOUT" };

// Split adjustment beyond this magnitude is treated as a split (vs a dividend).
const SPLIT_THRESHOLD = 0.02; // |scaleFactor - 1| > 2%

// Label one signal. `bars` = ascending daily ADJUSTED bars
// [{date, open, high, low, close}]. Only bars strictly AFTER entryDate are walked
// (entry is the close of entryDate).
//
// SPLIT-SAFE RE-ANCHORING: Tiingo adjusts the whole series retroactively, so a
// split after the signal opened re-scales the entry-era bars while the stored
// entry/stop/target stay in the scan-time frame. We re-anchor: find the entry
// bar's CURRENT adjusted close (entryAdjNow), compute scaleFactor =
// entryAdjNow / storedEntry, and scale entry/stop/target into the current frame
// before walking. scaleFactor == 1 → identical to the no-split case.
//
// Returns the label object (with audit fields), or null when the signal is NOT
// yet resolved (no touch and fewer than `timeoutTradingDays` bars elapsed).
export function labelSignal(signal, bars, config) {
  const { entry, stop, target, entryDate } = signal;
  const { feeBps, slippageBps, timeoutTradingDays } = config;

  // Re-anchor to the entry bar in the current adjusted frame.
  const entryBar = bars.find((b) => b.date === entryDate);
  const entryBarMissing = !entryBar || !(entryBar.close > 0) || !(entry > 0);
  const entryAdjNow = entryBarMissing ? null : entryBar.close;
  const scaleFactor = entryBarMissing ? 1 : entryAdjNow / entry;

  const entryAdj = entry * scaleFactor;
  const stopAdj = stop * scaleFactor;
  // A non-finite target means "no fixed target" (the momentum strategy: exits are
  // stop/trail/rank/trend, never a profit cap). Make that explicit so target checks
  // are skipped entirely — robust to undefined/null/NaN, not reliant on NaN-compare
  // accident (a `null` target would otherwise scale to 0 and fire a phantom TARGET).
  const hasTarget = Number.isFinite(target);
  const targetAdj = hasTarget ? target * scaleFactor : null;

  const audit = {
    scaleFactor: round(scaleFactor, 6),
    splitAdjusted: Math.abs(scaleFactor - 1) > SPLIT_THRESHOLD,
    entryAdjAtLabel: entryAdjNow == null ? null : round(entryAdjNow, 4),
    entryBarMissing,
  };

  const forward = bars.filter((b) => b.date > entryDate);

  let outcome = null;
  let exitPrice = null;
  let exitDate = null;
  let hitStopFirst = false;
  let hitTargetFirst = false;
  let daysHeld = 0;
  // Excursion tracking: how far price ranged in our favor / against us over the
  // bars actually held, INCLUSIVE of the exit bar (updated before the break checks).
  let maxHigh = -Infinity;
  let minLow = Infinity;

  for (let i = 0; i < forward.length; i++) {
    const bar = forward[i];
    daysHeld = i + 1;
    if (bar.high > maxHigh) maxHigh = bar.high;
    if (bar.low < minLow) minLow = bar.low;

    // Gap-OPEN above target: a resting target sell fills at the open, before any
    // intraday move could reach the stop — so the target is hit first even if the
    // same bar later trades down through the stop. Checked before the stop rule.
    // Exit at target (we still don't credit the favorable gap above it).
    if (hasTarget && bar.open >= targetAdj) {
      outcome = OUTCOME.TARGET;
      hitTargetFirst = true;
      exitPrice = targetAdj;
      exitDate = bar.date;
      break;
    }

    // STOP is checked before TARGET (intraday): if both trade through on one day
    // WITHOUT a gap-open past either, assume the stop hit first (pessimistic).
    if (bar.low <= stopAdj) {
      outcome = OUTCOME.STOP;
      hitStopFirst = true;
      exitPrice = Math.min(stopAdj, bar.open); // gap-through → worse of stop vs open
      exitDate = bar.date;
      break;
    }
    if (hasTarget && bar.high >= targetAdj) {
      outcome = OUTCOME.TARGET;
      hitTargetFirst = true;
      exitPrice = targetAdj; // do not credit a gap above target
      exitDate = bar.date;
      break;
    }
    if (daysHeld >= timeoutTradingDays) {
      outcome = OUTCOME.TIMEOUT;
      exitPrice = bar.close; // exit at the last close in the window
      exitDate = bar.date;
      break;
    }
  }

  if (!outcome) return null; // unresolved; not enough days have passed yet

  // After-cost return, in percent. Anchored to entryAdj so it is split-invariant
  // (a ratio). Costs apply on both entry and exit sides.
  const grossPct = (exitPrice / entryAdj - 1) * 100;
  const costPct = (2 * (feeBps + slippageBps)) / 100; // bps→% : /100; two sides : ×2
  const profitPct = round(grossPct - costPct, 4);

  // Maximum favorable / adverse excursion, in percent from entry (split-invariant
  // ratios, like profitPct). MFE = best high reached; MAE = worst low reached.
  // Gross (no costs) — these measure price travel, not realized P&L.
  const mfePct = round((maxHigh / entryAdj - 1) * 100, 2);
  const maePct = round((minLow / entryAdj - 1) * 100, 2);

  return {
    outcome,
    hitStopFirst,
    hitTargetFirst,
    exitPrice: round(exitPrice, 4), // in the current adjusted frame
    exitDate,
    daysHeld,
    profitPct,
    mfePct, // max favorable excursion %: highest high over the hold
    maePct, // max adverse excursion %: lowest low over the hold
    mfePrice: round(maxHigh, 4),
    maePrice: round(minLow, 4),
    ...audit,
  };
}

// SPY buy-and-hold benchmark over a closed trade's window (B6). Pure. Uses
// ADJUSTED SPY bars (close = adjClose) consistently. spyEntry/spyExit are the
// adjusted SPY closes on entryDate/exitDate (or the last bar on/before each).
// Returns nulls when SPY data is unavailable. The caller computes
// alphaVsSpyPct = profitPct(after-cost) - spyReturnPct(gross).
export function spyBenchmark(spyBars, entryDate, exitDate) {
  const empty = { spyEntry: null, spyExit: null, spyReturnPct: null };
  if (!Array.isArray(spyBars) || spyBars.length === 0) return empty;
  const closeOnOrBefore = (d) => {
    let v = null;
    for (const b of spyBars) {
      if (b.date <= d) v = b.close;
      else break;
    }
    return v;
  };
  const spyEntry = closeOnOrBefore(entryDate);
  const spyExit = closeOnOrBefore(exitDate);
  if (!(spyEntry > 0) || !(spyExit > 0)) {
    return { spyEntry: spyEntry == null ? null : round(spyEntry, 4), spyExit: spyExit == null ? null : round(spyExit, 4), spyReturnPct: null };
  }
  return {
    spyEntry: round(spyEntry, 4),
    spyExit: round(spyExit, 4),
    spyReturnPct: round((spyExit / spyEntry - 1) * 100, 4),
  };
}

function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
