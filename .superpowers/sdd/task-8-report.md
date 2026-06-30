# Task 8 — Runner: empty-bar resilience fix + smoke validation

## Resilience fix — `scripts/backtest/run.mjs`

Two changes were made after the `loadUniverse` calls:

**1. SPY hard-error guard** (after SPY load, ~line 95):
```js
if (!spyRaw || !spyRaw.bars || spyRaw.bars.length === 0) {
  console.error("[ERROR] SPY returned no bars — cannot build calendar/regime/benchmark. Aborting.");
  process.exit(1);
}
```
SPY is required for the calendar, regime filter, and benchmark; an empty result is unrecoverable.

**2. Universe empty-bar filter** (after universe load, replacing inline log):
```js
const emptyBarWarnings = [];
const universe = universeRaw.filter((u) => {
  if (!u.bars || u.bars.length === 0) {
    const msg = `${u.ticker ?? u.symbol ?? "?"}: Tiingo returned no bars — excluded from universe`;
    console.warn(`  [WARN] ${msg}`);
    emptyBarWarnings.push(msg);
    return false;
  }
  return true;
});
console.log(`Loaded ${universeRaw.length} tickers; ${universe.length} with bars (${emptyBarWarnings.length} dropped).`);
```
`emptyBarWarnings` is then merged into the `warnings` array passed to `buildReport`, so dropped tickers appear in the Scorecard artifact's "Data warnings" section.

**Why `data.mjs` was not touched:** the fix is correctly scoped to the runner (Task 8 responsibility). `data.mjs` is a committed pure module; the caller is the right place to handle graceful degradation.

## Subset validation

Command: `node scripts/backtest/run.mjs --limit 8 --since 2015-01-01`
Timing: ~8.5 seconds (all 8 tickers served from warm `.cache/`)
No live Tiingo fetches required.

### Artifact banners + §1 table (from `Scorecard-smoke-2026-06-30T17-15-26-726Z.md`)

```
> **SUBSET SMOKE RUN — limit=8 tickers, since=2015-01-01. NOT a verdict.** ...

> **PRELIMINARY — survivorship-biased, NOT a verdict until step 7.** ...

- git SHA: `84ad7c7`  •  run: 2026-06-30T17:15:26.726Z
- period: 2015-01-02 → 2026-06-29  •  universe: 8 names
- Sharpe/Sortino computed with rf = 0
```

§1 table populated for both strategy and SPY:

| Metric | Strategy | SPY |
|---|---|---|
| After-cost CAGR % | 3.08 | 13.68 |
| Max drawdown % | 6.89 | 33.7 |
| Sharpe (rf=0) | 0.62 | 0.82 |
| # trades | 186 | 1 |
| Final NAV | 141505.39 | 434617.25 |

Coverage block:
```
- full period: 8/8 names had full data over this window.
- 2008-2009: 0/8 names had full data over this window.
- 2020 crash: 8/8 names had full data over this window.
- 2022: 8/8 names had full data over this window.
```

## Files committed

- `scripts/backtest/run.mjs` — new file (runner, ~200 lines)
- `package.json` — adds `"backtest": "node scripts/backtest/run.mjs"` script
- `docs/backtest/Scorecard-smoke-2026-06-30T17-15-26-726Z.md` — fresh subset artifact
- `docs/backtest/Scorecard-smoke-2026-06-30T17-15-26-726Z.json` — JSON counterpart

**Confirmed NOT staged:** `scripts/backtest/.cache/` (gitignored), `docs/Schema-momentum.textClipping` (unrelated), no SSM paths or secrets.

## Concerns

1. **Full step-6 battery is a separate human run.** `npm run backtest` (no flags) over ~199 tickers from 2010 will take minutes and may hit Tiingo live-fetch rate limits. That is build-order step 6 and must be run deliberately by a human after reviewing this subset artifact.

2. **CAGR on 8-name subset is not indicative.** 3.08% strategy vs 13.68% SPY is an artifact of the tiny universe (AAPL, ABBV, ACN, ADBE, AMD, …). With 8 names the ranking/portfolio logic has almost no diversification to work with. Not a concern about the engine; expected for a smoke run.

3. **rf=0 in Sharpe/Sortino.** Both strategy and SPY use rf=0, so the ratio comparison is internally consistent but absolute values are overstated vs a proper risk-free rate. Noted in the artifact header; acceptable for step 5.

4. **Node v20 deprecation warning.** AWS SDK v3 will require Node ≥ 22 after Jan 2027. The SAM template already targets `nodejs22.x`; this affects only local script invocation. Not urgent for this task but worth tracking.
