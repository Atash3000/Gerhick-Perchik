// report.mjs — PURE funnel-report builder. No I/O, no clock, no secrets. Given the
// raw gp-snapshots / gp-outcomes rows + config + a clock value, it returns the
// report numbers and the Telegram text. The whole computation is unit-testable.
//
// OBSERVABILITY ONLY. This module reads what the scanner already produced and
// reports it. It never decides a trade, never changes a number, never writes.

const DEFAULT_FRESH_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h: a 23:30 scan is fresh at 00:10

const TARGET_TYPES = ["RESISTANCE", "PROJECTED_ATR", "RESISTANCE_FLOORED_BY_PROJECTED_ATR"];

// Build the funnel report. Inputs are plain JS arrays/objects (as the DynamoDB
// document client returns). nowMs/freshWindowMs are injected so this stays pure.
export function buildFunnelReport({ snapshots = [], outcomes = [], config = {}, nowMs, freshWindowMs = DEFAULT_FRESH_WINDOW_MS } = {}) {
  const strategyVersion = config.strategyVersion ?? null;
  const threshold = config.buyScoreThreshold ?? null;

  // --- Latest scan selection: rows whose dataAsOf equals the max present. ---
  const dataAsOf = snapshots.reduce((max, s) => {
    const d = s?.dataAsOf;
    return d && (max === null || d > max) ? d : max;
  }, null);

  if (dataAsOf === null) {
    return {
      isFreshScan: false,
      dataAsOf: null,
      counts: emptyCounts(outcomes),
      text: "📋 no new scan today — funnel report skipped (no snapshots found).",
    };
  }

  const latest = snapshots.filter((s) => s?.dataAsOf === dataAsOf);

  // --- Fresh-scan gate: newest scannedAt within the window of now. ---
  const newestScannedMs = latest.reduce((max, s) => {
    const t = s?.scannedAt ? Date.parse(s.scannedAt) : NaN;
    return Number.isFinite(t) && t > max ? t : max;
  }, -Infinity);
  const isFreshScan =
    Number.isFinite(newestScannedMs) && typeof nowMs === "number" && nowMs - newestScannedMs <= freshWindowMs;

  const counts = computeCounts(latest, outcomes, dataAsOf, threshold);

  if (!isFreshScan) {
    return {
      isFreshScan,
      dataAsOf,
      counts,
      text: `📋 no new scan today — funnel report skipped (latest scan ${dataAsOf}).`,
    };
  }

  return { isFreshScan, dataAsOf, counts, text: renderText({ dataAsOf, counts, strategyVersion, threshold }) };
}

function emptyCounts(outcomes) {
  return {
    watchlist: 0,
    freshCoverage: { fresh: 0, total: 0, pct: 0, noData: 0 },
    reachingScoring: 0,
    buyCandidates: 0,
    gateBreakdown: { totalNoSignal: 0, byGate: {}, belowThreshold: 0, unrecognized: 0 },
    targetTypes: { RESISTANCE: 0, PROJECTED_ATR: 0, RESISTANCE_FLOORED_BY_PROJECTED_ATR: 0 },
    topScored: [],
    outcomes: outcomeCounts(outcomes, null),
  };
}

function computeCounts(latest, outcomes, dataAsOf, threshold) {
  const total = latest.length;
  const noData = latest.filter((s) => s.decision === "NO_DATA").length;
  const fresh = total - noData;
  const pct = total > 0 ? round1((fresh / total) * 100) : 0;

  const reachingScoring = latest.filter((s) => s.score !== null && s.score !== undefined).length;
  const buyCandidates = latest.filter((s) => s.decision === "BUY_CANDIDATE").length;

  return {
    watchlist: total,
    freshCoverage: { fresh, total, pct, noData },
    reachingScoring,
    buyCandidates,
    gateBreakdown: gateBreakdown(latest),
    targetTypes: targetTypeDistribution(latest),
    topScored: topScored(latest, 10),
    outcomes: outcomeCounts(outcomes, dataAsOf),
  };
}

