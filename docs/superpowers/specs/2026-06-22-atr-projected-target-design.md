# ATR-Projected Target (Provisional Funnel Unblock) — Design

**Date:** 2026-06-22
**Status:** Approved, implementing
**Scope:** Target-derivation only. Does NOT change scoring weights, the
`buyScoreThreshold` (53), the stop logic, any other gate, position sizing,
`STRATEGY_VERSION`, or `alertMode`. Does NOT build trailing exits.

---

## Problem (confirmed against live data)

On the only scan day on record (`dataAsOf 2026-06-18`, gp-2.0.0), all 43 watchlist
names were `NO_SIGNAL` and **zero** outcomes opened (`gp-outcomes` is empty). The
funnel is empty *before scoring* — names are gate-rejected, so there is nothing to
measure exits against.

Rejection breakdown (43 names): 16 `R:R below min`, 15 `below 200MA`, 12 `no
overhead resistance`. Two of those three buckets trace to **one** root cause in the
target-derivation step (`scoring.mjs`):

```js
gates.hasTarget = !!(nearestResistance && nearestResistance.price > close);
if (!gates.hasTarget) return noSignal(..., "no resistance above price for a target");
const target = nearestResistance.price;   // rigid: target IS the nearest resistance
```

`target = nearestResistance.price` with **no minimum-distance floor and no
fallback** fails on a continuum of one variable — the distance from entry to the
nearest overhead level:

- **Bucket A — ATH breakouts (12 names: NVDA, AVGO, AMD, LLY, GS…).** Price is
  above every detected level → `nearestResistance` is null → rejected outright at
  the `hasTarget` gate. The strongest momentum names are discarded before scoring.
- **Bucket B — resistance-too-close (16 names: KO, WMT, JPM…).** The nearest
  resistance sits a fraction of a percent above entry, so the target is garbage:
  KO target **+18¢**, WMT target **+7¢**. R:R collapses to ~0 (KO 0.078, WMT 0.017)
  → rejected at the R:R gate. These are *garbage targets*, not bad trades.

**Bucket C — `below 200MA` (15 names) is legitimate** downtrend filtering and is
left untouched.

Raw evidence (2026-06-18):

| | entry | old target | distance | stop (1.5×ATR) | old R:R | dies at |
|---|---|---|---|---|---|---|
| NVDA | ~236.5 | *none* | — | 225.1 | — | `hasTarget` (Bucket A) |
| KO | 79.39 | 79.57 | +0.18 (0.12 ATR) | 77.08 | 0.078 | R:R gate (Bucket B) |
| WMT | 117.18 | 117.25 | +0.07 (0.02 ATR) | 112.88 | 0.017 | R:R gate (Bucket B) |

---

## Fix: ATR-projected target with a floor

Replace the rigid resistance target (and the no-resistance rejection) with:

```
projectedTarget   = entry + targetAtrMultiple × ATR
resistanceTarget  = nearestResistance.price   (if present and above entry, else null)
target            = max(resistanceTarget, projectedTarget)   // projection is a FLOOR
```

- **No resistance (ATH breakout)** → `target = projectedTarget`. The name gets a
  real target instead of being rejected. Dissolves **Bucket A**.
- **Resistance closer than the floor** → `target = projectedTarget` floors it.
  No more 18¢ targets. Dissolves **Bucket B**.
- **Resistance comfortably above the floor** → `target = resistanceTarget`,
  exactly as today. Normal mid-range behavior is **unchanged** (regression-safe).

The `hasTarget` rejection is removed. The R:R gate, the 200MA gate, the
news/earnings/regime/correlation gates, the stop logic, the scoring weights, the
threshold, and observe/live mode are all **unchanged**.

### The k-invariant (mandatory — do not break)

`targetAtrMultiple` (k) defaults to **3.0**. This value is **NOT arbitrary**:

```
k = atrStopMultiple × minRiskReward = 1.5 × 2 = 3.0
```

It is the *minimum* multiple that lets a projected target clear the R:R gate.
Because risk is fixed at `atrStopMultiple × ATR`, a projected target yields:

```
R:R = (k × ATR) / (atrStopMultiple × ATR) = k / atrStopMultiple
```

With k = 3.0 and `atrStopMultiple` = 1.5, every floored/projected target produces
**R:R = exactly 2.0 = minRiskReward** — it just clears the gate. Consequences:

- **k below `atrStopMultiple × minRiskReward`** → projected targets fall *below*
  the R:R gate and breakouts get **re-rejected** (the bug returns).
- **k above it** → targets are pushed unnecessarily far (over-extended; more
  timeouts).
- If a human later changes `atrStopMultiple` or `minRiskReward`, **k must move
  too** or the invariant breaks. k stays an explicit config knob (as agreed), but
  the invariant is flagged prominently in the code comment and here.

