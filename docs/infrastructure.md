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

### `gp-config` tunables (the ACTIVE row)

Read at the start of every run; **never** hardcoded in the Lambdas. Seeded from
[`seed/config.json`](../seed/config.json):

`buyScoreThreshold`, `atrStopMultiple`, `minRiskReward`, `maxCorrelatedPositions`,
`alertMode`, `feeBps`, `slippageBps`. All **provisional** until Phase 8. `alertMode`
starts `observe` and is only ever flipped to `live` by a human.

## Scanner function (skeleton)

- `FunctionName: gp-scanner`, `CodeUri: lambdas/scanner/`, `Handler:
  handler.handler`. Built with **esbuild** (`Metadata.BuildMethod: esbuild`), which
  bundles the imported `../shared/*.mjs` modules; the AWS SDK v3 is left external
  (provided by the runtime).
- **Schedule:** a classic EventBridge rule (`Type: Schedule`), default
  `cron(30 22 ? * MON-FRI *)` (UTC, ~post-close). Runtime on/off is done by the
  control Lambda toggling this rule (Phase 7) — never by redeploying.
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