// Partition every NO_SIGNAL row into exactly one of: a single failed gate, the
// "below threshold" bucket (reached scoring), or "unrecognized" (no single false
// gate — should not happen, but is counted so nothing is silently dropped).
// Invariant: sum(byGate) + belowThreshold + unrecognized === totalNoSignal.
function gateBreakdown(latest) {
  const noSignal = latest.filter((s) => s.decision === "NO_SIGNAL");
  const byGate = {};
  let belowThreshold = 0;
  let unrecognized = 0;

  for (const s of noSignal) {
    // Reached scoring (a score was computed, all gates passed) → not a gate rejection.
    if (s.score !== null && s.score !== undefined) {
      belowThreshold += 1;
      continue;
    }
    const falseGates = s.gates && typeof s.gates === "object"
      ? Object.entries(s.gates).filter(([, v]) => v === false).map(([k]) => k)
      : [];
    if (falseGates.length === 1) {
      const g = falseGates[0];
      byGate[g] = (byGate[g] ?? 0) + 1;
    } else {
      unrecognized += 1; // zero or multiple false gates — never drop the row
    }
  }
  return { totalNoSignal: noSignal.length, byGate, belowThreshold, unrecognized };
}

function targetTypeDistribution(latest) {
  const dist = { RESISTANCE: 0, PROJECTED_ATR: 0, RESISTANCE_FLOORED_BY_PROJECTED_ATR: 0 };
  for (const s of latest) {
    if (TARGET_TYPES.includes(s.targetType)) dist[s.targetType] += 1;
  }
  return dist;
}

function topScored(latest, n) {
  return latest
    .filter((s) => s.score !== null && s.score !== undefined)
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((s) => ({ ticker: s.ticker, score: s.score, decision: s.decision, targetType: s.targetType ?? null }));
}

function outcomeCounts(outcomes, dataAsOf) {
  const open = outcomes.filter((o) => o.status === "OPEN").length;
  const closed = outcomes.filter((o) => o.status === "CLOSED").length;
  const newlyOpened = dataAsOf === null ? 0 : outcomes.filter((o) => o.entryDate === dataAsOf).length;
  return { open, closed, newlyOpened };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// --- Telegram text (plain text; deterministic) -----------------------------
function renderText({ dataAsOf, counts, strategyVersion, threshold }) {
  const c = counts;
  const gateLines = Object.entries(c.gateBreakdown.byGate)
    .sort((a, b) => b[1] - a[1])
    .map(([g, n]) => `    ${g}: ${n}`);
  if (c.gateBreakdown.belowThreshold) gateLines.push(`    (reached scoring, below threshold: ${c.gateBreakdown.belowThreshold})`);
  if (c.gateBreakdown.unrecognized) gateLines.push(`    unrecognized: ${c.gateBreakdown.unrecognized}`);

  const top = c.topScored.length
    ? c.topScored.map((s, i) => `    ${i + 1}. ${s.ticker} ${s.score} (${s.decision}, ${s.targetType ?? "—"})`).join("\n")
    : "    (none scored)";

  const tt = c.targetTypes;
  return [
    `📋 OBSERVE — Funnel report · ${dataAsOf} · ${strategyVersion ?? "?"}`,
    "(measurement, not a recommendation)",
    "",
    `Watchlist scanned: ${c.watchlist}`,
    `Fresh coverage: ${c.freshCoverage.fresh}/${c.freshCoverage.total} (${c.freshCoverage.pct}%)  ·  NO_DATA: ${c.freshCoverage.noData}`,
    `Reaching scoring: ${c.reachingScoring}`,
    `BUY_CANDIDATE: ${c.buyCandidates}  (threshold ${threshold ?? "?"})`,
    "",
    `Gate rejections (total NO_SIGNAL ${c.gateBreakdown.totalNoSignal}):`,
    ...(gateLines.length ? gateLines : ["    (none)"]),
    "",
    "Target type (rows that derived a target):",
    `    RESISTANCE: ${tt.RESISTANCE}  ·  PROJECTED_ATR: ${tt.PROJECTED_ATR}  ·  RES_FLOORED: ${tt.RESISTANCE_FLOORED_BY_PROJECTED_ATR}`,
    "",
    "Top scored:",
    top,
    "",
    `Outcomes: +${c.outcomes.newlyOpened} new  ·  ${c.outcomes.open} open  ·  ${c.outcomes.closed} closed (cumulative)`,
    "",
    "small-n, preliminary · don't pool across strategyVersion",
  ].join("\n");
}
