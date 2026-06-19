# `shared/scoring.mjs` — the deterministic engine

> **Math decides.** This function alone produces the signal and every number. It
> is pure: no I/O, no randomness, no clock. Same inputs → same result.

```js
score(marketData, config, marketContext) -> result
```

- `marketData` — the object from `getMarketData()` (or a `fresh:false` shape).
- `config` — the `gp-config` ACTIVE row (tunables), injected; never hardcoded.
- `marketContext` — run-level context the scanner supplies:
  `{ spyBelow200ma, correlatedPositions, newsLevel }`.

## Pipeline

```
freshness + input validation
        │  (stale / missing / non-finite → NO_DATA, nothing scored)
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
| `hasTarget` | no resistance above price | marketdata |
| `validRisk` | `entry − stop ≤ 0` (bad ATR) | derived |
| `targetAbovePrice` | `target ≤ entry` | derived |
| `riskReward` | `R:R < minRiskReward` | derived |
| `correlation` | `correlatedPositions ≥ maxCorrelatedPositions` | context + config |

## Derivation — levels are never typed in

```
entry  = close
stop   = entry − atrStopMultiple · ATR     // atrStopMultiple from gp-config (v1: 1.5)
target = nearestResistance.price           // a real level, not a guess
R:R    = (target − entry) / (entry − stop)
```

R:R is the **result** of entry/stop/target, so it can't be gamed by typing in a
favourable number.

## Score — 0–100 with breakdown

| Component | Max | How |
|-----------|----:|-----|
| `empiricalEdge` | 30 | **Fixed neutral 15** until real `gp-outcomes` data fills it (Phase 8). |
| `trend` | 20 | `close>ma200` (+6), `close>ma50` (+7), `ma50>ma200` (+7). |
| `setup` | 20 | Near support (≤ `min(3%, 1·ATR)` → +8; ≤ 2× that → +4) + level strength (`round(6·strength)`) + reward room (`round(6·clamp((R:R−minRR)/2,0,1))`). Broken/absent support contributes 0. |
| `momentum` | 15 | RSI 50–65 → 15; else within 40–70 → 9; 30–40 or 70–75 → 4; else 0. |
| `volume` | 10 | `vol/avgVolume30`: 1–2× → 10; 2–3× → 7; 0.7–1× → 6; >3× → 4; thin → 3. |
| `news` | 5 | none/low → 5; medium → 2; high → 0 (also gated). |

> **Ceiling is 85, not 100** right now, because `empiricalEdge` is pinned at 15/30
> until outcomes exist. `buyScoreThreshold` (provisional 60) must be read with that
> in mind. The threshold and the weights are **not** to be tuned before Phase 8 has
> real data.

## Result shape

```js
{
  ticker, decision, reason,
  strategyVersion, dataAsOf,
  score,                       // number, or null when a gate rejected pre-score
  breakdown,                   // { empiricalEdge, trend, setup, momentum, volume, news } or null
  entry, stop, target, riskReward,
  gates                        // { gateName: boolean, … } or null on NO_DATA
}
```

`strategyVersion` is stamped on every result (and, later, every snapshot/outcome).
Outcome analysis must always filter by it — win-rates from different versions are
not comparable.

## Worked example (unit-tested)

`close 100, ma50 95, ma200 90, atr 2, rsi 58`, support `{98, strength 0.6}`,
resistance `{110}`, clean context, `atrStopMultiple 1.5, minRiskReward 2`:

- `stop = 100 − 1.5·2 = 97`, `target = 110`, `R:R = 10/3 = 3.333`.
- breakdown `{ empiricalEdge 15, trend 20, setup 16, momentum 15, volume 10, news 5 } = 81`.
- 81 ≥ 60 → **BUY_CANDIDATE**.
