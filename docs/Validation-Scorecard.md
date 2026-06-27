# Gerchik-Perchik — Pre-Registered Validation Scorecard

### Status: FINAL (v1.1). No further design passes. The next action is running it, not reviewing it.

### Sign this *before* running the backtest. Its only job is to stop you from negotiating with the results after you see them.

> **Why this exists:** every metric, threshold, and test below is committed in advance. Once you run the backtest you will be tempted to move the goalposts ("well, it *almost* passed", "if I just tighten the exit…"). That temptation is universal and it is exactly how people talk themselves into funding a dead strategy. Pre-registration removes the negotiation. You don't get to redefine "works" after the fact.
>
> This is a research protocol, not financial advice, and it makes no profit claim. Passing means "worth a paper-traded forward test," not "guaranteed money."

---

## 0. The contract

- **What is being tested:** `Gerchik-Perchik Strategy v1`, **exactly as written**, with its frozen parameter table. No changes, no additions, no "quick tweaks" during the run.
- **Data:** Sharadar survivorship-free, **point-in-time** history, after costs (next-day-open fills, ≥0.1% slippage/side, commissions included, pessimistic gap-fills).
- **Benchmark:** SPY buy-and-hold, computed **in the same run, over the same period** (so thresholds are relative to SPY's actual numbers, never stale absolutes).
- **The holdout is sacred:** the window below is **not touched** during any exploration or parameter sweep. It is looked at **once**, last.

---

## 1. Metrics the backtest must report (no cherry-picking)

| # | Metric | Why it's here |
|---|---|---|
| 1 | After-cost **CAGR** | raw return |
| 2 | **Max drawdown** | the real value prop of momentum |
| 3 | **Sharpe** and **Sortino** | risk-adjusted return |
| 4 | **Win rate**, avg win / avg loss, **expectancy/trade**, profit factor | shape of the edge |
| 5 | **Annual turnover** + **average holding period** | the suspected killer |
| 6 | **Total cost drag** (slippage + commissions), as % of gross return | how much the edge is eaten |
| 7 | **% of time in cash** + worst losing streak | behavioral survivability |
| 8 | **Average exposure** + **return per invested dollar** | 10% CAGR at 60% invested ≠ 10% fully invested — it's better |
| 9 | All of 1–8 for **SPY buy-and-hold**, same period | the comparison |

CAGR alone is forbidden as a verdict. Report the whole table or the run doesn't count.

---

## 2. Robustness tests (the ones that catch self-deception)

- **A — Dumb-baseline.** Re-run the ranking with: plain 6-month return, plain 9-month return, plain slope, and slope×R². If slope×R² does **not** beat the best simple metric by a clear margin → delete R², use the simple one. Complexity must earn its place.
- **B — Edge concentration.** Report profit contribution by year and by regime. Then **strip the best 5% / 10% / 20% of months** and recompute. A real edge survives losing its best months; a lucky one evaporates.
- **C — Rebalance-day stability.** Run the entire backtest five times — rebalancing Mon, Tue, Wed, Thu, Fri. The verdict must be the **same across all five**. If the result swings with the weekday, it's a calendar artifact, not an edge.
- **D — Period battery.** Report each stress window separately: **2000–02, 2008–09, Feb–Mar 2020, 2022.** The system must not breach its drawdown limit in any of them (it should be defensive/in cash through the worst).
- **E — Cost sensitivity.** Re-run at **2× the modeled slippage.** If the edge dies, turnover will kill it live.
- **F — Sealed holdout.** **2024-01-01 → present**, untouched until the very end, examined once.
- **G — Ablation (factor decomposition) — the highest-information test.** Re-run the strategy removing **one rule at a time** (no SPY filter / no momentum ranking / no ATR sizing / no risk governor / no trend filter) and tabulate CAGR, drawdown, Sharpe for each. This tells you *which rule actually creates the edge* — far more valuable than more parameter sweeps. **Read on risk-adjusted terms:** removing the risk governor will often *raise* CAGR while wrecking drawdown — that is expected and is **not** a reason to drop it. A component that lowers raw return but slashes drawdown is doing its job.
- **H — Universe robustness.** Re-run on S&P 500 / Russell 1000 / Russell 3000 / all-liquid-US (same survivorship-free, point-in-time discipline). If the edge exists only in the S&P 500, that's information; if it survives across universes, that's strength.
- **I — Monte Carlo (regime-aware only).** Resample to get a *distribution* of CAGR/drawdown rather than one lucky path. **Do NOT use naive bootstrap** — momentum trades cluster in time and are correlated within a regime, so independent resampling gives a falsely tight, falsely reassuring band. Use **block / regime-aware resampling** and read it with suspicion.
- **J — Parameter sensitivity (stability check, NOT optimization).** Sweep the trend MA {80, 90, 100, 110, 120, 150} and confirm the result degrades *gracefully* — if 100 works but 99 and 101 collapse, the system is fragile and you throw it away. **Lock:** you still trade the pre-registered value (100). The sweep is a stability check, never a menu to pick the best from.
- **Allowed exploratory sweeps** (report *all* values, never just the best): position count {10, 15, 20, 25}; exit rule {100-DMA, 150-DMA, ATR-only, chandelier, combination}; bi-weekly resize {on, off}. These inform v2 — they do **not** get retro-fitted into the v1 verdict.

---

## 3. PASS / FAIL thresholds (committed now)

### ✅ PASS — proceed to paper/forward test — requires **ALL** of:

| Criterion | Threshold |
|---|---|
| After-cost CAGR | ≥ SPY CAGR − **2 pts** (need not beat SPY raw; must not be meaningfully worse) |
| Max drawdown | ≤ **0.65 ×** SPY max drawdown (at least **35% shallower** — momentum's whole point is surviving crashes; if it doesn't, there's no advantage) |
| Sortino | **>** SPY Sortino, **and** Sharpe ≥ SPY Sharpe |
| Holdout (§2-F) | OOS CAGR ≥ **0.5 ×** in-sample CAGR, and OOS still beats SPY on risk-adjusted basis |
| Edge concentration (§2-B) | strip best **10%** of months → still positive expectancy & beats cash; strip best **5%** → still beats SPY risk-adjusted |
| Rebalance-day (§2-C) | same verdict on all 5 weekdays; CAGR spread across them ≤ **3 pts** |
| Cost robustness (§2-E) | at 2× slippage: CAGR ≥ SPY − **4 pts** and drawdown still < SPY |
| Simplicity (§2-A) | slope×R² not *worse* than best simple metric; if it wins by < **1.5 pts** CAGR, switch to the simpler metric |

### ❌ KILL — abandon or rebuild — triggered by **ANY** of:

- After-cost CAGR < SPY − 2 pts **and** drawdown not at least **35%** better → no edge worth the complexity, software, taxes, and monitoring.
- Holdout CAGR < 0.5 × in-sample, **or** holdout flips to losing → overfit.
- Stripping the best **10%** of months eliminates the edge → a few lucky windows, not a system.
- Verdict changes with rebalance weekday → calendar artifact.
- Edge disappears at 2× slippage → too thin; turnover/costs will kill it live.
- Ablation (§2-G) shows **removing the momentum ranking barely changes results** → your "momentum edge" was never the source; you're admiring the wrong component.
- Parameter sweep (§2-J) shows the system **collapses one notch off** the chosen value → fragile, discard.

### ⚠️ AMBIGUOUS — it's a *candidate*, not a green light:
Passes some, fails others. **Do not trade real money.** Document exactly which criteria failed, run the **single** v2 experiment (§4), and re-test against this same scorecard. No blending of multiple changes.

---

## 4. The one allowed v2 experiment (logged now so it can't become a moving target)

If — and only if — v1 reaches PASS or a clean AMBIGUOUS, the **first and only** enhancement to test is a **fundamental quality gate** ("momentum says *when*, fundamentals say *what*"):

- Tested as **both** a hard gate (e.g. require positive/growing earnings) **and** a soft tilt (rank-favor quality) — they behave very differently; don't assume the gate.
- On **strictly point-in-time, as-reported (ARQ) fundamentals only.** Restated numbers = look-ahead = a fake edge. This is non-negotiable.
- As a **continuous quality factor**, not inherited round-number cutoffs (20%/20% are O'Neil's folklore, not laws).
- **One change at a time**, re-validated against this entire scorecard. Never bundle.

Everything else raised in review (exposure curves, more regime filters, position-count tuning, exit-rule choice) is already covered by the §2 sweeps or deferred. No new features enter before v1 has a verdict.

---

## 5. Sign-off

```
I commit to the metrics, tests, and thresholds above BEFORE seeing any results.
I will not move these goalposts after the backtest runs.
A PASS earns a paper-traded forward test — not live capital.
Live capital requires a separate, later decision by a human (me), never the bot.

Signed: ______________________      Date: ____________
v1 parameter hash / git SHA: ______________________
```

---

*Validation protocol for research only. Not financial advice; no claim of future profitability. The scorecard prevents self-deception — it does not create an edge. If v1 fails honestly, that is a successful outcome: it saved you the money you would have lost finding out the expensive way.*
