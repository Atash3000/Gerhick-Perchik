# Gerchik-Perchik — The Strategy (v1)

### A momentum engine wrapped in a hard risk governor. Simple, mechanical, and built to be *tested* before a cent is risked.

> **The thesis in one sentence:** In an up-market, own the handful of strongest, smoothest-trending liquid US stocks; size each position so a single loss is small; cut losers at a volatility-based stop; let winners run; rotate out of fading names weekly; go to cash when the market turns down.
>
> **Honesty up front:** This is the simplest rule set with a *documented, real* edge (volatility-adjusted momentum + strict risk control). "Real" does not mean "large" or "guaranteed" — published versions roughly match the index on raw return with lower drawdown, and have losing stretches. Whether *this* version makes money after costs is what the backtest decides. Every rule below is frozen and pre-registered so we can't fool ourselves by twiddling knobs. Not financial advice; no profit claim.

---

## 1. Universe (what we're allowed to trade)

- **Start:** S&P 500 constituents, using **point-in-time membership** (a stock counts only if it was in the index on that historical date — no survivorship cheating).
- **Liquidity gate:** price ≥ **$5** and 20-day average dollar volume ≥ **$10M**. (Keeps fills realistic; no untradeable garbage.)
- *Expandable later* to a broader liquid US universe; start narrow and clean.

## 2. Regime filter (are we allowed to buy at all?)

- **Open new longs only if SPY closes above its 200-day SMA.**
- If SPY is below its 200-day SMA → **no new buys.** Existing positions are managed by their exits (Sections 4–5) and the portfolio drifts to **cash**. No shorting.

## 3. The weekly BUY signal (entry)

Once per week, on a **fixed day** (pick one, e.g. the first trading day of the week — the choice is arbitrary, just keep it fixed). A stock is an **eligible candidate** only if all hold:

