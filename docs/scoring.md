# `shared/scoring.mjs` — the deterministic engine

> **Math decides.** This function alone produces the signal and every number. It
> is pure: no I/O, no randomness, no clock. Same inputs → same result.

```js
score(marketData, config, marketContext) -> result
```

- `marketData` — the object from `getMarketData()` (or a `fresh:false` shape).
- `config` — the `gp-config` ACTIVE row (tunables), injected; never hardcoded.
- `marketContext` — run-level context the scanner supplies:
  `{ spyBelow200ma, correlatedPositions, newsLevel, fundamentals, sectorStrengthPct }`.
  (`fundamentals` and `sectorStrengthPct`, plus `marketData.rsRank`, feed the
  gp-2.0.0 gradient factors; each is neutral 0 when absent.)

## Pipeline

```
freshness + input validation
        │  (stale / missing / non-finite / non-positive field / missing config → NO_DATA)
        ▼
gates  (reject, don't score — fail any → NO_SIGNAL, full stop)
        ▼
derive  stop / target / R:R
        ▼
score 0–100  with per-component breakdown
        ▼
decision = score >= buyScoreThreshold ? BUY_CANDIDATE : NO_SIGNAL
```

## Decisions

| `decision` | Meaning |
|------------|---------|
| `NO_DATA` | Feed stale or a required field missing/non-finite. Write nothing, score nothing. |
| `NO_SIGNAL` | Either a gate failed (no score), **or** all gates passed but score < threshold (score returned). |
| `BUY_CANDIDATE` | All gates passed and score ≥ `buyScoreThreshold`. |

## Gates (in order — first failure short-circuits)

| Gate | Fails when | Source |
|------|-----------|--------|
| `marketRegime` | `spyBelow200ma` is true | context (SPY vs 200MA) |
| `news` | `newsLevel === "high"` | context |
| `earnings` | `0 ≤ daysToEarnings ≤ 3` | marketdata |
| `trend` | `close ≤ ma200` | marketdata |
| `validRisk` | `entry − stop ≤ 0` (bad ATR) | derived |
| `targetAbovePrice` | `target ≤ entry` | derived |
| `riskReward` | `R:R < minRiskReward` | derived |
| `correlation` | `correlatedPositions ≥ maxCorrelatedPositions` | context + config |

## Derivation — levels are never typed in

```
entry           = close
stop            = entry − atrStopMultiple · ATR        // atrStopMultiple from gp-config (1.5)
projectedTarget = entry + targetAtrMultiple · ATR      // ATR-projected FLOOR (k from gp-config, 3.0)
target          = max(nearestResistance.price (if above entry), projectedTarget)
R:R             = (target − entry) / (entry − stop)
```

R:R is the **result** of entry/stop/target, so it can't be gamed by typing in a
favourable number.

### ATR-projected target floor (PROVISIONAL — caps winners by design)

The target is the **higher** of the nearest overhead resistance and an ATR-projected
floor. `result.targetType` records which won: `RESISTANCE` (real level, far enough
above), `RESISTANCE_FLOORED_BY_PROJECTED_ATR` (real level closer than the floor → floor
wins), or `PROJECTED_ATR` (no resistance above entry, e.g. an all-time-high breakout).

This replaced the old rule (`target = nearestResistance.price`, reject if none), which
discarded the strongest names before scoring — ATH breakouts had no level to anchor to,
and names pressing into a nearby level got garbage ~0%-distance targets (R:R ≈ 0). **It
is a provisional unblock to get real candidates flowing into `gp-outcomes`; it caps
winners by design and is intended to be replaced by the trailing-exit engine once we
have outcomes to validate against.**

**The k-invariant (do NOT break):** `targetAtrMultiple` (k) is **not** arbitrary — it
equals `atrStopMultiple · minRiskReward` (1.5·2 = **3.0**), the minimum that lets a
projected target clear the R:R gate (a projected target gives `R:R = k / atrStopMultiple`,
= 2.0 at k=3.0, exactly `minRiskReward`). Set k **below** that product and breakouts get
re-rejected at the R:R gate (the bug returns); **above** it and targets are over-extended.
If you change `atrStopMultiple` or `minRiskReward`, **change k too**. When `targetAtrMultiple`
is absent from config the code falls back to the derived invariant (not a magic constant).

