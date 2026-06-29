// orchestrate.mjs — the momentum weekly loop as a PURE decision (planScan) + a thin
// I/O shell (executePlan). Splitting it this way is what makes the loop testable
// against plain inputs with a fake store (no AWS), so the load-bearing invariants —
// exits-before-fills, after-cost scanner closes, snapshotsOnly suppression, the
// trailing-stop refresh — get real assertions. The handler (4b-2b-v) gathers data,
// computes the SPY regime + the cross-sectional ranking, and calls these.

import { evaluateExits, sizePosition, constructBook } from "../shared/portfolio.mjs";
import { afterCostProfitPct, excursion } from "../shared/labeling.mjs";
import { normalizeMomentumExitReason } from "../shared/store.mjs";
import { STRATEGY_VERSION } from "../shared/version.mjs";

const round = (n, dp = 4) => {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

// Short human reason for a NOT_ELIGIBLE row (first failed check).
function failedCheckReason(eligibility) {
  if (eligibility?.insufficientHistory) return "insufficient_history";
  const c = eligibility?.checks ?? {};
  if (c.price === false) return "below_min_price";
  if (c.dollarVol === false) return "below_min_dollar_vol";
  if (c.trend === false) return "below_trend_ma";
  if (c.noBigMove === false) return "big_single_day_move";
  return "not_eligible";
}

// PURE. Decide everything for one scan; return a plan of actions (no I/O).
//   gathered    : [{ ticker, sector, md, eligibility }] for the whole universe
//                 (md = buildMomentumData result; eligibility = isEligible result)
//   ranked      : rankByMomentum() output over the eligible set (handler-computed)
//   openOutcomes: the held book (open momentum outcome rows)
//   governor    : riskGovernor() result
// Returns { snapshots, refreshes, exits, buys }.
export function planScan({ config, regimeOn, asOf, gathered, ranked, openOutcomes, governor, accountValue, spy = null }) {
  const byTicker = new Map((gathered ?? []).map((g) => [g.ticker, g]));
  const rankByT = new Map((ranked ?? []).map((r) => [r.ticker, r]));
  const openByT = new Map((openOutcomes ?? []).map((o) => [o.ticker, o]));

  const exitedTickers = new Set();
  const refreshes = [];
  const exits = [];

  // --- 1. EXITS FIRST (frees slots for same-run fills; Strategy-v1 §7 step 2) ---
  for (const o of openOutcomes ?? []) {
    const g = byTicker.get(o.ticker);
    if (!g || !g.md?.fresh) continue; // no fresh data → leave open; labeler still tracks the stop
    const m = g.md;
    const lastBar = m.bars[m.bars.length - 1];
    const position = { entry: o.entry, stop: o.stop, peakClose: o.peakClose };
    // A held name not in the ranked eligible set is no longer a momentum leader → rank-exit.
    const ctx = { atr: m.atr, trendSma: m.ma100, inExitZone: rankByT.get(o.ticker)?.inExitZone ?? true };

    let res;
    try {
      res = evaluateExits(position, lastBar, ctx, config);
    } catch {
      // non-finite data → defensive close, never a silent NaN (schema data_error).
      exits.push({ pk: o.pk, sk: o.sk, ticker: o.ticker, fields: { outcome: "EXIT", exitReason: "data_error", exitDate: asOf } });
      exitedTickers.add(o.ticker);
      continue;
    }

    // The scanner closes ONLY rank/trend exits; the labeler owns the daily stop touch.
    if (res.exit && (res.reason === "RANK" || res.reason === "TREND")) {
      const exitPrice = lastBar.close; // closed at the review-day close
      const held = m.bars.filter((b) => b.date > o.entryDate);
      const maxHigh = held.length ? Math.max(...held.map((b) => b.high)) : o.entry;
      const minLow = held.length ? Math.min(...held.map((b) => b.low)) : o.entry;
      const exc = excursion(o.entry, maxHigh, minLow);
      exits.push({
        pk: o.pk, sk: o.sk, ticker: o.ticker,
        fields: {
          outcome: "EXIT",
          exitReason: normalizeMomentumExitReason(res.reason), // rank_exit | trend_exit
          exitPrice: round(exitPrice, 4),
          exitDate: asOf,
          daysHeld: held.length,
          profitPct: afterCostProfitPct(o.entry, exitPrice, config), // SAME cost math as the labeler
          mfePct: exc.mfePct, maePct: exc.maePct, mfePrice: exc.mfePrice, maePrice: exc.maePrice,
        },
      });
      exitedTickers.add(o.ticker);
    } else {
      // hold (or a stop the labeler will catch) → advance the chandelier trail.
      refreshes.push({ pk: o.pk, sk: o.sk, ticker: o.ticker, stop: res.stop, peakClose: res.peakClose });
    }
  }

  // --- 2. CONSTRUCT FILLS (exits already removed → freed slots are available) ---
  // The regime gate (§2): open NEW longs only when SPY is risk-on. Risk-off → buy
  // NOTHING; existing positions keep being managed by their exits (drift to cash).
  const heldNow = new Set([...openByT.keys()].filter((t) => !exitedTickers.has(t)));
  const picks = regimeOn ? constructBook(ranked ?? [], heldNow, governor, config).buys : [];

  const buys = [];
  for (const r of picks) {
    const g = byTicker.get(r.ticker);
    if (!g || !g.md?.fresh) continue;
    const m = g.md;
    const entry = m.close; // OBSERVE: entry = signalClose = today's close (locked approximation)
    const sizing = sizePosition(entry, m.atr, accountValue, config);
    if (!sizing) continue; // can't size a real position → skip
    buys.push({
      sector: g.sector,
      result: {
        ticker: r.ticker, dataAsOf: asOf, strategyVersion: STRATEGY_VERSION,
        decision: "BUY_CANDIDATE", reason: "bought",
        entry, stop: sizing.stop, shares: sizing.shares, peakClose: entry,
        signalClose: entry, plannedEntry: entry, entryAtr: m.atr,
        initialRiskPct: round((sizing.riskAmount / accountValue) * 100, 4),
        momentum: r.momentum, slope: r.slope, r2: r.r2, rank: r.rank, rankPct: r.rankPct,
      },
    });
  }
  const boughtT = new Set(buys.map((b) => b.result.ticker));

  // --- 3. SNAPSHOTS for EVERY scored name (record the decision + inputs, even exclusions) ---
  const snapshots = [];
  for (const g of gathered ?? []) {
    const m = g.md;
    const r = rankByT.get(g.ticker);
    const held = openByT.has(g.ticker);
    const exited = exitedTickers.has(g.ticker);

    let decision;
    let reason;
    if (!m?.fresh) { decision = "NO_DATA"; reason = m?.reason ?? "no_data"; }
    else if (held && exited) { decision = "EXIT"; reason = exits.find((e) => e.ticker === g.ticker)?.fields.exitReason ?? "exit"; }
    else if (held) { decision = "HOLD"; reason = "held"; }
    else if (!regimeOn) { decision = "REGIME_OFF"; reason = "spy_below_regime_ma"; }
    else if (!(g.eligibility?.eligible)) { decision = "NOT_ELIGIBLE"; reason = failedCheckReason(g.eligibility); }
    // BUY_CANDIDATE means ONLY "opened a position" — so a report keying off decision
    // counts actual buys. An eligible name that ranked but wasn't bought (no free
    // slot, or below the entry-rank cut) is RANKED_NOT_BOUGHT (reason disambiguates).
    else if (boughtT.has(g.ticker)) { decision = "BUY_CANDIDATE"; reason = "bought"; }
    else { decision = "RANKED_NOT_BOUGHT"; reason = r?.inEntryZone ? "candidate_no_slot" : "below_entry_rank"; }

    // Position fields: bought → from the new buy; held → from the outcome (refreshed if so).
    const bought = buys.find((b) => b.result.ticker === g.ticker);
    const heldRow = openByT.get(g.ticker);
    const refresh = refreshes.find((rf) => rf.ticker === g.ticker);
    const pos = bought
      ? { entry: bought.result.entry, stop: bought.result.stop, peakClose: bought.result.peakClose, shares: bought.result.shares }
      : held
        ? { entry: heldRow.entry, stop: refresh?.stop ?? heldRow.stop, peakClose: refresh?.peakClose ?? heldRow.peakClose, shares: heldRow.shares }
        : { entry: null, stop: null, peakClose: null, shares: null };

    snapshots.push({
      sector: g.sector,
      marketData: m,
      spy, // capture-only SPY regime context (handler-injected), same on every row
      result: {
        ticker: g.ticker, decision, reason,
        dataAsOf: m?.dataAsOf ?? asOf, strategyVersion: STRATEGY_VERSION,
        momentum: r?.momentum ?? null, slope: r?.slope ?? null, r2: r?.r2 ?? null,
        rank: r?.rank ?? null, rankPct: r?.rankPct ?? null,
        inEntryZone: r?.inEntryZone ?? null, inExitZone: r?.inExitZone ?? null,
        eligible: g.eligibility?.eligible === true,
        checks: g.eligibility?.checks ?? null,
        insufficientHistory: g.eligibility?.insufficientHistory === true,
        regimeOn: regimeOn === true,
        ...pos,
        exitReason: held && exited ? (exits.find((e) => e.ticker === g.ticker)?.fields.exitReason ?? null) : null,
      },
    });
  }

  return { snapshots, refreshes, exits, buys };
}

// Thin I/O shell: apply a plan via the store. `snapshotsOnly` (the dry-run flag)
// writes snapshots ONLY — no outcomes opened/closed/refreshed, no alerts — so the
// first real-data run can be reviewed before any tracked outcome is committed.
// FAILS LOUD if scanId/params are missing (every row must be self-describing).
export async function executePlan(plan, { store, sendAlert, snapshotsOnly = false, scanId, params } = {}) {
  if (!scanId) throw new Error("executePlan: scanId is required (self-describing rows)");
  if (!params) throw new Error("executePlan: params is required (self-describing rows)");

  let snapshotsWritten = 0, outcomesOpened = 0, exitsClosed = 0, refreshed = 0, alertsSent = 0, alertErrors = 0;

  for (const s of plan.snapshots) {
    await store.writeMomentumSnapshot(s.result, {
      asOf: s.result.dataAsOf, sector: s.sector, marketData: s.marketData, spy: s.spy ?? null, scanId, params,
    });
    snapshotsWritten += 1;
  }

  if (snapshotsOnly) {
    return { snapshotsWritten, outcomesOpened: 0, exitsClosed: 0, refreshed: 0, alertsSent: 0, snapshotsOnly: true };
  }

  for (const rf of plan.refreshes) {
    const r = await store.updateOpenPosition(rf.pk, rf.sk, { stop: rf.stop, peakClose: rf.peakClose });
    if (r?.updated) refreshed += 1; // count only real updates — a closed-row skip mustn't inflate the tally
  }
  for (const ex of plan.exits) {
    const c = await store.closeOutcome(ex.pk, ex.sk, ex.fields);
    if (c?.closed) exitsClosed += 1; // count only real closes
  }
  for (const b of plan.buys) {
    const opened = await store.openMomentumOutcome(b.result, { sector: b.sector, scanId });
    if (opened?.opened) {
      outcomesOpened += 1;
      // Alerts are BEST-EFFORT: a Telegram failure must NOT fail the scan, abort the
      // remaining buys, or roll back outcomes already persisted. Log + count, continue.
      if (sendAlert) {
        try {
          await sendAlert(b);
          alertsSent += 1;
        } catch (err) {
          alertErrors += 1;
          console.error(`gp_scan_failed: alert ${b.result?.ticker}: ${err.message}`);
        }
      }
    }
  }

  return { snapshotsWritten, outcomesOpened, exitsClosed, refreshed, alertsSent, alertErrors, snapshotsOnly: false };
}
