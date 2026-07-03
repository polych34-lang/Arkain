# Deployment runbook (ARK-28)

Rationale/trade-offs: `docs/adr/0004-deployment-secrets-alerting-baseline.md`.
This doc is the operational how-to.

## Status

**Staging is live**: https://arkain-staging.fly.dev — deploys automatically
on every push to `master`. Demo login: `demo@arkain.dev` / `demo1234!`
(seeded via `node dist/scripts/seed-demo-orders.js` over `fly ssh console`,
since the production image has no `tsx`/`src` — see ARK-64). Production is
provisioned but not yet deployed (manual, reviewed `workflow_dispatch` — see
"Deploy" below).

## Local build/run (unchanged, still the fastest inner loop)

```bash
npm install
cp .env.example .env
docker compose up -d      # local Postgres only
npm run db:generate
npm run dev                # http://localhost:3000/health
```

## Building the production image locally

```bash
docker build -t arkain:local .
docker run --rm -p 3000:3000 --env-file .env -e NODE_ENV=production arkain:local
curl http://localhost:3000/health
```

(No Docker available in the environment this was authored in — verified
instead via the exact same steps the Dockerfile runs: `npm run db:generate
&& npm run build`, then `node dist/main.js`, then `curl /health`. Re-run the
`docker build` above once Docker is available to confirm parity.)

## CI (`.github/workflows/ci.yml`)

Runs on every PR and on push to `master`: typecheck → build → test →
secret-scan → docker-build (sanity build, no push). Unchanged in spirit from
the Founding Engineer's baseline; this issue fixed the push trigger
(`main` → `master`, the repo's actual default branch — CI never fired
before) and added the `docker-build` sanity job.

## Deploy (`.github/workflows/deploy.yml`)

- **staging**: automatic on every push to `master`, after CI is green.
- **production**: manual only — Actions tab → "Deploy" workflow → "Run
  workflow" → target = `production`. Additionally requires an approval click
  from a `production`-environment reviewer (GitHub Environment protection
  rule, configured once in repo Settings, not in this file).

Both jobs: build once → push to `ghcr.io/<repo>:<sha>` → `flyctl deploy` the
exact pushed image. Deploy runs `fly.{staging,production}.toml`'s
`release_command` (`prisma migrate deploy`) in a temporary machine on Fly's
private network **before** promoting the new release — a plain GitHub-hosted
runner cannot reach a Fly Postgres app's `.flycast` address directly, so
migrations can't run from the Actions job itself. Migration-before-deploy
ordering means a migration failure blocks the deploy instead of shipping code
the schema doesn't support yet.

## One-time setup (human/CEO action — not done by this issue)

1. **Push this repo to a real Git remote** (GitHub). Nothing in
   `.github/workflows/` executes without one.
2. **Create the hosting account** — recommendation is Fly.io (ADR-0004 §2);
   flag if you'd rather use Render or NCP instead, the deploy job would need
   a different (but similarly small) deploy step.
   - `fly apps create arkain-staging --org <org>`
   - `fly apps create arkain-production --org <org>`
   - `fly postgres create` (staging first; share/replicate for prod per your
     budget — a managed single instance is enough at MVP scale)
   - `fly tokens create deploy -a arkain-staging` / `-a arkain-production`
3. **Register GitHub Environments** (repo Settings → Environments):
   - `staging`: add secret `FLY_API_TOKEN`.
   - `production`: same secret pointing at the production app, **plus** a
     required-reviewer protection rule so `deploy-production` pauses for a
     human click.
4. **Set the app-level runtime secrets** once per Fly app (not via GitHub —
   see ADR-0004 §4 for why). This now includes `DATABASE_URL`, since the
   migration (`release_command`) runs on the Fly app itself, not in CI, and
   `SESSION_SECRET` (ARK-57 login/signup — `main.ts`'s `buildSyncDeps` won't
   wire up `auth`/`products` without `DATABASE_URL` **and**
   `CREDENTIAL_ENC_KEY` **and** `SESSION_SECRET` all three set; staging ran
   for a while with only `DATABASE_URL` set, which silently disabled
   login/products/order-sync — check `fly secrets list -a <app>` has all
   three before assuming a deploy is fully wired):
   ```bash
   fly secrets set -a arkain-staging \
     DATABASE_URL="postgres://postgres:<password>@arkain-staging-db.flycast:5432/postgres?sslmode=disable" \
     CREDENTIAL_ENC_KEY=$(openssl rand -base64 32) \
     SESSION_SECRET=$(openssl rand -hex 32) \
     NAVER_COMMERCE_CLIENT_ID=... \
     NAVER_COMMERCE_CLIENT_SECRET=... \
     ALERT_WEBHOOK_URL=https://hooks.slack.com/services/...
   # repeat for arkain-production with production values
   ```
   `sslmode=disable` is required — Fly's internal Postgres proxy port
   (`.flycast:5432`) doesn't terminate TLS, and Prisma's default SSL
   negotiation fails there with `P1011: Error opening a TLS connection:
   unexpected EOF`. Traffic between apps in the same Fly org already runs
   over an encrypted WireGuard mesh, so this doesn't lose the encryption
   Postgres SSL would have added.

Once those four are done, `git push` to `master` deploys staging
automatically; production is one manual, reviewed click away.

## Seeding the demo account (ARK-57/ARK-64)

The production image only ships `dist/` (compiled JS), not `src/` or `tsx`,
so `npm run seed:demo` doesn't work as-is against a deployed app — run the
compiled script instead, over `fly ssh console`:

```bash
fly ssh console -a arkain-staging -C "node dist/scripts/seed-demo-orders.js"
```

This seeds 5 demo orders and the demo login (`demo@arkain.dev` /
`demo1234!`). Re-running is safe (idempotent on the demo tenant). It talks to
`DATABASE_URL` directly, so it works even if `SESSION_SECRET` /
`CREDENTIAL_ENC_KEY` aren't set yet — but login won't work until those are
(see "Set the app-level runtime secrets" above).

## Alerting

`ALERT_WEBHOOK_URL` (Slack-compatible incoming webhook) drives
`src/alerting/notifier.ts`. Unset in any environment ⇒ alerts are
structured-logged only (`{ alert: "sync_failure" | "rate_limit" |
"settlement_mismatch", ... }`), never a network call — safe default,
including in CI/tests. See ADR-0004 §5 for what's wired today vs. deferred
(settlement mismatch has no detection logic yet — no settlement adapter
exists).

## Rotating `CREDENTIAL_ENC_KEY`

Not yet implemented (no seller has a stored credential yet — ADR-0001 §7
gates this on real seller creds). When it's needed: `EnvelopeCredentialStore`
already carries a key version field per stored credential
(`src/secrets/credentialStore.ts`), so rotation is "set a new Fly secret,
deploy, re-encrypt existing rows under the new version, retire the old one"
— not a breaking change to the storage format.
