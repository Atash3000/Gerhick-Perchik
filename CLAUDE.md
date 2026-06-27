# CLAUDE.md — Gerchik-Perchik

Durable project rules. Read this every session before acting. The detailed
step-by-step build order is at the bottom; everything above it is non-negotiable.

> **Strategy change in progress (read this first).** The project is moving from the
> old per-ticker gate-and-score system (`gp-2.0.0`) to a **momentum portfolio**
> system (`gp-momentum-1.0.0`). The guardrails, infrastructure, secrets, tables, and
> the labeler are **unchanged**. What changes is the _strategy brain_: scoring,
> config tunables, and the scanner's shape (per-signal → ranked portfolio). The full
> spec lives in `docs/Strategy-v1.md`; how we judge it lives in
> `docs/Validation-Scorecard.md`. Implement to those two documents exactly.

---

## What this project is

A disciplined, technical-analysis trading-signal bot. **Once a week** after the US
close it ranks a universe of liquid US stocks by **volatility-adjusted momentum**,
holds the **strongest-trending names** while the market is in an uptrend, sizes each
position by ATR risk so a single loss is small, cuts losers at a volatility stop,
lets winners run, rotates out fading names, and goes to **cash** when the market
turns down. It records a snapshot of every decision and tracks what actually
happened to every position, so the approach is **validated on real, after-cost
outcomes** before any capital is risked.

This is a **separate project** from Edge Hunter (SEC/insider, event driven). It is
technical/price driven. They do not share a stack.

## The one principle that overrides everything

> **Math decides. AI only explains.**

The deterministic momentum score and the portfolio rules produce the signal and
every number. The LLM is used solely to phrase a Telegram message from a locked JSON
payload. The model must never choose a trade, change a number, or invent data.

## The second principle (equally binding)

> **Validation is the judge, not confidence.**

A backtest "looking good," or two models agreeing, is not evidence the strategy makes
money. Nothing goes live until it passes `docs/Validation-Scorecard.md` after costs,
out-of-sample, on a survivorship-free universe. See the survivorship note below.

---

## Stack conventions (match these exactly)

- AWS SAM (`Transform: AWS::Serverless-2016-10-31`).
- Node `nodejs22.x`, ESM (`.mjs`), set in a `Globals` block.
- Functions: `FunctionName: gp-<name>`, `CodeUri: lambdas/<name>/`,
  `Handler: handler.handler`.
- Shared code in `lambdas/shared/`.
- Tags `Project: gerchik-perchik` on every resource.
- Schedules: classic `Type: Schedule`, UTC cron. Runtime on/off via Telegram
  (control Lambda toggles the EventBridge rule), not deploy-time disabling.
- One stack; `sam validate` → `sam build` → `sam deploy` (samconfig.toml).

### Directory layout

```
gerchik-perchik/
  CLAUDE.md  template.yaml  samconfig.toml  package.json
  docs/ Strategy-v1.md  Validation-Scorecard.md
  lambdas/
    scanner/handler.mjs     # weekly rank → portfolio construct/maintain → snapshot → alert
    labeler/handler.mjs     # walk open positions forward, label outcomes (UNCHANGED)
    control/handler.mjs     # Telegram webhook: /start /stop /mode /enable /disable /stats
    shared/ momentum.mjs  scoring.mjs  marketdata.mjs  telegram.mjs  config.mjs  version.mjs
```

---

## Strategy versioning (read before touching scoring)

`shared/version.mjs` exports a single `STRATEGY_VERSION` constant (semver). The
momentum strategy uses `"gp-momentum-1.0.0"`. It is written into **every** snapshot
and outcome record.

- Bump it **only** when the scoring formula or portfolio logic changes, and only on
  explicit human instruction — never silently.
- Outcome analysis must always filter by `strategyVersion`. Win-rates from different
  versions are **not** comparable; never pool them. (Old `gp-2.0.0` outcomes are a
  different strategy's record — they are historical reference, not evidence about the
  momentum strategy. The momentum sample starts at the version bump.)

---

## Secrets & infrastructure — references only, never values

Keys live in SSM. REUSE them; do NOT duplicate or re-enter. The repo references them
by **path**; the Lambdas read them at runtime via `ssm:GetParameter`. AWS access
comes from the local profile.

