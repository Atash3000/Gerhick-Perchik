# Telegram Alert v2 — Visibility Upgrade (No Scoring Changes)

**Date:** 2026-06-23
**Status:** Approved for implementation
**Strategy version:** unchanged (`gp-2.0.0`) — this is NOT a strategy change

## Goal

Make every Telegram alert explain **why** a stock scored the way it did, without
changing any score, gate, threshold, weight, version, decision logic, or outcome
logic. This is a **visibility-only** change. The LLM narration payload does not
change, so "Math decides. AI only explains." still holds — the model never sees or
alters any of the new fields.

## Hard rules (non-negotiable)

- No score changes. No gate changes. No threshold changes. No weight changes.
- No `STRATEGY_VERSION` bump.
- No `buildPayload` / `narrate` changes (the LLM payload is untouched).
- No new API calls. No new persistence. Reuse only data already computed in the scan.

## Background — why a design was needed

The original ask listed field sources that did not all match the real code. Verified
against the codebase:

- `md.rsRank` — present (scanner sets it cross-sectionally at `scanner/handler.mjs:220`). ✓
- `result.targetType` — present (`scoring.mjs`). ✓
- `result.breakdown` — present, and its values already sum to `result.score`
  (invariant at `scoring.mjs:253`: `round(sum, 2) === score`). ✓
- **Gap:** `composeRichMessage(result, md, config, mode, narration)` does **not**
  receive `fundamentals` or `sectorStrengthPct`. The scanner has both in scope at
  the call site (`scanner/handler.mjs:300`) but never passes them in. → plumbing change.
- **Gap:** the real `breakdown` has **9** keys, not 8 — it includes
  `empiricalEdge` (fixed `7.5` neutral, `NEUTRAL_EMPIRICAL_EDGE`, until Phase 8).
  The original example omitted it. Hiding it would make the visible rows sum to
  `score − 7.5`, contradicting the "breakdown sums to score" requirement.
  **Decision: show all 9, label Empirical Edge as neutral, add an explanatory note.**

## Implementation surface (exactly 3 files)

### 1. `lambdas/shared/narration.mjs`

- Import `WEIGHTS` from `scoring.mjs` for the breakdown denominators. `WEIGHTS` is
  **already exported** (`scoring.mjs:36`) — import only, no export change. Do NOT
  hardcode weights in the message builder.
- Add a pure helper `buildScoreFactors(result, md, extras)` that returns the new
  factor lines (see Rendered block below).
- Extend the builder signature to a trailing options object:

  ```
  composeRichMessage(result, md, config, mode, narration, extras = {})
  // extras = { fundamentals, sectorStrengthPct }
  ```

  `extras` defaults to `{}` so existing callers/tests remain valid. `md` stays pure
  market data; fundamentals and sectorStrengthPct stay as context/extras.
- Insert the new `📊 Score Factors:` section **between `📈 Technicals` and
  `💡 Thesis`**. Do not remove or reorder any existing section.
- Add the compact distance/ATR line **inside the existing `📈 Technicals` block**.

### 2. `lambdas/scanner/handler.mjs`

- One edit at the `composeRichMessage` call (`~line 300`): pass the 6th arg
  `{ fundamentals, sectorStrengthPct: marketContext.sectorStrengthPct }`.
  Both values are already in scope. No other change.

### 3. `tests/narration.test.mjs`

- Add the tests listed under **Testing** below. Existing tests use `assert.match` /
  substring assertions (not full-string equality) and the new `extras` param is
  optional, so inserting lines does not break them.

## Rendered block

Inserted between `📈 Technicals` and `💡 Thesis`:

```
📊 Score Factors:
RS Rank: 87/99
EPS Growth YoY: +42.0%
Revenue Growth YoY: +18.0%
Sector Strength: 78/99
Target Type: Projected ATR target

Factor Breakdown:
Trend: 15/15
Setup: 17.3/20
RS: 10/12
Growth: 9/13
Sector: 4/5
Momentum: 7/10
Volume: 5/8
News: 2/2
Empirical Edge: 7.5/15 (neutral)
ℹ️ Empirical Edge is neutral until enough outcomes exist.
```

