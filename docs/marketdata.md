# `shared/marketdata.mjs` — feeds, indicators, levels, freshness

One module, one entry point: `getMarketData(ticker)`. It wraps Tiingo (EOD price
history) and Finnhub (earnings, sector) and returns **exactly** the fields the
scoring function needs — nothing more, nothing the scorer has to massage.

## Secrets

API keys are read at runtime from SSM **by path** and decrypted in memory only:

- `/edge-hunter/tiingo/api_key`
- `/edge-hunter/finnhub/api_key`

Values are cached per warm container and are **never** logged, returned, or
persisted. The keys are account-level Edge Hunter params, reused here.

## Output object

```js
{
  ticker: "MSFT",
  close: 379.40,          // latest adjusted close
  ma50: 412.44,           // SMA(50) of adjusted closes
  ma200: 449.55,          // SMA(200)
  atr: 11.91,             // ATR(14), Wilder/RMA
  rsi: 34.98,             // RSI(14), Wilder/RMA
  volume: 59714157,       // latest adjusted volume
  avgVolume30: 37410237,  // mean of last 30 adjusted volumes
  nearestSupport: null,           // or { price, touches, strength, brokenSupport }
  nearestResistance: { price: 382.52, touches: 2, strength: 0.42, brokenSupport: false },
  daysToEarnings: 39,     // whole days to next earnings, or null if none scheduled
  sector: "Technology",   // Finnhub industry (informational; gate uses watchlist)
  dataAsOf: "2026-06-18",  // date of the latest bar used
  fresh: true
}
```

When the feed is stale or too short, it returns the short shape
`{ ticker, fresh: false, dataAsOf, reason }` instead. It only throws on real I/O
failure (network, bad key), never on staleness — staleness is data, not an error.

## Why adjusted OHLCV

All indicator math and level detection use Tiingo's **split/dividend-adjusted**
series. Over an 18-month window, raw prices would put phantom gaps at split dates
and corrupt historical levels and ATR. The most recent bar's adjusted close equals
its real close (adjustment factor 1 at the latest bar), so the reported `close` is
accurate.

## Indicators (all pure, all exported for testing)

| Field | Definition |
|------|------------|
| `ma50`, `ma200` | Simple moving average of the last N adjusted closes. |
| `atr` | ATR(14), **Wilder/RMA**: seed = mean of the first 14 true ranges, then `ATR = (prevATR·13 + TR)/14`. TR = `max(high−low, |high−prevClose|, |low−prevClose|)`. |
| `rsi` | RSI(14), **Wilder/RMA** smoothing of average gain/loss. Returns 100 when there are no losses. |
| `avgVolume30` | Simple mean of the last 30 adjusted volumes. |

## Support / resistance — swing-pivot fractals (v1)

This is the most consequential modeling choice; it is fully deterministic.

1. **Pivots.** On the last `pivotLookback = 126` daily bars, a **pivot high** is a
   bar whose high strictly exceeds the `pivotWing = 3` bars on each side; a **pivot
   low** is the mirror. (The most recent 3 bars can't be confirmed pivots — by
   design.)
2. **Cluster.** Sort pivots by price and greedily merge neighbours while the gap to
   the running cluster mean is within `min(0.75·ATR, 1.0% of price)`.
3. **Validate.** A cluster needs **≥ 2 touches** to be a level; lone spikes are
   discarded. (3+ touches score stronger.)
4. **Strength (0–1).** A deterministic blend: touches (0.40) + recency (0.25) +
   age-span (0.20) + volume-at-touches (0.15).
5. **Classify vs price.** A level above the close is **resistance**; below is
   **support**. `nearestResistance` is the closest valid level above the close;
   `nearestSupport` the closest below. A former-support level now sitting above
   price is flagged `brokenSupport: true` (it's overhead supply now, not support).

`nearestResistance.price` becomes the trade **target** in scoring;
`nearestSupport` and its `strength`/`touches` feed the **setup** score and the
"near support" test.

## Data freshness — weekend & holiday aware

Before anything is scored, the latest bar must be the most recent **trading day**.

- `isTradingDay(date)` rejects weekends and a static NYSE holiday set (2025–2026;
  extend per year).
- `mostRecentTradingDay(now)` returns the latest trading day whose EOD bar should
  exist: today only if it's a trading day **and** it's past ~18:00 ET (data
  settled), otherwise it walks back over weekends/holidays.
- `fresh = (dataAsOf >= mostRecentTradingDay)`. A stale feed yields `fresh: false`
  → scoring returns `NO_DATA` and the run writes/alerts nothing.

> Example: on Fri 2026-06-19 (Juneteenth, market closed) the most recent trading
> day is Thu 2026-06-18, so a 06-18 bar is correctly treated as fresh.

## Tunable detection parameters

All in the exported `PARAMS` object: `maShort 50`, `maLong 200`, `atrPeriod 14`,
`rsiPeriod 14`, `avgVolumeWindow 30`, `pivotWing 3`, `pivotLookback 126`,
`minTouches 2`. The ATR **stop multiple** is *not* here — it is a `gp-config`
tunable consumed by scoring, not a detection constant.
