# CLAUDE.md — Gerchik-Perchik

Durable project rules. Read this every session before acting. The detailed
step-by-step build order is at the bottom; everything above it is non-negotiable.

---

## What this project is

A disciplined, technical-analysis trading-signal bot. It scans a watchlist once a
day after the US close, scores each name 0–100 on price action (trend, levels,
ATR-based risk/reward, volume, news), records a snapshot, and — for qualifying
setups — sends a Telegram message. It then tracks what actually happened to every
signal so the scoring can be tuned from real outcomes instead of guesses.

This is a **separate project** from Edge Hunter (SEC/insider, event driven). It is
technical/price driven. They do not share a stack.

## The one principle that overrides everything

> **Math decides. AI only explains.**

The deterministic scoring function produces the signal and every number. The LLM
is used solely to phrase a Telegram message from a locked JSON payload. The model
must never choose a trade, change a number, or invent data.

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
  lambdas/
    scanner/handler.mjs     # daily scan: score, snapshot, alert
    labeler/handler.mjs     # walk open signals forward, label outcomes
    control/handler.mjs     # Telegram webhook: /start /stop /mode /enable /disable /stats
    shared/ scoring.mjs  marketdata.mjs  telegram.mjs  config.mjs  version.mjs
```

---

## Strategy versioning (read before touching scoring)

`shared/version.mjs` exports a single `STRATEGY_VERSION` constant (semver,
e.g. `"gp-2.0.0"`). It is written into **every** snapshot and outcome record.

- Bump it **only** when the scoring formula or level/derivation logic changes,
  and only on explicit human instruction — never silently.
- Outcome analysis must always filter by `strategyVersion`. Win-rates from
  different versions are not comparable; never pool them.

---

## Secrets & infrastructure — references only, never values

Keys already exist in SSM under `/edge-hunter/*` (account-level resources — any
Lambda with IAM read access can use them). REUSE them; do NOT duplicate or
re-enter keys. The repo references them by **path**; the Lambdas read them at
runtime via `ssm:GetParameter`. AWS access comes from the local profile.

Data / AI keys — reuse the existing Edge Hunter params:

- `/gerchik/tiingo/api_key` — **DEDICATED premium** Tiingo key (EOD history → MA/ATR/RSI + path for labeling). Premium removes the free-tier 500-unique-symbol/month cap. Do NOT use the shared `/edge-hunter/tiingo/api_key` (free, capped, starved by Edge Hunter's universe).
- `/edge-hunter/finnhub/api_key` (quotes, earnings calendar)
- `/edge-hunter/anthropic/api_key` (narration — Phase 6)

Telegram — DEDICATED Gerchik-Perchik bot + channel (separate from Edge Hunter, so
technical alerts don't land in the Edge Hunter feed):

- `/gerchik-perchik/telegram/bot_token`
- `/gerchik-perchik/telegram/chat_id`
- `/gerchik-perchik/telegram/webhook_secret` (protects the control Function URL)

**Hard rules:**

- Never fetch (`--with-decryption` to print), print, log, commit, or hardcode a
  secret value. Reference by path only.
- Never request API keys from the user; the local AWS profile authorizes you.
- IAM: grant each Lambda `ssm:GetParameter` on only the specific
  `/edge-hunter/*` and `/gerchik-perchik/telegram/*` ARNs it needs.
- Verify reality before assuming: `aws sts get-caller-identity`,
  `cat samconfig.toml`,
  `aws ssm get-parameters-by-path --path /edge-hunter --query "Parameters[].Name"`.

---

## Data model — four tables, compound keys, Retain on all

`PAY_PER_REQUEST`. Every table carries `DeletionPolicy: Retain` and
`UpdateReplacePolicy: Retain` — the history and the tuned config are the whole
point of this project and must survive a table replacement or stack delete.

- `gp-snapshots` — `pk = TICKER#<ticker>` (S), `sk = <epoch day>` (N). No TTL.
  Every row includes `strategyVersion` and `dataAsOf` (the date of the latest
  bar used).
- `gp-outcomes` — `pk = SIGNAL#<ticker>#<entryDate>` (S), `sk = <entry epoch>` (N).
  Includes `strategyVersion`.
- `gp-config` — `pk = "CONFIG"` (S), `sk = "ACTIVE"` (S). One live row holding
  tunables: `buyScoreThreshold`, `atrStopMultiple`, `minRiskReward`,
  `targetAtrMultiple`, `maxCorrelatedPositions`, `alertMode`, `feeBps`,
  `slippageBps`, `timeoutTradingDays`, `accountSize`, `riskPctPerTrade`. Read at the
  start of every run; never hardcode these in the Lambdas. **`targetAtrMultiple` (k)
  carries an invariant: `k = atrStopMultiple × minRiskReward` (1.5×2 = 3.0). Change
  one, change all three** — see the scoring rules below.
- `gp-watchlist` — `pk = TICKER#<ticker>` (S). Fields: `sector`, `enabled`,
  `qualityTier`. The scanner only scans `enabled: true` rows. `sector` feeds the
  correlation gate.

Every key must be unique per record. Never write two different records under one
key (that silently overwrites — do not repeat that class of bug).

---

## Scoring rules (implement in `shared/scoring.mjs`)

- **Data freshness pre-check (before anything else):** the latest bar must be the
  most recent **trading day** (holiday/weekend aware — do not just compare to
  "yesterday"). If data is stale or incomplete → return `NO_DATA`, write nothing,
  alert nothing. A stale feed must never be scored as if current.
- **Tunables come from `gp-config`,** not from code or env. Read the ACTIVE row
  each run.
- **Gates first — reject, don't score:** price > 200MA; R:R ≥ `minRiskReward`;
  target above price; no HIGH news; earnings not within 3 days; SPY not below
  200MA; correlated-position cap (`maxCorrelatedPositions`, by `sector`);
  **liquidity** (tradability filter — `close ≥ minPrice` AND average DOLLAR volume
  `close × avgVolume30 ≥ minAvgDollarVolume30`; code defaults `$10` / `$50M`,
  overridable via gp-config). Fail any gate → no signal, full stop. (Note: there is
  no longer a "no resistance → reject" gate — see the target-derivation rule below.)
  The liquidity GATE is a tradability filter and is distinct from the volume SCORE
  (current participation vs the name's own average) — keep both. Snapshots store
  `avgDollarVolume30` and `liquidityPass`. **Adding/activating this gate is a
  decision-logic change → it requires a human `STRATEGY_VERSION` bump (never the
  agent).**
- **Derive levels — never type them in:** `stop = entry − atrStopMultiple×ATR`;
  `target = max(nearest resistance above entry, entry + targetAtrMultiple×ATR)`. R:R
  is the _result_, so it can't be gamed. The result carries `targetType`
  (`RESISTANCE` | `PROJECTED_ATR` | `RESISTANCE_FLOORED_BY_PROJECTED_ATR`),
  `projectedTarget`, `resistanceTarget`, `targetAtrMultiple` — persisted to snapshots
  and outcomes for target-type analysis.
- **ATR-projected target is a PROVISIONAL unblock — it caps winners by design and is
  measurement-shaped, not the permanent exit.** It replaced the old `target = nearest
  resistance, reject if none` rule, which discarded the strongest names before scoring
  (ATH breakouts had no level to anchor to; names pressing a nearby level got garbage
  ~0%-distance targets). Its only job is to get real candidates into `gp-outcomes`. It
  is intended to be **replaced by the trailing-exit (Tier 3) engine** once outcomes
  exist to validate against. **k-invariant (do NOT break):** `targetAtrMultiple` =
  `atrStopMultiple × minRiskReward` (1.5×2 = 3.0) — the minimum k that lets a projected
  target clear the R:R gate (projected R:R = `k / atrStopMultiple` = 2.0 at k=3.0). k
  too low → breakouts re-rejected; k too high → over-extended targets. Removing the gate
  removes a structural blocker; how many outcomes actually OPEN still depends on names
  clearing `buyScoreThreshold` (53) — the next lever if candidate flow is too thin.
- **Score 0–100 (gp-2.0.0):** empiricalEdge 15 (neutral 7.5 until outcomes fill it;
  ceiling 92.5), setup 20, trend 15, momentum 10, volume 8, news 2, rsRank 12,
  growthQuality 13, sectorStrength 5. RS/fundamentals/sector are gradient
  components, never gates; missing data is neutral 0, never a rejection. Always
  return the per-component **breakdown** (all nine keys).
- **`buyScoreThreshold` 60 → 53 (gp-2.0.0, PROVISIONAL mechanical re-center):** a
  structural adjustment for empiricalEdge moving 15→7.5 (a flat −7.5/name), NOT
  outcome tuning and NOT validated. Derived against ZERO actual candidates — the
  only scan day on record had all 43 names gate-rejected. Phase B MUST recalibrate
  it against real gp-2.0.0 candidates across varied market days. Both 60 and 53 are
  guesses.
- Validate inputs; on missing/bad data return a no-signal result, never score
  garbage. `buyScoreThreshold` is PROVISIONAL until backed by data.

## Outcome labeling (implement in `lambdas/labeler/`) — path-dependent, after costs

First-touch, not fixed-checkpoint. For each open signal, walk **every** trading
day from entry forward (Tiingo history):

```
if day_low  <= stop   -> STOP    (if both hit same day, assume STOP first)
if day_high >= target -> TARGET
else after timeout    -> TIMEOUT (exit = last close)
```

- **Pessimistic fills:** stops gap through — exit at the worse of stop vs that
  day's open.
- **Subtract costs:** `profitPct` is the after-cost number, deducting `feeBps`
  and `slippageBps` (from `gp-config`) per side. A cost-free backtest lies upward.
- Record `outcome`, `hitTargetFirst`, `hitStopFirst`, `exitDate`, `profitPct`
  (after cost), `daysHeld`, the original `breakdown`, and `strategyVersion`.
- Also record **MFE/MAE** (`mfePct`/`maePct`, gross % from entry, with `mfePrice`/
  `maePrice`): the best high and worst low reached over the held bars (inclusive of
  the exit bar). These measure price travel, NOT realized P&L, and drive stop tuning
  (e.g. "winners' MAE is only −1.8% → tighten the stop and size up").

---

## Control commands (`lambdas/control/`)

Telegram webhook. Reuse one bot; toggle EventBridge rules and the `gp-config` row.

- `/start` `/stop` — enable/disable the scanner schedule.
- `/mode observe|live` — write `alertMode` to `gp-config`. **A human only.** The
  agent must never set `alertMode: live`.
- `/enable <ticker>` `/disable <ticker>` — flip `enabled` in `gp-watchlist`.
- `/stats [30d]` — summarize `gp-outcomes` (win-rate, avg R, by score bucket),
  filtered by current `strategyVersion`.
- (`/close <ticker>` is deferred — only meaningful once trading live, post Phase 8.)

---

## Safety & epistemics (this is a trading tool — be careful)

- **Observe mode is the default.** In `observe`, messages are prefixed
  `📋 OBSERVE — tracking only, not a recommendation` and never say "BUY". Going
  live is a human `/mode live`, never automatic and never something you flip.
- **Validation is the judge, not confidence.** Two models agreeing, or a setup
  "looking good," is not evidence it makes money. Thresholds and the empiricalEdge
  term are guesses until backed by accumulated `gp-outcomes`. Do not tune weights
  before there is real data.
- Narration prompt is locked: only the provided JSON, invent no numbers, no
  financial advice, "possible setup" not "guaranteed".
- This is not financial advice and the code makes no profitability claim.

## Ops

Emit log keyword `gp_scan_failed` on failure; CloudWatch metric filter + alarm →
SNS → control Lambda → Telegram, so sustained failures page you.

**`gp-funnel-report` (observability, PERMANENT daily dashboard).** A READ-ONLY
Lambda (`lambdas/funnel-report/`) that scans `gp-snapshots` + `gp-outcomes`, reads
`gp-config`, and posts a daily dashboard-style funnel report (coverage, gate-rejection
breakdown, candidate **score distribution**, `targetType` distribution, **top
candidate sectors**, top scored, outcome counts) to the Telegram channel at
00:10 UTC Tue–Sat (after each Mon–Fri scan). It owns **no writable resource** — IAM
is read-only DynamoDB on three tables + `ssm:GetParameter` on the two Telegram
params + Logs. It changes nothing: no config writes, no opening/closing outcomes, no
scanner invoke, no recommendations — it reports what the scanner already produced.
**It is a kept feature — the schedule stays ENABLED; do not disable or remove it.**
The report's `report.mjs` is a pure, unit-tested function; the gate-rejection
breakdown is a strict partition of `NO_SIGNAL` (single failed gate per row;
below-threshold counted separately; an `unrecognized` catch-all so no row is
dropped). The score distribution buckets BUY_CANDIDATES into 70+ / 60–69 /
threshold–59 (bottom band floored at the live `buyScoreThreshold`); the sector
breakdown counts candidates by `sector`.

---

## Build order

```
1  shared/marketdata.mjs (Tiingo + Finnhub) + data-freshness check; verify one ticker
2  shared/version.mjs + shared/config.mjs (read gp-config); shared/scoring.mjs; unit-test
3  template.yaml: gp-snapshots, gp-outcomes, gp-config, gp-watchlist (all Retain) +
   scanner skeleton; seed config + watchlist; sam validate
4  scanner writes snapshots (+ strategyVersion, dataAsOf) + opens outcome rows; NO alerts
5  labeler: first-touch path labeling, pessimistic fills, after-cost profitPct; hand-verify
6  shared/telegram.mjs + narration; scanner sends in OBSERVE mode + ops alarm
7  control: /start /stop /mode /enable /disable /stats
8  accumulate outcomes; review /stats by score bucket; THEN tune gp-config thresholds +
   empiricalEdge
9  human flips /mode live after reviewing stats
```

Do not skip ahead. Never go live on unvalidated thresholds.

## Do NOT

- Start from or merge into the Edge Hunter repo. This is its own stack.
- Hardcode, print, or commit secret values; hardcode tunables (use gp-config).
- Let the LLM decide trades or alter numbers.
- Set `alertMode: live` or bump `STRATEGY_VERSION` on your own — both are human acts.
- Ship a single-key data table, or any data table without `Retain`.
- Score on stale data, label from fixed checkpoints, or report cost-free profit.
- Send "BUY" or go live before Phase 8's data exists.

---

## Git workflow
- One feature branch per build-order phase: `git checkout -b phase-1-marketdata`.
- Commit in small, working increments. Conventional messages:
  `feat: …`, `fix: …`, `test: …`, `chore: …`, `docs: …`.
- Before each commit, run `git status` and `git diff` and show me the diff.
  Never commit secrets (they live in SSM) or anything in `.gitignore`.
- At the end of each phase, when tests are green, push the branch and open a PR
  for a reviewable diff, then **merge and deploy it yourself** — the human has
  delegated merging and deploying to the agent and does not want to do these steps
  manually. Keep PRs small and self-contained so the merged history stays auditable
  after the fact. (Deploy: `sam validate` → `sam build` → `sam deploy`.)
- **Still human-only, never the agent (unchanged):** setting `alertMode: live`,
  bumping `STRATEGY_VERSION`, and live writes to the `gp-config` trading row that
  the human has explicitly reserved. Delegated merge/deploy does NOT extend to these.
- Never `git push --force`, never force-push to `main`, never rewrite shared history.
- When you find or knowingly leave a bug/limitation, open a GitHub Issue
  describing it and reference it in the commit/PR (`fixes #12`). Don't bury
  TODOs only in code comments — surface them as Issues so we can track them.