Data / AI keys:

- `/gerchik/tiingo/api_key` — **DEDICATED premium** Tiingo key (EOD adjusted history
  → MAs/ATR/momentum + the path the labeler walks forward). Premium removes the
  free-tier 500-unique-symbol/month cap. Do NOT use the shared `/edge-hunter/tiingo/api_key`.
- `/edge-hunter/finnhub/api_key` (sector; earnings calendar if needed).
- `/edge-hunter/anthropic/api_key` (narration only).

Telegram — DEDICATED Gerchik-Perchik bot + channel:

- `/gerchik-perchik/telegram/bot_token`
- `/gerchik-perchik/telegram/chat_id`
- `/gerchik-perchik/telegram/webhook_secret` (protects the control Function URL)

**Hard rules:**

- Never fetch (`--with-decryption` to print), print, log, commit, or hardcode a
  secret value. Reference by path only.
- Never request API keys from the user; the local AWS profile authorizes you.
- IAM: grant each Lambda `ssm:GetParameter` on only the specific ARNs it needs.
- Verify reality before assuming: `aws sts get-caller-identity`, `cat samconfig.toml`,
  `aws ssm get-parameters-by-path --path /gerchik --query "Parameters[].Name"`.

---

## Data model — four tables, compound keys, Retain on all

`PAY_PER_REQUEST`. Every table carries `DeletionPolicy: Retain` and
`UpdateReplacePolicy: Retain` — the history and tuned config are the whole point and
must survive a table replacement or stack delete.

- `gp-snapshots` — `pk = TICKER#<ticker>` (S), `sk = <epoch day>` (N). No TTL. Every
  row includes `strategyVersion` and `dataAsOf`. For momentum it stores the
  **momentum score** and its parts (`momentum`, `slope`, `r2`, `rank`, `rankPct`),
  the regime state, eligibility flags, and — for held positions — `entry`, `stop`,
  `peakClose`, `shares`, and the exit reason when closed.
- `gp-outcomes` — `pk = SIGNAL#<ticker>#<entryDate>` (S), `sk = <entry epoch>` (N).
  Includes `strategyVersion`. **Unchanged shape** — the labeler fills it.
- `gp-config` — `pk = "CONFIG"` (S), `sk = "ACTIVE"` (S). One live row of tunables
  (see below). Read at the start of every run; never hardcode in the Lambdas.
- `gp-watchlist` — `pk = TICKER#<ticker>` (S). Fields: `sector`, `enabled`. The
  universe the scanner ranks. (See survivorship note — this is currently
  hand-curated, which biases backtests; a survivorship-free universe is required
  before trusting absolute numbers.)

Every key must be unique per record. Never write two different records under one key
(silent overwrite — do not repeat that class of bug).

---

## Strategy rules (implement in `shared/momentum.mjs` + `shared/scoring.mjs`)

Full detail and rationale: `docs/Strategy-v1.md`. Summary of the binding rules:

- **Data freshness pre-check (before anything else):** the latest bar must be the
  most recent **trading day** (holiday/weekend aware). Stale or short → return
  `NO_DATA`, write nothing, alert nothing. Never score a stale feed as current.
- **Tunables come from `gp-config`,** not code or env. Read the ACTIVE row each run.
- **Regime filter (the one market-level gate):** open new longs **only if SPY closes
  above its 200-day SMA**. If below → no new buys; existing positions managed by
  their exits; the book drifts to **cash**. No shorting.
- **Eligibility (per stock, before ranking):** liquid (price ≥ `minPrice`, 20-day avg
  dollar volume ≥ `minDollarVol`); closes **above its own `trendMa` (100-day) SMA**;
  **no single-day gap ≥ `gapFilterPct` (15%)** in the last `gapFilterWindow` (90)
  days.
- **Momentum score (the number "math decides"):**
  `momentum = annualized_slope( exp_regression( log(price), momentumLookback=90 ) ) × R²`.
  Fit log-price vs day index; annualize the slope; multiply by the regression R².
  Rewards trends that are strong **and** smooth. Higher = better. Always persist
  `momentum`, `slope`, `r2`, and the cross-sectional `rank`/`rankPct`.
