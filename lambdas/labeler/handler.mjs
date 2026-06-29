// labeler/handler.mjs — walk open signals forward and record their real outcomes
// (Phase 5). Path-dependent, first-touch, pessimistic fills, after costs.
//
// What it does each run:
//   1. Read tunables (gp-config) — feeBps/slippageBps/timeoutTradingDays.
//   2. List OPEN rows in gp-outcomes.
//   3. For each, fetch its daily bars from entry forward (Tiingo) and run the
//      pure labelSignal(). If resolved (STOP/TARGET/TIMEOUT), close the row with
//      the after-cost result; if not yet resolved, leave it OPEN for next time.
//
// The accounting is in shared/labeling.mjs (pure, unit-tested). This handler is
// orchestration only. No alerts.

import { getActiveConfig } from "../shared/config.mjs";
import { getDailyBars, KEY_PATHS } from "../shared/marketdata.mjs";
import { labelSignal, spyBenchmark, momentumStopExitReason } from "../shared/labeling.mjs";
import { createStore } from "../shared/store.mjs";
import { STRATEGY_VERSION } from "../shared/version.mjs";

const round4 = (n) => (typeof n === "number" ? Math.round(n * 1e4) / 1e4 : null);

export async function handler() {
  const startedAt = new Date().toISOString();
  console.log("gp_keypaths", JSON.stringify(KEY_PATHS)); // paths only, never values
  const config = await getActiveConfig(process.env.CONFIG_TABLE);
  const store = createStore();

  // SPY benchmark bars (B6), fetched once per run, adjusted. Best-effort: if this
  // fails, outcomes still close with null benchmark fields rather than not at all.
  // A benchmark fetch failure is NOT a labeling failure — use a non-alarming
  // keyword (`gp_benchmark_failed`, not the `gp_scan_failed` alarm keyword).
  let spyBars = null;
  try {
    spyBars = await getDailyBars("SPY");
  } catch (e) {
    console.warn(`gp_benchmark_failed: SPY benchmark fetch: ${e.message}`);
  }

  const open = await store.listOpenOutcomes();
  const tally = { TARGET: 0, STOP: 0, TIMEOUT: 0, stillOpen: 0, errors: 0 };

  for (const o of open) {
    try {
      // Bars from the entry date forward (adjusted — same series the levels came
      // from). The entry bar itself is excluded inside labelSignal.
      const bars = await getDailyBars(o.ticker, { startDate: o.entryDate });

      const label = labelSignal(
        { entry: o.entry, stop: o.stop, target: o.target, entryDate: o.entryDate },
        bars,
        {
          feeBps: config.feeBps,
          slippageBps: config.slippageBps,
          timeoutTradingDays: config.timeoutTradingDays,
        }
      );

      if (!label) {
        tally.stillOpen += 1; // not resolved and not yet at timeout
        continue;
      }

      // SPY benchmark over the same holding window (B6). alpha = strategy
      // after-cost return minus SPY gross buy-and-hold return over entry→exit.
      const bench = spyBenchmark(spyBars, o.entryDate, label.exitDate);
      const alphaVsSpyPct =
        typeof label.profitPct === "number" && typeof bench.spyReturnPct === "number"
          ? round4(label.profitPct - bench.spyReturnPct)
          : null;

      const res = await store.closeOutcome(o.pk, o.sk, {
        outcome: label.outcome,
        // Schema v2: a labeler STOP touch records hard_stop / trailing_stop so the
        // validation sample carries the granular exit reason (scanner owns rank/trend).
        exitReason: momentumStopExitReason(label.outcome, o.entry, o.stop),
        hitTargetFirst: label.hitTargetFirst,
        hitStopFirst: label.hitStopFirst,
        exitDate: label.exitDate,
        exitPrice: label.exitPrice,
        profitPct: label.profitPct, // after cost
        daysHeld: label.daysHeld,
        // Excursion (stop-tuning): how far price ranged for/against before exit.
        mfePct: label.mfePct,
        maePct: label.maePct,
        mfePrice: label.mfePrice,
        maePrice: label.maePrice,
        // Split re-anchor audit (see labeling.mjs):
        scaleFactor: label.scaleFactor,
        splitAdjusted: label.splitAdjusted,
        entryAdjAtLabel: label.entryAdjAtLabel,
        entryBarMissing: label.entryBarMissing,
        // SPY benchmark (B6):
        spyEntry: bench.spyEntry,
        spyExit: bench.spyExit,
        spyReturnPct: bench.spyReturnPct,
        alphaVsSpyPct,
      });
      if (res.closed) tally[label.outcome] += 1;
      else tally.stillOpen += 1; // lost a race; already closed elsewhere
    } catch (err) {
      tally.errors += 1;
      // gp_scan_failed is the project-wide ops keyword the alarm watches (Phase 6).
      console.error(`gp_scan_failed: label ${o.ticker} ${o.pk}: ${err.message}`);
    }
  }

  const summary = {
    ok: true,
    strategyVersion: STRATEGY_VERSION,
    startedAt,
    finishedAt: new Date().toISOString(),
    openConsidered: open.length,
    tally,
  };
  console.log("gp_label_summary", JSON.stringify(summary));
  return summary;
}
