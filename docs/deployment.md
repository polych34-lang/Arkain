# Deployment runbook (ARK-28)

Rationale/trade-offs: `docs/adr/0004-deployment-secrets-alerting-baseline.md`.
This doc is the operational how-to.

## Status

Pipeline code is implemented and locally verified. **Not yet live** — see
"One-time setup" below for the three prerequisites (Git remote, Fly.io
account, GitHub Environment protection) that a human/CEO needs to complete
once. Everything else is automatic after that.

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

Both jobs: build once → push to `ghcr.io/<repo>:<sha>` → run
`prisma migrate deploy` against that environment's `DATABASE_URL` → `flyctl
deploy` the exact pushed image. Migration-before-deploy ordering means a
migration failure blocks the deploy instead of shipping code the schema
doesn't support yet.

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
   - `staging`: add secrets `FLY_API_TOKEN`, `DATABASE_URL` (the staging
     Postgres connection string).
   - `production`: same two secrets pointing at production infra, **plus** a
     required-reviewer protection rule so `deploy-production` pauses for a
     human click.
4. **Set the app-level runtime secrets** once per Fly app (not via GitHub —
   see ADR-0004 §4 for why):
   ```bash
   fly secrets set -a arkain-staging \
     CREDENTIAL_ENC_KEY=$(openssl rand -base64 32) \
     NAVER_COMMERCE_CLIENT_ID=... \
     NAVER_COMMERCE_CLIENT_SECRET=... \
     ALERT_WEBHOOK_URL=https://hooks.slack.com/services/...
   # repeat for arkain-production with production values
   ```

Once those four are done, `git push` to `master` deploys staging
automatically; production is one manual, reviewed click away.

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
