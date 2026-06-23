# `gp-funnel-report` — read-only funnel observability reporter

**Date:** 2026-06-22
**Status:** Approved, implementing
**Scope:** Additive observability only. One new read-only Lambda + one EventBridge
schedule + its IAM. Does NOT change scoring, gates, weights, `buyScoreThreshold`
(53), `alertMode`, `STRATEGY_VERSION`, the scanner/labeler, or any trading data.
Does NOT build trailing exits. Independent of PR #43 (reads stored fields).

---

## Purpose

After PR #43 (ATR-projected target floor) deploys, we need to watch whether the
funnel actually fills across the first ~5 scans — without over-reading any single
day. This Lambda reads three tables once per trading day and posts a funnel report
to the existing Telegram channel. It is the convenience layer on top of #43, not a
blocker for it.

It is short-lived (≈5 reports) and will be removed in a cleanup PR.

## Hard guarantees (why this is safe)

- **Owns no writable resource.** Its IAM grants read-only DynamoDB on exactly three
  tables, `ssm:GetParameter` on the two Telegram params, and CloudWatch Logs write.
  Nothing else. There is no state store, no counter, no config write — the
  read-only property is structural, not a promise.
- It never opens/closes outcomes, never invokes the scanner, never writes config,
  never sends buy/sell recommendations — it reports the scanner's own output.

## Architecture

```
lambdas/funnel-report/
  handler.mjs   # I/O only: scan 3 tables → buildFunnelReport() → sendTelegram()
  report.mjs    # PURE: buildFunnelReport({snapshots, outcomes, config, nowMs, freshWindowMs})
                #        → { isFreshScan, dataAsOf, counts, text }
```

- Conventions match every other function: `FunctionName: gp-funnel-report`,
  `CodeUri: lambdas/funnel-report/`, `Handler: handler.handler`, `nodejs22.x`,
  esbuild ESM, tag `Project: gerchik-perchik`.
- `report.mjs` is pure (no I/O) so the entire report computation is unit-tested
  with hand-built fixtures, like `scoring.mjs`.
- Reuses `shared/telegram.mjs` (`sendTelegram`) and `shared/ssm.mjs` unchanged. Its
  own read-only `DynamoDBDocumentClient`.

## Latest-scan selection + stateless fresh-scan / 5-report logic

Zero persistent state:

- **Latest scan:** scan `gp-snapshots`, take rows whose `dataAsOf` equals the max
  `dataAsOf` present. Tiny table (~43 names × a few days).
- **Fresh-scan gate (no stored "last reported day"):** if the latest scan's newest
  `scannedAt` is within `freshWindowMs` (~6 h) of now → post the full report; else
  → post a one-line `📋 no new scan today — funnel report skipped`. At 00:10 UTC a
  23:30 UTC scan is ~40 min old (fresh); a weekend/holiday check sees a ~24 h-old
  scan (skipped).
- **5-report stop:** manual. After ~5 trading-day reports, disable the rule:
  `aws events disable-rule --name gp-funnel-report-schedule --region us-east-1`,
  then remove in a cleanup PR. (Deliberately no state store for an auto-stop —
  that would give the reporter something writable and break the clean read-only
  property.)

## Schedule

```yaml
Type: Schedule
Name: gp-funnel-report-schedule
Schedule: cron(10 0 ? * TUE-SAT *)   # 00:10 UTC after each Mon–Fri 23:30 scan
Enabled: true
```

Scanner runs `cron(30 23 ? * MON-FRI *)`, labeler `cron(45 23 ? * MON-FRI *)`, so
00:10 UTC is 40 min after the scan and 25 min after the labeler — a stable snapshot.

## Report contents — field → source (all from the latest-scan snapshot rows)

