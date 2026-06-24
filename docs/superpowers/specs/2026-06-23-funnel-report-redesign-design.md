# Daily Funnel Report — Redesign (dashboard layout + 2 new sections)

**Date:** 2026-06-23
**Status:** Approved for implementation
**Scope:** presentation of `lambdas/funnel-report/report.mjs` + two new pure count
helpers. READ-ONLY observability only — no scoring/gate/threshold/decision change,
no `STRATEGY_VERSION` bump, no writes.

## Goal

Turn the funnel report from raw-looking key/values into a clean, emoji-sectioned
operations dashboard the user wants to read every morning, and add two
high-value, near-free sections: **Score Distribution** and **Top Sectors**.

This also makes the report a **kept feature**, not the temporary "disable after ~5
reports" job CLAUDE.md currently describes. The EventBridge rule stays ENABLED and
the CLAUDE.md wording is updated to reflect that (see Out of scope note).

## What stays untouched

All counting/partition logic in `report.mjs` is correct and unit-tested and is NOT
changed: latest-scan selection, fresh-scan gate, `gateBreakdown` strict partition
(`sum(byGate)+belowThreshold+unrecognized === totalNoSignal`), `targetTypeDistribution`,
`topScored`, `outcomeCounts`. Existing tests assert on `counts.*` (not the text), so
the text redesign does not affect them.

## New pure count helpers (added to `computeCounts` output)

### `scoreDistribution(latest, threshold)` → `{ high, mid, low, lowFloor }`
Distribution of the **BUY_CANDIDATES** (decision `BUY_CANDIDATE`) by score band.
Sums to `buyCandidates`.

- `high` = candidates with `score >= 70`
- `mid`  = candidates with `60 <= score < 70`
- `low`  = candidates with `threshold <= score < 60`
- `lowFloor` = `threshold` (so the band label tracks the live threshold, e.g. `53–59`)

Edge: if `threshold` is null → `lowFloor` shown as `?` and `low` uses floor 53 as a
safe default is NOT done; instead `low` counts `score < 60` candidates (all
candidates are already ≥ threshold by definition, so this is exact). If `threshold
>= 60` the `low` band is naturally empty — acceptable, not a real case at 53.

### `sectorBreakdown(latest)` → `[{ sector, count }, …]`
Among **BUY_CANDIDATES**, count by `sector` (snapshot top-level field), sorted by
count desc then sector name asc for stable ordering. Null/missing sector → bucket
`"Unknown"`. The renderer shows the top 5 and, if more exist, a `+N more` line.

## Telegram text (redesigned `renderText`)

Plain text (no parse_mode change). Real 2026-06-23 numbers shown for reference:

```
🟢 GERCHIK-PERCHIK — Daily Funnel
📅 2026-06-23 · gp-2.0.0 · 📋 OBSERVE
━━━━━━━━━━━━━━━━━━━━

🔎 Funnel
• Scanned:      198
• Fresh:        198/198 (100%)
• Scored:       36
• Candidates:   29 (≥53)

🚧 Dropped (169)
• Correlation:  95
• Trend <200MA: 63
• Earnings:      4
• Below score:   7

📊 Score Distribution
• 70+:    3
• 60–69: 14
• 53–59: 12

🎯 Target Types
• Resistance:    2
• Projected ATR: 11
• ATR Floored:   23

🏭 Top Sectors (of 29 candidates)
• Financials:   8
• Industrials:  5
• REITs:        4
• Energy:       3
• …

🏆 Top 5 Today
1. WELL 77.63
2. NUE 77.32
3. APH 77.09
4. TFC 71.29
5. NXPI 69.09

📈 Outcomes
• New today: 29
• Open: 29
• Closed: 0

━━━━━━━━━━━━━━━━━━━━
small-n, preliminary
don't pool across strategyVersion
```

### Section rules

- **Funnel** — Candidates line shows `(≥<threshold>)`.
- **Dropped** — friendly gate labels, sorted by count desc, plus the `Below score`
  (belowThreshold) row and any `unrecognized` row. Label map:
  `correlation→Correlation`, `trend→Trend <200MA`, `earnings→Earnings`,
  `marketRegime→SPY <200MA`, `news→High-impact news`, `validRisk→Bad ATR/stop`,
  `targetAbovePrice→Target ≤ price`, `riskReward→R:R too low`. Unknown keys shown
  verbatim. Header count = `totalNoSignal`.
- **Score Distribution** — three bands; bottom label is `<lowFloor>–59` (or `<60`
  if threshold null).
- **Target Types** — `Resistance / Projected ATR / ATR Floored`.
- **Top Sectors** — top 5 candidate sectors; sector display name prettified by
  inserting a space at camel-case boundaries (`RealEstate→Real Estate`,
  `HealthCare→Health Care`); `+N more` when >5 sectors. Omit the whole section when
  there are 0 candidates.
- **Top 5 Today** — numbered `n. TICKER score`, no target-type tag. `(none scored)`
  when empty.
- **Outcomes** — New today / Open / Closed.
- The skip paths (no snapshots / not fresh) keep their existing short messages.

## Tests (TDD — `tests/funnel-report.test.mjs`)

1. `scoreDistribution` buckets candidates correctly; sums to `buyCandidates`;
   `lowFloor === threshold`; below-threshold scored names are excluded.
2. `sectorBreakdown` counts candidates by sector, desc order, null→`Unknown`.
3. `renderText` (via `buildFunnelReport` fresh path) contains each new section
   header and a sampled value (Score Distribution, Top Sectors, Target Types).
4. Top Sectors section omitted when 0 candidates.
5. Gate label mapping renders friendly names (e.g. `Trend <200MA`, `Correlation`).
6. Existing `counts.*` assertions unchanged (regression).

## Out of scope / safety

- No change to scoring, gates, thresholds, weights, `STRATEGY_VERSION`, or any
  write path. The report remains READ-ONLY.
- Schedule unchanged (00:10 UTC Tue–Sat). Rule stays ENABLED (feature is kept).
- CLAUDE.md's "temporary, disable after ~5 reports" note for `gp-funnel-report`
  is updated to "permanent daily dashboard" as part of this change.