- **Portfolio construction (this is a RANKING/PORTFOLIO strategy, not per-name
  signals):** rank all eligible names; buy from the **top `entryRankPct` (20%)** to
  fill open slots up to `targetPositions` (15), hard max `maxPositions` (20).
- **Position sizing — never type a share count:**
  `stop = entry − kStop×ATR20` (`kStop`=2.5);
  `shares = floor( accountSize × riskPctPerTrade / (kStop × ATR20) )`
  (`riskPctPerTrade`=0.75% → a stop-out costs ~0.75% of account).
  Cap any one position at `positionCapPct` (15%) of account. Equal-risk sizing:
  low-vol names get more shares, high-vol fewer.
- **Exits (any one fires; stops checked daily, the rest at the weekly review):**
  hard stop (`entry − kStop×ATR20`); **trailing chandelier** (`peakClose − kStop×ATR20`,
  never lowered, **no fixed profit target** — capping winners kills the few big ones
  the system lives on); **rank exit** (falls below top `exitRankPct` (30%) — hysteresis
  vs the 20% entry to avoid churn); **trend exit** (closes below `trendMa`).
- **Risk governor — circuit breakers, enforced in code, block NEW risk only:**
  weekly drawdown < `−weeklyDdLimit` (8%) → no new buys until next week; monthly
  drawdown < `−monthlyDdLimit` (15%) → no new entries this month; account
  `−maxDdLimit` (25%) from peak → halt all new trading + alert for review. Existing
  positions always keep their stops.
- Validate inputs; on missing/bad data, no-signal, never score garbage. Missing
  fundamentals are neutral, never a hard rejection (there is no fundamental factor in
  v1 — that is the single pre-registered v2 experiment in the Scorecard).

## Outcome labeling (`lambdas/labeler/`) — UNCHANGED, the crown jewel

Reuse exactly as built. First-touch, path-dependent, after-cost. For each open
position, walk every trading day from entry forward (Tiingo history):

```
if day_low  <= stop   -> STOP    (if both hit same day, assume STOP first)
if day_high >= target -> TARGET  (here "target" = the active trailing/exit level)
else after timeout    -> TIMEOUT (exit = last close)
```

- **Pessimistic fills:** stops gap through — exit at the worse of stop vs that day's
  open.
- **Subtract costs:** `profitPct` deducts `feeBps` and `slippageBps` per side. A
  cost-free backtest lies upward.
- Record `outcome`, `exitDate`, `profitPct` (after cost), `daysHeld`, the momentum
  snapshot, the exit reason, `strategyVersion`, and **MFE/MAE** (`mfePct`/`maePct`
  with prices) — these drive stop tuning, not P&L.

---

## Control commands (`lambdas/control/`)

Telegram webhook. One bot; toggle EventBridge rules and the `gp-config` row.

- `/start` `/stop` — enable/disable the scanner schedule.
- `/mode observe|live` — write `alertMode`. **A human only.** The agent must never
  set `alertMode: live`.
- `/enable <ticker>` `/disable <ticker>` — flip `enabled` in `gp-watchlist`.
- `/stats [30d]` — summarize `gp-outcomes` (win-rate, avg R, expectancy, by rank
  bucket), filtered by current `strategyVersion`.

---

## Safety & epistemics (this is a trading tool — be careful)

- **Observe mode is the default.** In `observe`, messages are prefixed
  `📋 OBSERVE — tracking only, not a recommendation` and never say "BUY". Going live
  is a human `/mode live`, never automatic, never something you flip.
- **Validation is the judge.** Thresholds and any tunable are guesses until backed by
  the Scorecard run on accumulated/backtested `gp-outcomes`. Do not tune before there
  is real data.
- Narration prompt is locked: only the provided JSON, invent no numbers, no financial
  advice, "possible setup" not "guaranteed".
- This is not financial advice and the code makes no profitability claim.

## Survivorship & data honesty (do not skip)

- Tiingo premium EOD (adjusted) is fine for the **price** side and for prototyping.
- **The current `gp-watchlist` is hand-curated, present-day names.** Backtesting the
  strategy over it replays today's winners through the past → results are
  **optimistic** (survivorship bias). State this caveat on every backtest output.
