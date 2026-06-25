# Snapshot Table Schema

`gp-snapshots` stores one daily scanner row per successfully scored enabled
watchlist ticker. It is the main research table for funnel analysis, Phase 8
tuning, and future backtests.

The authoritative writer is `lambdas/shared/store.mjs`:

- `writeSnapshot()` builds the DynamoDB item.
- `snapshotMetrics()` builds the nested `metrics` block.

## Write Rules

Table: `gp-snapshots`

Keys:

| Field | Type | Meaning |
|-------|------|---------|
| `pk` | string | `TICKER#<ticker>` |
| `sk` | number | `epochDay(dataAsOf)`, whole UTC days since Unix epoch |

Write behavior:

- One row per ticker per trading day.
- A same-day scanner re-run overwrites the same `pk`/`sk`.
- Snapshots are written after scoring, not only for candidates.
- `BUY_CANDIDATE`, `NO_SIGNAL`, and `NO_DATA` results can all be snapshotted.
- A ticker whose data fetch throws before scoring is counted as `ERROR` for ops
  and still gets a `NO_DATA` snapshot with a `fetch error: ...` reason.
- Disabled watchlist tickers are not scanned and do not get snapshots.

## Top-Level Fields

| Field | Type | Source | Notes |
|-------|------|--------|-------|
| `pk` | string | store | `TICKER#<ticker>` |
| `sk` | number | store | `epochDay(day)` |
| `ticker` | string | score result | Ticker symbol |
| `dataAsOf` | string | market data / scan fallback | Trading day, `YYYY-MM-DD` |
| `strategyVersion` | string | `STRATEGY_VERSION` | Example: `gp-2.0.0` |
| `decision` | string | scoring | `BUY_CANDIDATE`, `NO_SIGNAL`, or `NO_DATA` |
| `reason` | string/null | scoring | Human-readable deterministic reason |
| `score` | number/null | scoring | 0-100 score when reached scoring; null before scoring |
| `breakdown` | object/null | scoring | Score component object; see below |
| `entry` | number/null | scoring | Rounded entry price; normally current close |
| `stop` | number/null | scoring | Rounded ATR stop |
| `target` | number/null | scoring | Rounded target |
| `riskReward` | number/null | scoring | `(target - entry) / (entry - stop)` |
| `riskPerShare` | number/null | store | `entry - stop`, rounded 2 decimals |
| `rewardPerShare` | number/null | store | `target - entry`, rounded 2 decimals |
| `sectorStrengthPct` | number/null | scanner | Raw sector percentile input, not score points |
| `targetType` | string/null | scoring | `RESISTANCE`, `PROJECTED_ATR`, or `RESISTANCE_FLOORED_BY_PROJECTED_ATR` |
| `projectedTarget` | number/null | scoring | ATR-projected target floor |
| `resistanceTarget` | number/null | scoring | Nearest resistance target if available |
| `targetAtrMultiple` | number/null | scoring/config | Usually `atrStopMultiple * minRiskReward` when not explicitly configured |
| `gates` | object/null | scoring | Gate pass/fail object; see below |
| `metrics` | object | store | Raw/capture metrics; see below |
| `fundamentals` | object/null | fundamentals | Finnhub basic-financials capture; see below |
| `spy` | object/null | scanner | SPY context for the scan day; see below |
| `sector` | string/null | watchlist | Sector from `gp-watchlist` |
| `scannedAt` | string | store | ISO timestamp of the snapshot write |

`sizing` is computed by scoring when account sizing config exists, but it is not
currently stored on `gp-snapshots`.

## `breakdown`

Present after all gates pass and scoring is reached. Null for pre-score
rejections and `NO_DATA`.

| Field | Type | Max Points | Meaning |
|-------|------|------------|---------|
| `empiricalEdge` | number | 15 | Currently fixed neutral midpoint, `7.5` |
| `setup` | number | 20 | Support proximity, level strength, reward room |
| `trend` | number | 15 | Close above 200MA, close above 50MA, 50MA above 200MA |
| `momentum` | number | 10 | RSI bucket score |
| `volume` | number | 8 | Current volume vs 30-day average |
| `news` | number | 2 | News severity score |
| `rsRank` | number | 12 | Cross-sectional RS percentile converted to points |
| `growthQuality` | number | 13 | EPS/revenue growth score |
| `sectorStrength` | number | 5 | Sector-strength percentile converted to points |

The top-level `score` is the rounded sum of these fields.

## `gates`

`gates` records deterministic pass/fail state. It may be partial because scoring
returns immediately on the first failed gate.

| Field | Type | Meaning |
|-------|------|---------|
| `marketRegime` | boolean | SPY is not below its 200MA |
| `news` | boolean | News severity is not high |
| `earnings` | boolean | Earnings are not within the configured blocked window |
| `trend` | boolean | Ticker close is above 200MA |
| `validRisk` | boolean | ATR stop produces positive per-share risk |
| `targetAbovePrice` | boolean | Derived target is above entry |
| `riskReward` | boolean | R:R meets `minRiskReward` |
| `correlation` | boolean | Current same-sector open outcomes are below cap |

Examples:

