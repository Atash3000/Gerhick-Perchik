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
    scoreDistribution: { high: 0, mid: 0, low: 0, lowFloor: null },
    sectorBreakdown: [],
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
    scoreDistribution: scoreDistribution(latest, threshold),
    sectorBreakdown: sectorBreakdown(latest),
    targetTypes: targetTypeDistribution(latest),
    topScored: topScored(latest, 10),
    outcomes: outcomeCounts(outcomes, dataAsOf),
  };
}

// Distribution of the BUY_CANDIDATES by score band (sums to buyCandidates). Bands
// are fixed at 70+ / 60–69, with the bottom band floored at the live threshold so
// its label tracks config (e.g. 53–59) instead of drifting. Candidates are already
// >= threshold by definition, so anything below 60 falls in the bottom band.
function scoreDistribution(latest, threshold) {
  const cands = latest.filter((s) => s.decision === "BUY_CANDIDATE" && typeof s.score === "number");
  let high = 0, mid = 0, low = 0;
  for (const s of cands) {
    if (s.score >= 70) high += 1;
    else if (s.score >= 60) mid += 1;
    else low += 1;
  }
  return { high, mid, low, lowFloor: typeof threshold === "number" ? threshold : null };
}

// Candidate count by sector (desc by count, then sector name for stable order).
// null/missing sector → "Unknown". Returns ALL sectors; the renderer shows top 5.
function sectorBreakdown(latest) {
  const counts = {};
  for (const s of latest) {
    if (s.decision !== "BUY_CANDIDATE") continue;
    const sec = s.sector ?? "Unknown";
    counts[sec] = (counts[sec] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([sector, count]) => ({ sector, count }))
    .sort((a, b) => b.count - a.count || a.sector.localeCompare(b.sector));
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

// Friendly names for the raw gate keys (unknown keys fall through verbatim).
const GATE_LABELS = {
  correlation: "Correlation",
  trend: "Trend <200MA",
  liquidity: "Liquidity",
  earnings: "Earnings",
  marketRegime: "SPY <200MA",
  news: "High-impact news",
  validRisk: "Bad ATR/stop",
  targetAbovePrice: "Target ≤ price",
  riskReward: "R:R too low",
};

const DIVIDER = "━━━━━━━━━━━━━━━━━━━━";

// "RealEstate" → "Real Estate", "HealthCare" → "Health Care" (camel-case boundary).
function prettySector(s) {
  return String(s).replace(/([a-z])([A-Z])/g, "$1 $2");
}

function renderText({ dataAsOf, counts, strategyVersion, threshold }) {
  const c = counts;
  const L = [];

  // Header
  L.push("🟢 GERCHIK-PERCHIK — Daily Funnel");
  L.push(`📅 ${dataAsOf} · ${strategyVersion ?? "?"} · 📋 OBSERVE`);
  L.push(DIVIDER, "");

  // Funnel
  L.push("🔎 Funnel");
  L.push(`• Scanned:     ${c.watchlist}`);
  L.push(`• Fresh:       ${c.freshCoverage.fresh}/${c.freshCoverage.total} (${c.freshCoverage.pct}%)`);
  if (c.freshCoverage.noData) L.push(`• NO_DATA:     ${c.freshCoverage.noData}`);
  L.push(`• Scored:      ${c.reachingScoring}`);
  L.push(`• Candidates:  ${c.buyCandidates} (≥${threshold ?? "?"})`);
  L.push("");

  // Dropped (gate rejections)
  L.push(`🚧 Dropped (${c.gateBreakdown.totalNoSignal})`);
  const gateRows = Object.entries(c.gateBreakdown.byGate)
    .sort((a, b) => b[1] - a[1])
    .map(([g, n]) => `• ${GATE_LABELS[g] ?? g}: ${n}`);
  if (c.gateBreakdown.belowThreshold) gateRows.push(`• Below score: ${c.gateBreakdown.belowThreshold}`);
  if (c.gateBreakdown.unrecognized) gateRows.push(`• Unrecognized: ${c.gateBreakdown.unrecognized}`);
  L.push(...(gateRows.length ? gateRows : ["• (none)"]));
  L.push("");

  // Score Distribution (of candidates)
  const sd = c.scoreDistribution;
  const lowLabel = sd.lowFloor != null ? `${sd.lowFloor}–59` : "<60";
  L.push("📊 Score Distribution");
  L.push(`• 70+:   ${sd.high}`);
  L.push(`• 60–69: ${sd.mid}`);
  L.push(`• ${lowLabel}: ${sd.low}`);
  L.push("");

  // Target Types
  const tt = c.targetTypes;
  L.push("🎯 Target Types");
  L.push(`• Resistance:    ${tt.RESISTANCE}`);
  L.push(`• Projected ATR: ${tt.PROJECTED_ATR}`);
  L.push(`• ATR Floored:   ${tt.RESISTANCE_FLOORED_BY_PROJECTED_ATR}`);
  L.push("");

  // Top Sectors (of candidates) — omitted when there are no candidates
  if (c.sectorBreakdown.length) {
    L.push(`🏭 Top Sectors (of ${c.buyCandidates} candidates)`);
    const top5 = c.sectorBreakdown.slice(0, 5);
    L.push(...top5.map((x) => `• ${prettySector(x.sector)}: ${x.count}`));
    const more = c.sectorBreakdown.length - top5.length;
    if (more > 0) L.push(`• +${more} more`);
    L.push("");
  }

  // Top 5 setups
  L.push("🏆 Top 5 Today");
  const top = c.topScored.slice(0, 5);
  L.push(...(top.length ? top.map((s, i) => `${i + 1}. ${s.ticker} ${s.score}`) : ["(none scored)"]));
  L.push("");

  // Outcomes
  L.push("📈 Outcomes");
  L.push(`• New today: ${c.outcomes.newlyOpened}`);
  L.push(`• Open: ${c.outcomes.open}`);
  L.push(`• Closed: ${c.outcomes.closed}`);
  L.push("");

  L.push(DIVIDER);
  L.push("small-n, preliminary");
  L.push("don't pool across strategyVersion");
  return L.join("\n");
}
