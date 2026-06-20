# Alerts & narration (Phase 6)

When the scanner produces a `BUY_CANDIDATE`, it sends a Telegram message. The
message's **numbers are deterministic**; the LLM only writes a short flavor
sentence. This is "Math decides. AI only explains." made concrete.

- Telegram client: `lambdas/shared/telegram.mjs`
- Narration + message assembly: `lambdas/shared/narration.mjs`
- Secrets helper: `lambdas/shared/ssm.mjs`

## How a message is built

1. `buildPayload(result, marketData, mode)` — a small, locked JSON object (ticker,
   score, entry/stop/target/R:R, sector, rsi, dataAsOf, strategyVersion, mode).
2. `narrate(payload)` — calls the Anthropic Messages API (**Haiku tier**,
   `claude-haiku-4-5`) with a **locked system prompt** that forbids inventing or
   changing numbers, forbids "buy"/"sell"/"guaranteed", and asks for one
   "possible setup" sentence. If the call fails, a fixed fallback sentence is used.
3. `composeMessage(payload, narration)` — assembles the final text
   **deterministically**: in observe mode it prepends
   `📋 OBSERVE — tracking only, not a recommendation`, then the model's sentence,
   then a facts line built from the payload numbers, then `as of <date> · <version>`.

Because the facts line is built from the payload — not the model — the numbers are
always correct even if the model misbehaves or is down.

Example (observe mode):

```
📋 OBSERVE — tracking only, not a recommendation
MSFT shows a constructive uptrend holding above its moving averages.

MSFT — possible setup
Entry 100.00 · Stop 97.00 · Target 110.00 · R:R 3.333 · Score 81
as of 2026-06-18 · gp-1.0.0
```

## Safety

- **Observe mode is the default.** Messages are prefixed with the OBSERVE
  disclaimer and never say "BUY". Going live (`alertMode: live`, no prefix) is a
  human `/mode live` act (Phase 7) — never set by the agent.
- **The narration prompt is locked.** The model only rephrases the provided JSON.
- **Alert failures never sink a scan.** Narration and send are wrapped so one bad
  alert is logged (`gp_scan_failed`) and skipped; the run still records snapshots
  and outcomes.

## Secrets (read by path from SSM)

- `/edge-hunter/anthropic/api_key` — narration (reused from Edge Hunter)
- `/gerchik-perchik/telegram/bot_token` — **dedicated** Gerchik-Perchik bot
- `/gerchik-perchik/telegram/chat_id` — **dedicated** channel

## Ops alarm

Both functions log the keyword `gp_scan_failed` on any failure. The template adds:

- explicit log groups `/aws/lambda/gp-scanner` and `/aws/lambda/gp-labeler`,
- a metric filter on each (`gp_scan_failed` → `GerchikPerchik/ScanFailures`),
- a CloudWatch alarm `gp-scan-failures` (≥ 3 in an hour) → SNS topic `gp-ops-alerts`.

The SNS → control Lambda → Telegram delivery is wired in **Phase 7** (the control
Lambda subscribes to the topic). Until then the topic + alarm exist; you can add a
temporary email subscription to `gp-ops-alerts` if you want paging now.

## Setup status

The dedicated bot token and chat id live at `/gerchik-perchik/telegram/bot_token`
and `/gerchik-perchik/telegram/chat_id` (already created). The CI deploy-role
bootstrap has been re-run with the Logs/SNS/CloudWatch permissions Phase 6 needs.
Going live in observe mode is just `/start` once the scanner is ready to run.
