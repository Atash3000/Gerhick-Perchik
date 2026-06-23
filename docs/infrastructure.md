# Infrastructure — `template.yaml`, tables, deploy & seed runbook

Phase 3 stands up the **data layer** and the **scanner skeleton**. Nothing is
deployed automatically; deploy and seed are deliberate, human-run steps (below).

## Stack at a glance

- One AWS SAM stack (`Transform: AWS::Serverless-2016-10-31`), `stack_name =
  gerchik-perchik`, region `us-east-1`.
- Runtime `nodejs22.x`, ESM, arm64. `Globals` sets runtime, handler, tags, and the
  table-name / SSM-path environment variables.
- Every resource is tagged `Project: gerchik-perchik`.

## Tables — four, compound keys, **Retain on all**

`PAY_PER_REQUEST`. Every table has `DeletionPolicy: Retain` **and**
`UpdateReplacePolicy: Retain` — the accumulated history and tuned config are the
whole point and must survive a table replacement or a stack delete.

| Table | Partition key | Sort key | Purpose |
|-------|---------------|----------|---------|
| `gp-snapshots` | `pk = TICKER#<ticker>` (S) | `sk = <epoch day>` (N) | one daily score snapshot per name; no TTL |
| `gp-outcomes` | `pk = SIGNAL#<ticker>#<entryDate>` (S) | `sk = <entry epoch>` (N) | one row per opened signal; labeled later |
| `gp-config` | `pk = "CONFIG"` (S) | `sk = "ACTIVE"` (S) | single live tunables row |
| `gp-watchlist` | `pk = TICKER#<ticker>` (S) | — | scan universe; `enabled`, `sector`, `qualityTier` |

> Keys must be unique per record. Never write two different records under one key
> (that silently overwrites).

### What the scanner writes (Phase 4)

Persistence lives in `lambdas/shared/store.mjs` (used by the scanner now, the
labeler later):

- **`gp-snapshots`** — one row per scored name per trading day.
  `pk = TICKER#<ticker>`, `sk = epochDay(dataAsOf)` (whole days since epoch, so a
  same-day re-run overwrites rather than duplicates). Stores the full result:
  `decision`, `score`, `breakdown`, `entry`/`stop`/`target`/`riskReward`, `gates`,
  `reason`, `sector`, plus `strategyVersion` and `dataAsOf`, plus a `metrics` block
  (raw inputs: `rsi`, `atr`, `volumeRatio`, level prices, `daysToEarnings`,
  Minervini `ma150`/`ma200SlopePct`, Turtle `high20d`/`high55d`, RS returns
  `return21/63/126/252d`, and relative strength `rsRaw`/`rsRank`/`rsVsSpy`
  (cross-sectional, capture-only)) and a `fundamentals` block (O'Neil capture:
  `epsGrowthQtr`, `salesGrowthQtr`, `annualEpsGrowth`, `grossMarginTTM`, `roeTTM`,
  `debtToEquity`) — all **captured, not scored** — for Phase 8 analysis. Every
  decision is snapshotted — including `NO_SIGNAL`, gate rejections, and `NO_DATA`.
- **`gp-outcomes`** — one row per **new entry**, opened with `status: "OPEN"`. A
  `BUY_CANDIDATE` opens a new outcome (and alerts) **only when the ticker has no
  outcome already OPEN** — a name that qualifies many days running does NOT open a
  fresh overlapping trade each day (that would flood `/analyze` with correlated
  near-duplicates). Re-entry is allowed once the prior outcome closes. Daily
  re-alerts for a held position are likewise suppressed; the scan summary reports
  `reEntriesSkipped`.
  `pk = SIGNAL#<ticker>#<entryDate>`, `sk = epochMs(entryDate)`. Written with a
  `attribute_not_exists(pk)` condition so a re-run never re-opens or clobbers an
  existing (possibly already-labeled) outcome. The Phase 5 labeler fills in the
  result fields.

Per-name write failures are logged (`gp_scan_failed`) and skipped — one bad write
never sinks the scan.

The scan summary carries a **coverage** block (B7): `expectedCount`, `scannedCount`,
`snapshotsWritten`, `freshDataCount`, `noDataCount`, `errorCount`, `coveragePct`,
plus `degraded`/`degradedReason`. A run with 0 snapshots, error rate ≥ 50%, or
fresh-data coverage < 50% emits `gp_scan_failed` → the ops alarm pages via Telegram
(catches silent feed outages that otherwise look like a successful empty scan).

### `gp-config` tunables (the ACTIVE row)

Read at the start of every run; **never** hardcoded in the Lambdas. Seeded from
[`seed/config.json`](../seed/config.json):

`buyScoreThreshold`, `atrStopMultiple`, `minRiskReward`, `maxCorrelatedPositions`,
`alertMode`, `feeBps`, `slippageBps`, `timeoutTradingDays`. All **provisional**
until Phase 8. `alertMode` starts `observe` and is only ever flipped to `live` by
a human. `timeoutTradingDays` (default 60) is the labeler's max holding window
before a signal is closed as TIMEOUT — see [`labeling.md`](./labeling.md).

## Scanner function (skeleton)

- `FunctionName: gp-scanner`, `CodeUri: lambdas/scanner/`, `Handler:
  handler.handler`. Built with **esbuild** (`Metadata.BuildMethod: esbuild`), which
  bundles the imported `../shared/*.mjs` modules; the AWS SDK v3 is left external
  (provided by the runtime).
