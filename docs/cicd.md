# CI/CD — auto-deploy on merge to `main`

Two GitHub Actions workflows:

| Workflow | Trigger | AWS access | What it does |
|----------|---------|-----------|--------------|
| `.github/workflows/ci.yml` | pull request → main | **none** | `npm test`, `sam validate --lint`, `sam build` |
| `.github/workflows/deploy.yml` | push to main (i.e. after merge) | OIDC (short-lived) | `npm test`, `sam build`, `sam deploy` |

CI is safe to use immediately — it never touches AWS. Deploy stays **dormant**
until you finish the one-time bootstrap below (the job is `if`-skipped while the
`AWS_DEPLOY_ROLE_ARN` repo variable is unset, so merging the PR can't fire a
half-configured deploy).

> **Deploy ≠ go-live.** These workflows ship code and infrastructure only. They
> never change `alertMode`. Going live remains a human Telegram `/mode live`
> against `gp-config`. Seeding (`gp-config` / `gp-watchlist`) is also **not** done
> by CI — it's a separate manual step (`npm run seed:apply`).

## One-time bootstrap (human-run, needs IAM-create rights)

This establishes the trust so GitHub can deploy without any stored AWS keys.
Prefer running it as a scoped admin, not account root (see issue #5).

### 1. Create the OIDC provider + scoped deploy role

```bash
aws cloudformation deploy \
  --template-file ci/github-oidc-bootstrap.yaml \
  --stack-name gp-cicd-bootstrap \
  --capabilities CAPABILITY_NAMED_IAM \
  --region us-east-1

# Grab the role ARN it created:
aws cloudformation describe-stacks --stack-name gp-cicd-bootstrap \
  --region us-east-1 --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue" --output text
```

> If the account already has a GitHub OIDC provider, re-run with
> `--parameter-overrides CreateOIDCProvider=false ExistingOIDCProviderArn=<arn>`.

The role (`gp-github-deploy-role`) trusts **only** this repo's `production`
GitHub Environment — so only a reviewer-approved run can assume it.

### 2. Tell GitHub the role ARN

```bash
gh variable set AWS_DEPLOY_ROLE_ARN \
  --repo Atash3000/Gerhick-Perchik \
  --body "<DeployRoleArn from step 1>"
```

### 3. Create the `production` Environment with a required reviewer

In GitHub → repo **Settings → Environments → New environment → `production`**, add
yourself under **Required reviewers**. Now every deploy pauses for your click.
(This is the human-in-the-loop gate that matches the project's discipline.)

### 4. (Recommended) Protect `main`

Settings → Branches → add a rule for `main`: require the **CI** check to pass and
require a PR review before merge. That makes the flow: PR → CI green → your review
→ merge → deploy waits for your approval → live.

## After bootstrap — the everyday flow

1. Work on a `phase-N-…` branch; open a PR. **CI** runs automatically.
2. You review and merge.
3. **Deploy** starts, runs tests + `sam build`, then waits on the `production`
   environment for your approval.
4. You approve → `sam deploy` updates the stack.

## First deploy — expect a little friction

- The stack has **never been deployed**. The first run creates all four Retain
  tables, the Lambda, the schedule, and the SAM artifact bucket. Consider doing
  the very first `sam deploy` locally (you watch it), then let CI own subsequent
  deploys — or just let CI do it and watch the run.
- **IAM least-privilege is fiddly.** The deploy role in
  `ci/github-oidc-bootstrap.yaml` is scoped to `gerchik-perchik` / `gp-*`
  resources. The first deploy may surface one or two missing actions; add them to
  that template rather than widening to admin. Tracked as a follow-up issue.
- After a successful deploy, **seed once**: `npm run seed` (dry run) then
  `npm run seed:apply`. The scanner won't work until `gp-config`/`gp-watchlist`
  exist.

## Why OIDC (not stored keys)?

GitHub mints a short-lived token per run; AWS exchanges it for temporary
credentials by assuming `gp-github-deploy-role`. Nothing long-lived is stored in
GitHub, the trust is pinned to this repo's `production` environment, and the role
is scoped to this project's resources.
