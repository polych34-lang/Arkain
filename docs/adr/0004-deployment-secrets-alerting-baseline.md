# ADR-0004 — Deployment baseline: hosting, environments, secrets, alerting

**Status:** Proposed (pipeline + code implemented; live rollout gated on CEO
approval of the hosting choice + account creation — see §6) · **Owner:**
Integrations & Deployment Engineer · **Date:** 2026-07-02 · **Issue:** ARK-28 ·
**Builds on:** ADR-0001 (`ARCHITECTURE.md`) §2, §7, §8

---

## 1. Context

ADR-0001 named the shape of this ("Docker image; host on a single small
container platform (Render / Fly.io / Korean cloud such as NCP) — no
Kubernetes for the MVP") but left the concrete choice open, and the CI
baseline (`.github/workflows/ci.yml`) stops at build/test — there was no
deploy stage, no staging environment, and no path from local `.env` to
production secrets. This ADR closes that gap before any real seller
credential is handled (ARCHITECTURE.md §7's stated gate).

**Finding while implementing this:** the repo has no git remote — `ci.yml`
has never actually run (its `push: branches: [main]` trigger was also wrong;
the repo's default branch is `master`, fixed in this change). Everything
below is real, tested infrastructure-as-code, but is inert until the repo is
pushed to a real Git host. See §6.

## 2. Decision — hosting

**Recommendation: Fly.io**, single container, `icn` (Seoul) region, one app
per environment (`arkain-staging`, `arkain-production`). Not yet
provisioned — see §6.

| Option | Trade-off |
| --- | --- |
| **Fly.io** (recommended) | Named explicitly in ADR-0001. Git/CLI-based deploy, trivial GitHub Actions integration (`flyctl deploy`), per-app secrets, `icn` region close to Korean marketplace APIs, generous free/cheap tier fits MVP traffic. |
| Render | Similar fit; auto-deploy-on-push is *simpler* (no Actions deploy job needed) but that means less control over the migration-then-deploy ordering (§4) and no clean staging/production promotion gate without a paid tier. |
| Korean cloud (NCP) | Best answer if data residency becomes a compliance requirement; more setup ceremony (VPC, image registry, IAM) than an MVP needs today. Revisit if a customer requires KR-only data residency. |

This mirrors ADR-0001 §11: hosting is explicitly named there as reversible
("even DB-via-Prisma can be swapped while data volume is tiny"). Proceeding
on that basis, but since it is an **external account + eventual billing**
decision (not just code), the actual account creation is left to CEO
approval rather than done unilaterally — see §6.

## 3. Decision — environments

Four `NODE_ENV` values already existed in `env.ts` (`development`, `test`,
`staging`, `production`); this ADR makes `staging`/`production` real:

- **staging** — `arkain-staging` Fly app. Auto-deploys on every push to
  `master` once CI is green (`.github/workflows/deploy.yml`).
- **production** — `arkain-production` Fly app. Deploy is
  `workflow_dispatch`-only (manual target selection), additionally gated by
  the `production` GitHub Environment's required-reviewer rule (a repo
  setting, not expressible in YAML — see §6 for who configures it).

Both environments run the same Docker image (built once, promoted by
reference — `deploy-staging`/`deploy-production` both consume
`build-and-push`'s image digest, never rebuilt per-environment) so "works in
staging" means the exact bytes that go to production.

## 4. Decision — secrets management

**Local dev:** unchanged — `.env` (git-ignored), `.env.example` template,
CI `secret-scan` job blocks any tracked `.env`.

**CI/CD (build + release):** GitHub Actions **encrypted secrets**, scoped
per-environment (`staging` / `production` GitHub Environments) rather than
repo-wide, so a staging secret can never leak into a production deploy job
and vice versa. Two secrets per environment drive the pipeline itself:

- `DATABASE_URL` — used by the `db:deploy` (`prisma migrate deploy`) release
  step, run **before** the new image goes live against that database.
- `FLY_API_TOKEN` — scoped to that Fly.io app only (`flyctl tokens create
  deploy -a <app>`), not an org-wide token.

**Running app secrets** (`CREDENTIAL_ENC_KEY`, `NAVER_COMMERCE_CLIENT_ID/
SECRET`, `ALERT_WEBHOOK_URL`, per-marketplace app keys as more adapters land)
are **not** passed through GitHub Actions on every deploy. They're set once
per Fly app via `flyctl secrets set` (Fly's own encrypted-at-rest secret
store, injected as env vars at container start) — this keeps them out of CI
job logs/env entirely and out of the image. This is the "운영 수준 시크릿
관리" upgrade from local-`.env`-only: secrets now have an environment-scoped,
encrypted, access-controlled home instead of a file on a laptop.

**Per-seller marketplace credentials** are unchanged from ADR-0001 §7
(AES-256-GCM envelope encryption in `src/secrets/credentialStore.ts`,
`CREDENTIAL_ENC_KEY` as the data key) — this ADR only changes *where the data
key itself lives* (Fly secret store instead of a local `.env`), not the
encryption scheme.

**Deferred, gated on real seller creds (per ADR-0001 §7):** move
`CREDENTIAL_ENC_KEY` to a managed KMS with rotation, add gitleaks/trufflehog
to CI, add audit logging on credential access. Fly's secret store is a real
upgrade over `.env` but is not itself a KMS — this is a two-step migration,
and step 2 is explicitly out of scope until CEO sign-off per the existing
gate.

## 5. Decision — alerting & observability baseline

`src/alerting/notifier.ts`: a Slack-compatible incoming-webhook notifier,
optional (`ALERT_WEBHOOK_URL` env var) — log-only (no network call) when
unset, which is the default in dev/test/CI so tests never depend on network
access. Three categories, matching the mandate's three signals:

- `sync_failure` — wired to `OrderSyncEngine`'s existing `onError` hook
  (`src/main.ts`). Fires once per failed sync cycle per connection.
- `rate_limit` — wired through each adapter's `retry.onRetry` hook (already
  present on `NaverHttpDeps`/`EsmHttpDeps`, unused until now) at the shared
  retry-policy level (`src/integrations/retry.ts`), so behaviour is
  identical across marketplaces per ADR-0001 §5. Fires only on an explicit
  server rate-limit signal (`MarketplaceError.retryAfterMs` set), throttled
  to one alert per marketplace per 5-minute window
  (`createAlertThrottle`) so a sustained rate limit doesn't spam.
- `settlement_mismatch` — category exists and is ready to use; **no
  detection logic yet**, because there is no settlement adapter (ADR-0001
  roadmap: ENG-Settlement-MVP, not started). When that lands, the
  reconciliation check calls `alerter.send({ category: "settlement_mismatch",
  ... })` at the comparison point. Not fabricating settlement logic here.

Structured pino logging is unchanged (ADR-0001 §8) — every alert also logs
via `{ alert: <category>, ... }` regardless of webhook configuration, so a
future hosted log aggregator's alert rules have something to key off even
before/without a webhook.

## 6. What is NOT done yet — explicit gate

This ADR's code (Dockerfile, `fly.*.toml`, `deploy.yml`, alerting module) is
implemented and tested (`npm test`, local Docker-equivalent build via `npm
run build && node dist/main.js` → `/health` verified). It **cannot run for
real** yet because:

1. **No Git remote.** The repo has never been pushed anywhere GitHub Actions
   could execute. Pushing to GitHub (creating an org/repo) is a small,
   reversible, near-zero-cost action — but touches account ownership outside
   this codebase, so flagged for CEO awareness rather than done unilaterally
   in this pass.
2. **No Fly.io account.** `arkain-staging`/`arkain-production` apps,
   `FLY_API_TOKEN`, and a managed Postgres (or Fly Postgres) instance for
   staging need to exist before `deploy.yml` can succeed. This is an external
   account + eventual billing decision (§2) — CEO approval requested.
3. **GitHub Environment protection rule** for `production` (required
   reviewer) is a repo Settings action, not code — needs to be configured by
   whoever has admin on the eventual GitHub repo.

None of this is Kubernetes-scale ceremony (mandate boundary respected) — it's
the minimum to make "push to master → staging is live, click a button →
production is live" true instead of aspirational.
