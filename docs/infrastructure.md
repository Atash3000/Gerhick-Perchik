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
  `reason`, `sector`, plus `strategyVersion` and `dataAsOf`. Every decision is
  snapshotted — including `NO_SIGNAL`, gate rejections, and `NO_DATA`.
- **`gp-outcomes`** — one row per `BUY_CANDIDATE`, opened with `status: "OPEN"`.
  `pk = SIGNAL#<ticker>#<entryDate>`, `sk = epochMs(entryDate)`. Written with a
  `attribute_not_exists(pk)` condition so a re-run never re-opens or clobbers an
  existing (possibly already-labeled) outcome. The Phase 5 labeler fills in the
  result fields.

Per-name write failures are logged (`gp_scan_failed`) and skipped — one bad write
never sinks the scan. Still **no alerts** (that's Phase 6).

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

## Schedule / DST note

The cron is a fixed **UTC** expression and does not auto-adjust for US daylight
saving. `22:30 UTC` ≈ 18:30 ET (EDT) / 17:30 ET (EST) — comfortably after the
16:00 ET close and ~18:00 ET EOD data settle. Revisit only if the close-to-scan gap
ever matters.