In code, when `targetAtrMultiple` is absent from config, it **falls back to the
derived invariant** `atrStopMultiple × minRiskReward` — not a magic constant, but
the two existing tunables multiplied. The seed ships `targetAtrMultiple: 3.0`
explicitly.

### Minimum target distance (garbage-target floor)

The target is now always **≥ `targetAtrMultiple × ATR` above entry** (≥ 3×ATR by
default), expressed in ATR units so it self-scales with volatility. The 18¢/7¢
target class is structurally impossible: the minimum R:R any signal can carry is
exactly `minRiskReward` (2.0).

---

## This is PROVISIONAL — it caps winners by design

This is a **provisional unblock**, not the permanent target design. A fixed target
caps winners early — the exact thing a trailing exit is meant to avoid. Its only
job is to stop the structural gate-rejection so real candidates flow and
`gp-outcomes` starts collecting trades. **It is intended to be replaced by the
trailing-exit (Tier 3) engine once we have outcomes to validate against.** The
trailing-exit engine is parked, not cancelled.

### Honest expectation: structural blocker removed, real flow TBD

Passing the gates is **not** the same as opening an outcome. An outcome row opens
**only for a `BUY_CANDIDATE`** — score ≥ `buyScoreThreshold` (53). This fix removes
the structural blocker (strong names are no longer discarded before scoring); how
many outcomes actually open depends on names clearing 53. Reconstructed scores for
the 2026-06-18 worst-case names (two inputs — support strength, sectorStrength —
are not persisted, so bounded; tests pin the exact mechanics):

| | new target | new R:R | targetType | score (reconstructed) | decision |
|---|---|---|---|---|---|
| NVDA | ~259.3 (`entry+3×7.6`) | 2.0 | PROJECTED_ATR | ~65–76 | **BUY_CANDIDATE → outcome opens** |
| KO | 84.01 (`entry+3×1.54`) | 2.0 | RESISTANCE_FLOORED_BY_PROJECTED_ATR | ~51–62 | **borderline** at 53 |
| WMT | 125.79 (`entry+3×2.87`) | 2.0 | RESISTANCE_FLOORED_BY_PROJECTED_ATR | ~39–50 | **NO_SIGNAL** (correctly filtered) |

So roughly **1 of 3** worst-case names opens (NVDA), one is borderline (KO), and
one correctly stays out for a *legitimate scored reason* (WMT — below its 50-MA,
RSI 38), not a garbage target. **Read this as "structural blocker removed, real
candidate flow TBD post-deploy."** If post-deploy flow is too thin, the
`buyScoreThreshold` (53, itself PROVISIONAL) is the **next lever** — a separate
change, explicitly out of scope here.

---

## Result metadata & storage

`score()` returns four new fields (for later target-type behavior analysis):

- `targetType` — `RESISTANCE` | `PROJECTED_ATR` | `RESISTANCE_FLOORED_BY_PROJECTED_ATR`
- `projectedTarget` — `entry + targetAtrMultiple × ATR`
- `resistanceTarget` — raw `nearestResistance.price` (null if none above entry)
- `targetAtrMultiple` — the k actually used

These are carried into both `gp-snapshots` (every scored name) and the
`gp-outcomes` OPEN row (so closed-outcome analysis can segment by `targetType`).
The existing `outcome`/label field and all downstream analytics are untouched.

## Config

`seed/config.json` gains `targetAtrMultiple: 3.0`, read via config like the other
tunables. The live `gp-config` ACTIVE row should be patched with the same value at
deploy (the code falls back to the derived invariant `atrStopMultiple ×
minRiskReward` if it is absent, so a missed patch degrades safely rather than
NO_DATA-ing every name).

## Tests (TDD — written first, confirmed red, then implemented)

1. **No resistance (ATH breakout)** → projected target used, R:R = 2.0, passes,
   `targetType = PROJECTED_ATR`, metadata present.
2. **Resistance closer than 3×ATR** (the critical boundary — a *genuine* chart
   level the floor silently overrides) → `target = entry + 3×ATR`,
   `targetType = RESISTANCE_FLOORED_BY_PROJECTED_ATR`, R:R = 2.0, passes.
3. **Resistance comfortably above projection (>3×ATR)** → real resistance target
   used, `targetType = RESISTANCE` (regression: mid-range behavior unchanged).
4. **Invalid ATR / bad risk** → still rejects (unchanged).
5. **Existing gates behave unchanged** (200MA, R:R, news, earnings, regime,
   correlation) — including: with the invariant **broken** (k below
   `atrStopMultiple × minRiskReward`), a no-resistance breakout is **re-rejected**
   at the R:R gate, proving the gate still fires and documenting the invariant.
6. **Fallback** — config without `targetAtrMultiple` uses the derived invariant.