1. Passes the universe + liquidity gate (§1).
2. The market regime is risk-on (§2).
3. The stock closes **above its own 100-day SMA** (it's in its own uptrend).
4. The stock has had **no single-day gap ≥ 15%** in the last 90 days (avoids unstable, news-whipsawed names).

**Rank** every eligible candidate by the **momentum score**:

```
momentum = annualized_slope( exponential_regression(price, 90 days) ) × R²
```

- Fit a least-squares line to **log(price)** over the last **90 trading days**; annualize the slope; multiply by the regression's **R²**.
- This rewards trends that are **strong *and* smooth** — a steep but choppy chart scores lower than a steady climber. Higher = better.

**Buy** from the **top of the ranking** (top 20% of the universe) until the portfolio holds the target number of positions (§4). Skip everything else.

## 4. Position sizing (the part that prevents blow-ups)

Risk a **fixed small fraction of the account per trade**, sized by the stock's own volatility:

```
initial_stop  = entry − (k_stop × ATR20)          # k_stop = 2.5
shares        = floor( (AccountValue × RiskPerTrade) / (k_stop × ATR20) )
RiskPerTrade  = 0.75%   →  if the stop is hit, you lose ~0.75% of the account
```

- `ATR20` = 20-day Average True Range. Low-volatility names get more shares, high-volatility names fewer — **equal risk per position**.
- **Concentration cap:** no single position may exceed **15%** of account value, regardless of the formula.
- **Target positions:** **15** (hard max **20**). Unallocated capital stays in cash.

## 5. Exits (cut losers, let winners run, rotate out the fading)

A position is closed when **any** of these fires — checked at each weekly review, stops checked daily:

- **Hard stop (cut the loser):** price hits `entry − 2.5×ATR20`. This is the catastrophe floor.
- **Trailing stop (let the winner run):** once the position is up, trail the stop at **`peak_close − 2.5×ATR20`** (a chandelier exit). Never lower the stop. **No fixed profit target** — capping winners at +30% would kill the rare big winners the whole system depends on.
- **Rank exit (rotate):** sell if the stock falls **out of the top 30%** of the momentum ranking (hysteresis: enter in the top 20%, only exit below the top 30%, to avoid churn).
- **Trend exit:** sell if the stock closes **below its 100-day SMA**.

## 6. Risk governor (Gerchik's circuit breakers — hard, non-overridable)

Enforced in code; the bot **cannot** trade through these:

- **Per trade:** ~0.75% of account (built into §4 sizing).
- **Weekly:** if account drawdown in a week exceeds **−8%**, stop opening new positions until next week.
- **Monthly:** if drawdown in a month exceeds **−15%**, halt all new entries for the rest of the month.
- **Catastrophic:** if account is down **−25% from its peak**, halt all new trading and trigger a full review.

Existing positions always keep their stops; the governor only blocks *new* risk. This is Gerchik's "risk-manager that blocks you from yourself," made mechanical.

## 7. The weekly loop (the whole system, in order)

```
Every week, on the fixed day:
  1. Update SPY 200-day SMA → set regime (risk-on / risk-off).
  2. For every holding: apply exits (§5) — hard stop, trail, rank, trend. Sell those that fire.
  3. Check the risk governor (§6). If a breaker is tripped → skip buying, manage only.
  4. If risk-on and breakers clear:
        a. Rank eligible candidates by momentum (§3).
        b. Fill open slots (up to 15 positions) from the top of the ranking.
        c. Size each new buy by ATR (§4); place its initial stop.
  5. Re-size existing positions toward target risk (§4) every 2nd week.
Daily (between reviews): only the hard/trailing stops are live. Otherwise do nothing.
```

That's the entire strategy. It's a once-a-week job.

## 8. Parameters (frozen — pre-register before testing)

| Parameter | Default | Meaning |
|---|---|---|
| Regime MA | 200-day SMA on SPY | risk-on/off switch |
| Trend MA | 100-day SMA on stock | stock uptrend filter |
| Momentum lookback | 90 trading days | exp-regression window |
| Gap filter | 15% / 90 days | exclude unstable names |
| Entry rank | top 20% | buy threshold |
| Exit rank | below top 30% | sell threshold (hysteresis) |
| ATR period | 20 days | volatility measure |
| Stop multiple `k_stop` | 2.5 × ATR | stop distance |
| Risk per trade | 0.75% | account risk per position |
| Target positions | 15 (max 20) | portfolio size |
| Position cap | 15% | concentration limit |
| Weekly / monthly / max DD | 8% / 15% / 25% | circuit breakers |

**Rule:** these are fixed before backtesting. Any change is a new strategy version, re-tested from scratch — no fitting the numbers to the history.

## 9. Costs (so the backtest tells the truth)

Model every trade with: **next-day-open fills** after the weekly signal (no same-bar magic), **slippage ≈ 0.1% per side**, and commissions (≈$0 at modern brokers, but include them). Pessimistic gap-fills on stops. This is the after-cost discipline the existing labeler already enforces — keep it.

## 10. How we prove it "works" (before any real money)

1. **Backfill** this exact rule set over Sharadar's survivorship-free, point-in-time history (decades), after costs.
2. Report: **CAGR, max drawdown, win rate, average win vs average loss, expectancy per trade, % of time in cash, worst losing streak**, and risk-adjusted comparison vs buy-and-hold SPY.
3. **Walk-forward** + a **sealed holdout** (the most recent ~18–24 months, never touched during tuning). It must hold there too.
4. **Forward-observe** in paper/observe mode for a pre-committed window before live capital — confirm live-forward results resemble the backtest.
5. Go live only if it survives all of the above. A human flips the switch; the bot never does.

## 11. Why this is "simple yet powerful" — and the honest expectation

**Simple:** ~10 rules, one weekly decision, no AI, no similarity engine, no data lake required to start. It maps directly onto your existing scanner/gates/scoring/labeler — the gates are §1–3, the score is the momentum rank, the labeler already does §9.

**Powerful — in the only sense that's real:** the momentum effect it harvests has persisted across decades and markets, and the risk governor is what separates traders who survive from those who don't. The "power" is *positive expectancy × disciplined survival × compounding over many trades* — not big wins on single picks.

**The honest expectation:** a good outcome looks like **beating buy-and-hold on a risk-adjusted basis** (similar or modestly better returns, meaningfully smaller drawdowns, lots of time safely in cash), with a **low-ish win rate carried by a few big winners** and real flat/losing stretches you must sit through. The dominant risk is not that it crashes — it's that, after costs, the edge is too small to matter. That is precisely why §10 exists: to find out cheaply, before you fund it.

**What this is not:** a day-trading system, a "next-Nvidia" finder, or a guarantee. It is a disciplined swing/position momentum system with a real, modest, *testable* edge — the kind of thing that actually makes money for people who follow it without flinching.

---

*Strategy specification for research and backtesting. Not financial advice and makes no claim of future profitability. Every figure must be re-validated against your own after-cost backtest before any capital is committed.*
