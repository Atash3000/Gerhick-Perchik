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

// Label one signal. `bars` = ascending daily bars [{date, open, high, low, close}]
// (adjusted, same series the entry/stop/target were derived from). Only bars
// strictly AFTER entryDate are walked (entry is the close of entryDate).
//
// Returns the label object, or null when the signal is NOT yet resolved (no touch
// and fewer than `timeoutTradingDays` bars have elapsed) — leave it OPEN and try
// again next run.
export function labelSignal(signal, bars, config) {
  const { entry, stop, target, entryDate } = signal;
  const { feeBps, slippageBps, timeoutTradingDays } = config;

  const forward = bars.filter((b) => b.date > entryDate);

  let outcome = null;
  let exitPrice = null;
  let exitDate = null;
  let hitStopFirst = false;
  let hitTargetFirst = false;
  let daysHeld = 0;

  for (let i = 0; i < forward.length; i++) {
    const bar = forward[i];
    daysHeld = i + 1;

    // STOP is checked before TARGET: if both trade through on one day, assume the
    // stop hit first (the pessimistic assumption).
    if (bar.low <= stop) {
      outcome = OUTCOME.STOP;
      hitStopFirst = true;
      exitPrice = Math.min(stop, bar.open); // gap-through → worse of stop vs open
      exitDate = bar.date;
      break;
    }
    if (bar.high >= target) {
      outcome = OUTCOME.TARGET;
      hitTargetFirst = true;
      exitPrice = target; // do not credit a gap above target
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

  // After-cost return, in percent. Costs apply on both entry and exit sides.
  const grossPct = (exitPrice / entry - 1) * 100;
  const costPct = (2 * (feeBps + slippageBps)) / 100; // bps→% : /100; two sides : ×2
  const profitPct = round(grossPct - costPct, 4);

  return {
    outcome,
    hitStopFirst,
    hitTargetFirst,
    exitPrice: round(exitPrice, 4),
    exitDate,
    daysHeld,
    profitPct,
  };
}

function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
