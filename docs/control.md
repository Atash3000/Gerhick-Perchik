# Control commands & ops paging (Phase 7)

The `gp-control` Lambda is a Telegram webhook (a public **Function URL**) and the
subscriber for the `gp-ops-alerts` SNS topic. It lets you run the bot from
Telegram, and it forwards CloudWatch alarms to Telegram so sustained failures page
you.

- Handler: `lambdas/control/handler.mjs`
- Pure command logic: `lambdas/control/commands.mjs`

## Commands

| Command | Effect |
|---------|--------|
| `/start` | Enable the scanner **and** labeler EventBridge schedule rules |
| `/stop` | Disable them |
| `/mode observe\|live` | Set `alertMode` on `gp-config`. **Live is a human decision** (see below) |
| `/enable <TICKER>` | Set `enabled: true` on the `gp-watchlist` row (must already exist) |
| `/disable <TICKER>` | Set `enabled: false` |
| `/stats [30d]` | Summarize CLOSED `gp-outcomes` for the **current** `strategyVersion` — win-rate, avg %, avg R, and a per-score-bucket breakdown. Optional `Nd` window. |
| `/analyze [30d]` | **Phase 8 deep-dive**: profit factor, expectancy, avg win/loss, by-score-bucket, and **component-predictor edge** — for each scoring component, the win-rate difference between its high and low halves. This is the input to v2 re-weighting: components with a large positive edge deserve weight; near-zero ones don't. Computes only — a human reviews and decides any weight change (a `STRATEGY_VERSION` bump). |

`/start` and `/stop` are the **runtime** on/off switch (EventBridge), separate from
the deploy-time `ScheduleEnabled` baseline. A redeploy resets the rules to the
baseline (off), so re-issue `/start` after a deploy until you flip the baseline.

## Safety & auth

- The Function URL is `AuthType: NONE` (Telegram must reach it), so it's protected
  by Telegram's **secret-token header** — every update must carry
  `X-Telegram-Bot-Api-Secret-Token` equal to `/gerchik-perchik/telegram/webhook_secret`,
  or the request is rejected `401`.
- Commands are only honored when `message.chat.id` matches the dedicated
  `/gerchik-perchik/telegram/chat_id`. Anything else is silently acked.
- **`/mode live` is a human act.** The control Lambda sets `alertMode: live` only
  in response to a human `/mode live` from the dedicated channel — this is the one
  sanctioned path to go live. The agent/code never sets live on its own.

## Ops paging

`gp-control` subscribes to `gp-ops-alerts`. When the `gp-scan-failures` alarm fires
(≥ 3 `gp_scan_failed` events in an hour from the scanner or labeler), SNS invokes
`gp-control`, which posts a formatted alert to the dedicated channel. This closes
the Phase 6 ops chain.

> The control Lambda's own failures are logged but **not** metered into the alarm —
> otherwise a Telegram outage (which would already break paging) could feed a
> self-reinforcing alarm loop.

## One-time human setup

1. **Create the webhook secret** (any random string you choose):
   ```bash
   aws ssm put-parameter --name /gerchik-perchik/telegram/webhook_secret \
     --type SecureString --value "<random secret>" --region us-east-1
   ```
2. After the deploy, get the control URL from the stack outputs:
   ```bash
   aws cloudformation describe-stacks --stack-name gerchik-perchik --region us-east-1 \
     --query "Stacks[0].Outputs[?OutputKey=='ControlFunctionUrl'].OutputValue" --output text
   ```
3. **Register the webhook with Telegram** (binds the URL + secret to the bot). The
   bot token lives in SSM; run this from a trusted shell, not committed anywhere:
   ```bash
   TOKEN=$(aws ssm get-parameter --name /gerchik-perchik/telegram/bot_token \
     --with-decryption --query Parameter.Value --output text --region us-east-1)
   curl -s "https://api.telegram.org/bot$TOKEN/setWebhook" \
     -d "url=<ControlFunctionUrl>" \
     -d "secret_token=<the random secret from step 1>"
   ```
4. (Optional) Subscribe an email to `gp-ops-alerts` too, for a non-Telegram path.

After that, send `/start`, `/stats`, etc. from the dedicated channel.
