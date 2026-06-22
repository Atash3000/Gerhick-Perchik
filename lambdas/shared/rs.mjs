// rs.mjs — relative-strength capture (pure). CAPTURE-ONLY: these values are
// recorded on snapshots/outcomes for later Phase-8 analysis. They are NOT used in
// scoring, gates, or the threshold. No AI.
//
// rsRaw is a recency-weighted blend of stored price returns; rsRank is the
// cross-sectional percentile of rsRaw across the scanned universe (1-99).

const round = (n, dp = 2) => (n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp);

// Composite raw relative strength: 2*return63d + return126d + return252d.
// (21d omitted as too noisy.) null if any required return is missing.
export function rsRaw(md) {
  const r63 = md?.return63d;
  const r126 = md?.return126d;
  const r252 = md?.return252d;
  if ([r63, r126, r252].some((v) => typeof v !== "number" || !Number.isFinite(v))) return null;
  return round(2 * r63 + r126 + r252, 2);
}

// Relative strength vs SPY over the 126d window (the name's return minus SPY's).
// null if either is unavailable.
export function rsVsSpy(md, spyReturn126d) {
  if (typeof md?.return126d !== "number" || typeof spyReturn126d !== "number") return null;
  return round(md.return126d - spyReturn126d, 2);
}

// Percentile-rank a set of {key, value} pairs into 1-99. Items with a null/non-
// numeric value get rank null (excluded from the ranking population). Returns a
// Map key -> rank. O(n^2) but the universe is small (~40).
export function rankPercentiles(pairs) {
  const out = new Map();
  for (const p of pairs) out.set(p.key, null);
  const valued = pairs.filter((p) => typeof p.value === "number" && Number.isFinite(p.value));
  const n = valued.length;
  if (n === 0) return out;
  for (const p of valued) {
    const less = valued.filter((q) => q.value < p.value).length;
    const eq = valued.filter((q) => q.value === p.value).length;
    const pct = Math.round(((less + 0.5 * eq) / n) * 100);
    out.set(p.key, Math.min(99, Math.max(1, pct)));
  }
  return out;
}

// Cross-sectional sector strength (gp-2.0.0 sectorStrength input): mean rsRaw per
// sector, then percentile-rank the sectors into 1-99. Sectors with fewer than
// `minNames` ranked names are excluded (too few to be a real signal) and absent
// from the returned map → the caller treats a missing lookup as neutral 0.
// `items`: [{ sector, rsRaw }]. Returns Map sector -> percentile. Pure.
export function sectorStrengthPercentiles(items, minNames = 3) {
  const bySector = new Map();
  for (const it of items) {
    if (!it || it.sector == null) continue;
    if (typeof it.rsRaw !== "number" || !Number.isFinite(it.rsRaw)) continue;
    if (!bySector.has(it.sector)) bySector.set(it.sector, []);
    bySector.get(it.sector).push(it.rsRaw);
  }
  const pairs = [];
  for (const [sector, vals] of bySector) {
    if (vals.length < minNames) continue; // not meaningful — leave out (→ null on lookup)
    pairs.push({ key: sector, value: vals.reduce((a, b) => a + b, 0) / vals.length });
  }
  return rankPercentiles(pairs);
}