| Field | Derivation |
|---|---|
| watchlist count | distinct tickers snapshotted this scan (proxy for enabled count; `gp-watchlist` intentionally out of IAM scope) |
| fresh coverage % | non-`NO_DATA` snapshots / total snapshots (+ raw `NO_DATA` count) |
| gate-rejection breakdown | gate-rejected rows (`NO_SIGNAL` with `score == null`) bucketed by their single false gate (see invariant ▼) |
| names reaching scoring | rows with `score != null` |
| BUY_CANDIDATE count | `decision == BUY_CANDIDATE` |
| targetType distribution | among rows with `targetType != null`: RESISTANCE / PROJECTED_ATR / RESISTANCE_FLOORED_BY_PROJECTED_ATR |
| top 10 scored names | `score != null`, sorted desc: `ticker · score · decision · targetType` |
| newly opened outcomes | `gp-outcomes` rows with `entryDate == latest dataAsOf` |
| cumulative OPEN | `gp-outcomes` where `status == OPEN` |
| cumulative CLOSED | `gp-outcomes` where `status == CLOSED` |

Header carries `strategyVersion` + `buyScoreThreshold` (from `gp-config`). Footer:
`OBSERVE — measurement, not a recommendation · small-n, preliminary · don't pool
across strategyVersion`.

### Gate-breakdown partition invariant (tested, first-class)

Post-#43, `NO_SIGNAL` has two sub-types: **gate-rejected** (`score == null`,
exactly one gate is false because the scanner returns at the first failed gate) and
**reached-scoring-below-threshold** (`score != null`, all gates true). The
breakdown:

- buckets each gate-rejected row by its **single false gate** (structured, regex-free;
  equivalent to the single recorded `reason`),
- counts below-threshold names separately (they are NOT gate rejections),
- routes any row with not-exactly-one-false-gate to an `unrecognized` bucket so
  nothing is ever silently dropped.

Invariant (asserted in tests): `sum(gate buckets) + belowThreshold + unrecognized
== total NO_SIGNAL`, each name counted exactly once.

## Exact IAM (least privilege)

```yaml
Policies:
  - Version: '2012-10-17'
    Statement:
      - Effect: Allow
        Action: ssm:GetParameter            # GetParameter only — no PutParameter
        Resource:
          - !Sub 'arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter${TelegramBotTokenPath}'
          - !Sub 'arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter${TelegramChatIdPath}'
  - DynamoDBReadPolicy: { TableName: !Ref SnapshotsTable }
  - DynamoDBReadPolicy: { TableName: !Ref OutcomesTable }
  - DynamoDBReadPolicy: { TableName: !Ref ConfigTable }
```

`DynamoDBReadPolicy` expands (per table ARN only) to `dynamodb:GetItem, Scan, Query,
BatchGetItem, ConditionCheckItem, DescribeTable` — **no** Put/Update/Delete/BatchWrite.
SAM also auto-adds `AWSLambdaBasicExecutionRole` (Logs write — the only write) and an
EventBridge→Lambda invoke permission. **Not granted:** any DynamoDB write; `gp-watchlist`;
`lambda:InvokeFunction` on the scanner; `events:*`; `ssm:PutParameter`. The bot_token
SecureString is read via the AWS-managed SSM key (no explicit `kms:Decrypt`, same as the
scanner).

## Tests (TDD)

`report.mjs` is pure → unit-tested with fixtures:

1. Gate-breakdown partition invariant: `sum(buckets) + belowThreshold + unrecognized
   == total NO_SIGNAL`; each name counted once; below-threshold not mis-bucketed as a
   gate rejection.
2. `unrecognized` catches a row with no false gate (or multiple) — nothing dropped.
3. Latest-scan selection: with two `dataAsOf` days present, only the newest is reported.
4. Fresh-scan gate: recent `scannedAt` → `isFreshScan true`; stale → false (one-liner).
5. targetType distribution counts only rows where `targetType != null`.
6. Outcome counts: OPEN/CLOSED cumulative + newly-opened-this-scan by `entryDate`.
7. Watchlist count = distinct snapshotted tickers; fresh coverage % excludes `NO_DATA`.
8. top-10 sorted desc by score, ties stable, `score == null` excluded.

## CLAUDE.md

Add an Ops note: the reporter is observability-only (read-only on three tables,
posts the funnel to Telegram), manually disabled after ~5 reports, to be removed in
a cleanup PR. No strategy/scoring/gate/threshold implications.
