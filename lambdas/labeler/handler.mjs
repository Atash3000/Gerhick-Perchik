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
import { getDailyBars } from "../shared/marketdata.mjs";
import { labelSignal } from "../shared/labeling.mjs";
import { createStore } from "../shared/store.mjs";
import { STRATEGY_VERSION } from "../shared/version.mjs";

export async function handler() {
  const startedAt = new Date().toISOString();
  const config = await getActiveConfig(process.env.CONFIG_TABLE);
  const store = createStore();

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

      const res = await store.closeOutcome(o.pk, o.sk, {
        outcome: label.outcome,
        hitTargetFirst: label.hitTargetFirst,
        hitStopFirst: label.hitStopFirst,
        exitDate: label.exitDate,
        exitPrice: label.exitPrice,
        profitPct: label.profitPct, // after cost
        daysHeld: label.daysHeld,
        // Split re-anchor audit (see labeling.mjs):
        scaleFactor: label.scaleFactor,
        splitAdjusted: label.splitAdjusted,
        entryAdjAtLabel: label.entryAdjAtLabel,
        entryBarMissing: label.entryBarMissing,
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
