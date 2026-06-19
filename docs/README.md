# Gerchik-Perchik — documentation

A disciplined, technical-analysis trading-**signal** bot. Once a day, after the US
close, it scores a watchlist 0–100 on price action (trend, levels, ATR-based
risk/reward, volume, news), records a snapshot for every name, and — for
qualifying setups — will (from Phase 6) send a Telegram message. It then tracks
what actually happened to each signal so the scoring can be tuned from real
outcomes instead of guesses.

This is a **separate** project from Edge Hunter. It shares Edge Hunter's API keys
(by SSM path) but nothing else.

## The one principle

> **Math decides. AI only explains.**

The deterministic scoring function (`shared/scoring.mjs`) produces the signal and
every number — entry, stop, target, R:R, the score, the breakdown. The LLM is used
only (Phase 6) to phrase a Telegram message from an already-locked JSON payload. It
never chooses a trade, changes a number, or invents data.

## Repository layout

```
gerchik-perchik/
  CLAUDE.md            # durable project law — read before acting
  template.yaml        # SAM: data tables (Retain) + scanner (Phase 3)
  samconfig.toml       # SAM build/deploy/validate settings
  package.json         # Node 22 ESM; `npm test`
  lambdas/
    scanner/handler.mjs   # daily scan (skeleton in Phase 3; writes in Phase 4)
    shared/
      marketdata.mjs      # Tiingo + Finnhub → one clean per-ticker object
      scoring.mjs         # gates + 0–100 score + derived stop/target/R:R
      config.mjs          # reads the gp-config ACTIVE tunables row
      version.mjs         # STRATEGY_VERSION constant
  seed/                # initial gp-config row + gp-watchlist rows (JSON)
  scripts/
    sample-msft.mjs    # manual: fetch+score one ticker (no secrets printed)
    seed.mjs           # manual: load seed JSON into the tables (dry-run default)
  tests/               # node:test unit tests
  docs/                # you are here
```

## How a daily run flows (target design)

1. **Read tunables** from `gp-config` (thresholds, ATR multiple, costs). Never
   hardcoded — see [`infrastructure.md`](./infrastructure.md).
2. **Check the regime**: fetch SPY; if SPY < its 200MA the market gate fails for
   everything. If SPY data is stale, the run aborts (never score on bad context).
3. **Load the universe**: the `enabled` rows of `gp-watchlist`.
4. **Per ticker**: `marketdata.mjs` returns one clean object; `scoring.mjs` runs
   the gates, derives stop/target/R:R, and produces a 0–100 score + breakdown.
   See [`marketdata.md`](./marketdata.md) and [`scoring.md`](./scoring.md).
5. **Persist** (Phase 4): a `gp-snapshots` row per name; a `gp-outcomes` row per
   `BUY_CANDIDATE`.
6. **Alert** (Phase 6): OBSERVE-mode Telegram message for candidates.
7. **Label** (Phase 5): the labeler walks each open signal forward and records the
   real, after-cost outcome.

## Build phases (where we are)

| Phase | What | Status |
|------:|------|--------|
| 1 | `marketdata.mjs` + freshness; verify one ticker | ✅ done |
| 2 | `version.mjs`, `config.mjs`, `scoring.mjs`; unit tests | ✅ done |
| 3 | `template.yaml` (4 Retain tables) + scanner skeleton; seed files; `sam validate` | ✅ this doc set |
| 4 | scanner writes snapshots + opens outcomes; **no alerts** | ⬜ next |
| 5 | labeler: first-touch, pessimistic fills, after-cost P&L | ⬜ |
| 6 | `telegram.mjs` + narration; OBSERVE alerts + ops alarm | ⬜ |
| 7 | control: `/start /stop /mode /enable /disable /stats` | ⬜ |
| 8 | accumulate outcomes; tune `gp-config` from real data | ⬜ |
| 9 | **human** flips `/mode live` after reviewing stats | ⬜ |

> Observe mode is the default and going live is a human act. Thresholds and the
> `empiricalEdge` term are guesses until backed by accumulated outcomes; the
> current scoring ceiling is **85, not 100** (see [`scoring.md`](./scoring.md)).

## Running locally

```bash
nvm use 22          # the project targets nodejs22.x
npm install
npm test            # unit tests (node:test)
npm run sample:msft # fetch+score MSFT live (needs AWS creds for SSM read)
```

## CI/CD

Pull requests run validation (`npm test`, `sam validate`, `sam build`) with no AWS
access; merging to `main` deploys the SAM stack via GitHub OIDC, gated by a
required-reviewer `production` environment. Deploy ships code/infra only — it never
flips `alertMode`. Setup and the one-time AWS trust bootstrap are in
[`cicd.md`](./cicd.md).