- **Schedule:** a classic EventBridge rule (`Type: Schedule`), default
  `cron(30 22 ? * MON-FRI *)` (UTC, ~post-close). Its deploy-time on/off baseline
  is the `ScheduleEnabled` parameter, **default `false`** (pinned to `false` in
  `samconfig.toml`) so deploys never start the scanner before the pipeline is
  ready. Flip it to `true` (reviewed) when going to Phase 6+. The Phase 7 control
  Lambda toggles the rule at runtime within a deploy cycle; a redeploy resets it
  to this baseline.
- **IAM (least privilege):** `ssm:GetParameter` on only the two specific
  `/edge-hunter/*` key ARNs; CRUD on `gp-snapshots` + `gp-outcomes`; read-only on
  `gp-config` + `gp-watchlist`.

What the skeleton does today vs later is documented inline in
[`lambdas/scanner/handler.mjs`](../lambdas/scanner/handler.mjs) (Phase 4 adds the
snapshot/outcome writes; Phase 6 adds alerts).

## Validate (safe — no AWS changes)

```bash
sam validate --region us-east-1 --lint
```

## Deploy & seed runbook (human-run — creates billable resources)

> Deploy creates Retain tables that survive a stack delete, and an EventBridge
> rule. Do this deliberately. Prefer a scoped IAM principal over the account root.

```bash
nvm use 22
sam build
sam deploy --guided        # first time; thereafter `sam deploy`
                           # confirm_changeset is on — review before applying

# Seed AFTER the stack exists. Dry-run first (writes nothing):
node scripts/seed.mjs
# Then actually write the config + watchlist rows:
node scripts/seed.mjs --apply
```

`scripts/seed.mjs` is dry-run by default, refuses to seed unless `alertMode` is
`observe`, and is idempotent (Put overwrites the same keys).

## Data feeds: keys, paths, and the Tiingo quota

Key SSM **paths** are env-driven (`TIINGO_KEY_PATH`, `FINNHUB_KEY_PATH`, set from
the `TiingoKeyPath` / `FinnhubKeyPath` template params), so a key can be moved
without a code change. The scanner and labeler log the paths in use at startup
(`gp_keypaths {...}`) — **paths only, never the secret values**.

**Tiingo: dedicated PREMIUM key (`/gerchik/tiingo/api_key`).** Tiingo reads the
dedicated `/gerchik/tiingo/api_key` (env-driven `TiingoKeyPath`, default + IAM both
point here; `/edge-hunter/tiingo` is NOT used — it's the shared, capped free key).
That account is on a **paid plan**, which removes the free-tier limits that used to
bind us:
- **Monthly 500-unique-symbol cap → gone.** (On free, the shared `/edge-hunter`
  key was starved by Edge Hunter's universe; verified 2026-06-23 that the premium
  `/gerchik` key serves arbitrary symbols with no cap message.)
- **Hourly request cap → raised far above a single scan's burst.** It no longer
  bounds scan size.

**Binding ceiling for scan size is now Finnhub + the Lambda timeout, NOT Tiingo.**
Each ticker makes ~3 Finnhub calls (earnings, profile, fundamentals) serialized
through the 1.2s `finnhub` limiter ≈ **3.6s/name**. So `Timeout` bounds the
universe: 300s ≈ 65 names; **900s (Lambda max) ≈ ~200 names** (universe is 199).
To grow past ~250: cut Finnhub calls/ticker (use the watchlist `sector` instead of
the profile call, fetch fundamentals only for gate-passing candidates) and/or
fan-out the scan with two-phase cross-sectional ranking.

**Resilience (scanner-429 fix):** Tiingo calls are routed through a limiter
(`ratelimit.mjs` `tiingo`) to avoid burst 429s, and through a **bounded retry**
(`withRetry`, 2 attempts) so a transient 429 self-heals. A 429 can no longer crash
a run: the SPY **regime fetch catches it and aborts the scan cleanly** (degraded
summary, not an uncaught Lambda error), and per-ticker 429s already degrade to
`NO_DATA`/`ERROR`. B7 coverage still flags a degraded run → pages.

Finnhub and Anthropic keys stay shared (`/edge-hunter/*`) per scope.

> The opportunity/quality **backtest scripts refuse to run** when fewer than 90% of
> watchlist symbols load (the quota case) — better no answer than a misleading one.

## Schedule / DST note

EventBridge crons are UTC-only. The crons are fixed UTC but chosen so **both** US
seasons land in a safe NY evening — after the 16:00 ET close and ~18:00 ET EOD-data
settle:

| | UTC | EDT (summer) | EST (winter) |
|---|---|---|---|
| scan | 23:30 | 7:30pm ET | 6:30pm ET |
| label | 23:45 | 7:45pm ET | 6:45pm ET |

A harmless ~1h seasonal drift remains, but both seasons stay safely in the evening
(this replaced an earlier winter time of ~5:30pm ET, which was before data settled).
Both stay before midnight UTC so the MON-FRI day-of-week holds. Pinned in
`samconfig.toml`, with `ScheduleEnabled=true` (the system runs in observe mode, so
deploys no longer disable it). If exact NY wall-clock year-round is ever needed,
move to EventBridge Scheduler (`ScheduleV2` + `ScheduleExpressionTimezone:
America/New_York`) — a larger change that also reworks the `/start`/`/stop` toggle.