- If `marketRegime` fails, `gates` may only contain `marketRegime: false`.
- If all gates pass but score is below threshold, all gate fields should be true.

## `metrics`

`metrics` is built from the market-data object and is stored for every snapshot,
including `NO_SIGNAL` rows. Missing values are stored as `null`, not `undefined`.

| Field | Type | Meaning |
|-------|------|---------|
| `rsi` | number/null | RSI(14), rounded 2 decimals |
| `ma50` | number/null | 50-day simple moving average, rounded 2 decimals |
| `ma150` | number/null | 150-day simple moving average, rounded 2 decimals |
| `ma200` | number/null | 200-day simple moving average, rounded 2 decimals |
| `ma200SlopePct` | number/null | 200MA slope percent |
| `atr` | number/null | ATR(14), rounded 2 decimals |
| `volume` | number/null | Latest daily volume |
| `avgVolume30` | number/null | 30-day average volume |
| `volumeRatio` | number/null | `volume / avgVolume30`, rounded 2 decimals |
| `high20d` | number/null | Prior 20-day high input |
| `high55d` | number/null | Prior 55-day high input |
| `return21d` | number/null | 21-trading-day return percent |
| `return63d` | number/null | 63-trading-day return percent |
| `return126d` | number/null | 126-trading-day return percent |
| `return252d` | number/null | 252-trading-day return percent |
| `rsRaw` | number/null | `2 * return63d + return126d + return252d` |
| `rsRank` | number/null | Cross-sectional percentile rank of `rsRaw`, 1-99 |
| `rsVsSpy` | number/null | Back-compat alias for `rs126VsSpy` |
| `rs21VsSpy` | number/null | `return21d - spy.return21d` |
| `rs63VsSpy` | number/null | `return63d - spy.return63d` |
| `rs126VsSpy` | number/null | `return126d - spy.return126d` |
| `rs252VsSpy` | number/null | `return252d - spy.return252d` |
| `nearestSupport` | object/null | Full support level; see below |
| `nearestResistance` | object/null | Full resistance level; see below |
| `daysToEarnings` | number/null | Calendar days to next earnings, null when unknown |
| `minerviniAligned` | boolean/null | `ma50 > ma150 > ma200` when all inputs exist |
| `ma200Rising` | boolean/null | `ma200SlopePct > 0` when input exists |
| `breakout20` | boolean/null | `close > high20d` when inputs exist |
| `breakout55` | boolean/null | `close > high55d` when inputs exist |
| `distanceToSupportAtr` | number/null | `(close - nearestSupport.price) / atr`, rounded 3 decimals |
| `distanceToResistanceAtr` | number/null | `(nearestResistance.price - close) / atr`, rounded 3 decimals |

## Level Object

Used by `metrics.nearestSupport` and `metrics.nearestResistance`.

| Field | Type | Meaning |
|-------|------|---------|
| `price` | number | Level price, rounded 2 decimals |
| `touches` | number/null | Number of clustered pivot touches |
| `strength` | number/null | Level strength score, rounded 4 decimals |
| `brokenSupport` | boolean/null | Whether a prior support was broken |

Older rows may have stored only a scalar support/resistance price before full
level persistence was added. New rows store the object above.

## `fundamentals`

Best-effort Finnhub capture from `/stock/metric`. Fetch failures return the same
shape with null values, so a fundamentals outage should not block a scan.

| Field | Type | Meaning |
|-------|------|---------|
| `epsGrowthQtr` | number/null | Quarterly EPS growth YoY percent |
| `salesGrowthQtr` | number/null | Quarterly revenue growth YoY percent |
| `annualEpsGrowth` | number/null | TTM YoY EPS growth or 3-year EPS growth fallback |
| `epsGrowth5Y` | number/null | 5-year EPS growth |
| `salesGrowth5Y` | number/null | 5-year revenue growth |
| `grossMarginTTM` | number/null | Gross margin TTM or annual fallback |
| `roeTTM` | number/null | ROE TTM or fiscal-year fallback |
| `debtToEquity` | number/null | Debt-to-equity ratio |

## `spy`

Capture-only SPY context, same for every snapshot in a scan day. It is used for
future regime-conditioned analysis and relative-strength-vs-market research.

| Field | Type | Meaning |
|-------|------|---------|
| `close` | number/null | SPY close |
| `ma50` | number/null | SPY 50-day moving average |
| `ma200` | number/null | SPY 200-day moving average |
| `rsi` | number/null | SPY RSI(14) |
| `return21d` | number/null | SPY 21-trading-day return percent |
| `return63d` | number/null | SPY 63-trading-day return percent |
| `return126d` | number/null | SPY 126-trading-day return percent |
| `return252d` | number/null | SPY 252-trading-day return percent |
| `above50` | boolean/null | `close > ma50` when both inputs exist |
| `above200` | boolean/null | `close > ma200` when both inputs exist |

## Current Gaps

These values are useful but are not currently stored on snapshots:

- `sizing` from scoring.
- `close` itself as `metrics.close`; entry duplicates close only for rows that
  reach level derivation, but early gate rejections may have `entry: null`.
- `avgDollarVolume30` / explicit liquidity fields.
- Raw `newsLevel`; only the `news` gate and score are stored.