- A momentum result is **not trustworthy in absolute terms** until re-run on a
  **survivorship-free universe with point-in-time membership** (e.g. Sharadar). The
  Scorecard's PASS/KILL verdict only counts on such a universe.
- The single pre-registered v2 experiment (a fundamental quality factor) requires
  **point-in-time, as-reported** fundamentals — Tiingo's fundamentals add-on is not a
  clean substitute. Do not add it until v1 passes and that data exists.

## Ops

Emit `gp_scan_failed` on failure; CloudWatch metric filter + alarm → SNS → control
Lambda → Telegram, so sustained failures page you.

**`gp-funnel-report` (PERMANENT daily/weekly dashboard).** READ-ONLY Lambda. Reads
the three tables + config, posts a dashboard to Telegram: universe coverage, regime
state, eligibility funnel, **momentum-rank distribution**, current book + exit
reasons, outcome counts. Owns no writable resource (read-only DynamoDB + Telegram
SSM + Logs). It reports what the scanner produced — changes nothing. Kept feature;
schedule stays ENABLED. `report.mjs` stays a pure, unit-tested function.

---

## Build order (momentum)

```
1  shared/momentum.mjs: exp-regression slope×R² + helpers, reusing marketdata.mjs
   indicators (MAs, ATR20, dollar volume, gap check). Unit-test against a known series.
2  shared/config.mjs: read the new gp-config tunables. shared/version.mjs:
   STRATEGY_VERSION = "gp-momentum-1.0.0" (HUMAN sets this). Unit-test.
3  shared/scoring.mjs → portfolio logic: regime → eligibility → rank → construct/
   maintain book (top N) → ATR sizing → exits. Replaces the old gates+0–100 score.
4  scanner: weekly rank, write snapshots (+ strategyVersion, dataAsOf), open/close
   outcome rows for the book. OBSERVE mode only. Reuse the labeler UNCHANGED.
5  Extend scripts/backtest-*.mjs into a PORTFOLIO backtester (hold N, ATR sizing,
   weekly rotation, circuit breakers) that emits every metric + robustness test in
   docs/Validation-Scorecard.md. Reuse labeling.mjs for after-cost outcomes.
6  Run the backtest over Tiingo history. Output the Scorecard report WITH the
   survivorship caveat. Do NOT trust absolute numbers yet.
7  Re-validate on a survivorship-free universe before any PASS verdict is believed.
8  Keep accumulating in observe mode; human reviews /stats + Scorecard.
9  Human flips /mode live only after a genuine PASS. Never before.
```

Do not skip ahead. Never go live on unvalidated numbers. If anything in
`docs/Strategy-v1.md` is ambiguous, **stop and ask — do not improvise.**

## Do NOT

- Start from or merge into the Edge Hunter repo. This is its own stack.
- Hardcode, print, or commit secret values; hardcode tunables (use gp-config).
- Let the LLM decide trades or alter numbers.
- Set `alertMode: live` or bump `STRATEGY_VERSION` on your own — both are human acts.
- Ship any data table without `Retain`, or two records under one key.
- Score on stale data, label from fixed checkpoints, or report cost-free profit.
- Trust a backtest run only on the hand-curated watchlist as if it were unbiased.
- Add the fundamental quality factor (or any new feature) before v1 has a Scorecard
  verdict — one change at a time, re-validated.
- Send "BUY" or go live before a genuine Scorecard PASS.

---

## Git workflow

- One feature branch per build-order step: `git checkout -b momentum-1-score`.
- Small, working commits. Conventional messages: `feat: … fix: … test: … chore: … docs: …`.
- Before each commit, run `git status` and `git diff` and show the diff. Never commit
  secrets (SSM) or `.gitignore`d files.
- At the end of each step, when tests are green, push the branch, open a small PR for a
  reviewable diff, then **merge and deploy it yourself** (`sam validate` → `sam build`
  → `sam deploy`). Keep PRs small and auditable.
- **Still human-only, never the agent:** setting `alertMode: live`, bumping
  `STRATEGY_VERSION`, and live writes to the `gp-config` trading row.
- Never `git push --force`, never force-push `main`, never rewrite shared history.
- Surface bugs/limitations as GitHub Issues and reference them in the commit/PR
  (`fixes #12`) — don't bury TODOs in code comments.