Compact line folded into the existing `📈 Technicals` block:

```
Distance >200MA: +18.2%  ·  >50MA: +6.4%
ATR/Price: 1.6%
```

## Field formatting

| Field | Source | Format | Missing |
|---|---|---|---|
| RS Rank | `md.rsRank` | `87/99` (percentile 1–99, denom fixed `99`) | `N/A` |
| EPS Growth YoY | `extras.fundamentals.epsGrowthQtr` | signed, 1 decimal, `%` (e.g. `+42.0%`) | `N/A` |
| Revenue Growth YoY | `extras.fundamentals.salesGrowthQtr` | signed, 1 decimal, `%` | `N/A` |
| Sector Strength | `extras.sectorStrengthPct` | `78/99` | `N/A` |
| Target Type | `result.targetType` | human-friendly label (below) | `N/A` |
| Factor Breakdown rows | `result.breakdown` | `value/max`, fixed order (below) | missing component → `0` |

### Target Type labels

- `RESISTANCE` → `Resistance target`
- `PROJECTED_ATR` → `Projected ATR target`
- `RESISTANCE_FLOORED_BY_PROJECTED_ATR` → `Resistance too close → ATR floor`
- missing / unrecognized → `N/A`

### Factor Breakdown — order, labels, denominators

Fixed display order (label ← breakdown key, `/max` ← `WEIGHTS[key]`):

| Display label | breakdown key | max (`WEIGHTS`) |
|---|---|---|
| Trend | `trend` | 15 |
| Setup | `setup` | 20 |
| RS | `rsRank` | 12 |
| Growth | `growthQuality` | 13 |
| Sector | `sectorStrength` | 5 |
| Momentum | `momentum` | 10 |
| Volume | `volume` | 8 |
| News | `news` | 2 |
| Empirical Edge | `empiricalEdge` | 15 |

### Two rules that protect the "sums to score" invariant

1. **Show actual breakdown values, do NOT re-round to integers.** `7.5` stays `7.5`,
   `17.3` stays `17.3`. The engine's own `round(value, 2)` outputs already sum
   exactly to `result.score`; integer rounding the display would visibly break that
   sum. Trailing `.0` may be trimmed for readability (a trimmed `15.0` → `15` does
   not change the value).
2. **Denominators come from imported `WEIGHTS`,** never hardcoded — the alert cannot
   drift out of sync if a weight is ever changed.

## Testing (TDD — `tests/narration.test.mjs`)

1. **Factors present** — RS Rank, EPS Growth, Revenue Growth, Sector Strength, and
   Target Type all render with correct formatting (signs, one decimal, `/99`).
2. **Factors missing** — `extras = {}`, no `md.rsRank`, null fundamentals/sector →
   every factor field shows `N/A`; every breakdown component shows `0`.
3. **Target Type labels** — all three enums map to their human-friendly labels;
   missing → `N/A`.
4. **Breakdown rows sum to `result.score`** — parse the numeric values from the
   displayed `Factor Breakdown` rows; assert they sum (to 2 dp) to `result.score`.
5. **Empirical Edge row + note** — the `Empirical Edge: x/15 (neutral)` row and the
   `Empirical Edge is neutral until enough outcomes exist.` note are always present.
6. **Distance/ATR line** — `Distance >200MA`, `>50MA`, and `ATR/Price` render and
   are computed correctly from `md.close/ma200/ma50/atr`.
7. **Existing tests still pass** — no regression in the current `composeRichMessage`,
   `buildPayload`, `buildBullets`, `narrate`, `composeMessage` assertions.

## Out of scope (explicitly)

- Any change to `score()`, gates, thresholds, weights, or `STRATEGY_VERSION`.
- Any change to `buildPayload` / `narrate` / the LLM payload or prompt.
- New API calls, new fields fetched, or new persistence.

## Expected outcome

A user receiving a signal immediately understands: why the score is what it is,
whether fundamentals helped, whether RS helped, whether sector helped, and whether
the target came from a resistance level or the projected-ATR fallback. Transparency
upgrade, not a strategy upgrade.

## Workflow

TDD per failing test → implement → green. One feature branch, conventional commits,
open a PR for review (per CLAUDE.md git workflow).