## Score — 0–100 with breakdown

| Component | Max | How |
|-----------|----:|-----|
| `empiricalEdge` | 15 | **Fixed neutral midpoint 7.5** until real `gp-outcomes` data fills it (Phase 8). |
| `setup` | 20 | Near support (≤ `min(3%, 1·ATR)` → +8; ≤ 2× that → +4) + level strength (`round(6·strength)`) + reward room (`round(6·clamp((R:R−minRR)/2,0,1))`). Broken/absent support contributes 0. |
| `trend` | 15 | `close>ma200` (+5), `close>ma50` (+5), `ma50>ma200` (+5). |
| `momentum` | 10 | RSI 50–65 → 10; else within 40–70 → 6; 30–40 or 70–75 → 3; else 0. |
| `volume` | 8 | `vol/avgVolume30`: 1–2× → 8; 2–3× → 6; 0.7–1× → 5; >3× → 3; thin → 2. |
| `news` | 2 | none/low → 2; medium → 1; high → 0 (also gated). |
| `rsRank` | 12 | Smooth gradient over the cross-sectional RS percentile: `round(12·clamp(rsRank,1,99)/99)`. Missing → 0 (never a reject). Coarse at ~43 names by design. |
| `growthQuality` | 13 | ONE component from EPS + revenue quarterly YoY (correlated → combined). Clamp each to ±100%, average whichever present, ramp `round(13·clamp(avg,0,50)/50)` (full at +50%). Both missing → 0. |
| `sectorStrength` | 5 | Gradient over the sector's RS percentile (mean `rsRaw` per sector, ranked across sectors; sectors with <3 names → null). `round(5·clamp(pct,1,99)/99)`. Missing/undersized → 0. |

> **Ceiling is 92.5, not 100** right now, because `empiricalEdge` is pinned at its
> neutral midpoint 7.5/15 until outcomes exist. `buyScoreThreshold` is **provisional
> 53** — a PROVISIONAL mechanical re-center for the gp-2.0.0 `empiricalEdge` 15→7.5
> shift (a flat −7.5/name), **NOT outcome tuning and NOT validated**: it was derived
> against ZERO actual candidates (the only scan day on record had all 43 names
> gate-rejected). Phase B must recalibrate it against real gp-2.0.0 candidates across
> varied market days. The threshold and the weights are **not** to be tuned from
> outcomes before Phase 8 has real data.

## Result shape

```js
{
  ticker, decision, reason,
  strategyVersion, dataAsOf,
  score,                       // number (2dp), or null when a gate rejected pre-score
  breakdown,                   // { empiricalEdge, setup, trend, momentum, volume, news,
                               //   rsRank, growthQuality, sectorStrength } or null
                               // — always sums to `score`.
  entry, stop, target, riskReward,
  targetType,                  // RESISTANCE | PROJECTED_ATR | RESISTANCE_FLOORED_BY_PROJECTED_ATR
  projectedTarget,             // entry + targetAtrMultiple·ATR (the floor)
  resistanceTarget,            // raw nearestResistance.price, or null if none above entry
  targetAtrMultiple,           // the k actually used (config, or derived invariant fallback)
  gates                        // { gateName: boolean, … } or null on NO_DATA
}
```

`strategyVersion` is stamped on every result (and, later, every snapshot/outcome).
Outcome analysis must always filter by it — win-rates from different versions are
not comparable.

## Worked example (unit-tested)

`close 100, ma50 95, ma200 90, atr 2, rsi 58`, support `{98, strength 0.6}`,
resistance `{110}`, `rsRank 88`, clean context with `fundamentals {epsGrowthQtr 40,
salesGrowthQtr 30}` and `sectorStrengthPct 75`, `atrStopMultiple 1.5, minRiskReward 2`:

- `stop = 100 − 1.5·2 = 97`, `target = 110`, `R:R = 10/3 = 3.333`.
- breakdown `{ empiricalEdge 7.5, setup 16, trend 15, momentum 10, volume 8, news 2,
  rsRank 10.67, growthQuality 9.1, sectorStrength 3.79 } = 82.06`.
- 82.06 ≥ 53 → **BUY_CANDIDATE**.
