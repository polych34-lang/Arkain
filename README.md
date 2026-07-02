# ARKAIN

Multi-market seller management for Korean sellers (a 사방넷-class tool). Unifies
주문관리 · 상품등록 · 매출·정산 across 네이버 스마트스토어, 쿠팡, and other
marketplaces into one operations console.

**Current milestone:** order-sync MVP — pull orders from 네이버 스마트스토어 into
one unified dashboard. See `ARCHITECTURE.md` for the stack decision and roadmap.

## Stack (TL;DR)

TypeScript · Node.js · Fastify · PostgreSQL (Prisma) · pino logging. Marketplace
integrations follow a single `MarketplaceAdapter` contract so adding a market is
an adapter, not a rewrite. Full rationale in `ARCHITECTURE.md`.

## Quick start

```bash
npm install
cp .env.example .env          # dev defaults; never commit a real .env
docker compose up -d          # local Postgres (optional until DB is wired)
npm run db:generate           # generate Prisma client
npm run dev                   # http://localhost:3000/health
```

Verify it's up:

```bash
curl http://localhost:3000/health
# {"status":"ok","service":"arkain",...}
```

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run with hot reload (tsx) |
| `npm run build` / `npm start` | Compile to `dist/` and run |
| `npm run typecheck` | Strict type check, no emit |
| `npm test` | Vitest unit/route tests |
| `npm run db:migrate` | Prisma migration (dev) |

## Layout

```
src/
  app.ts                      Fastify app factory (routes; testable via inject)
  main.ts                     Process entrypoint + graceful shutdown
  config/env.ts               Validated config (zod); single source of env truth
  logging/logger.ts           pino structured logging with secret redaction
  alerting/notifier.ts        Ops alerting: sync failure / rate limit / settlement mismatch
  integrations/
    marketplace.ts            MarketplaceAdapter contract + normalized types
    naver/naver.adapter.ts    네이버 스마트스토어 adapter (stub → ENG-Naver-Spike)
  secrets/credentialStore.ts  AES-256-GCM envelope encryption for seller creds
prisma/schema.prisma          Foundation schema (Seller, Connection, SyncRun)
test/                         Vitest tests
Dockerfile, fly.*.toml        Production image + Fly.io staging/production config
.github/workflows/ci.yml      CI: typecheck, build, test, secret-scan, docker-build
.github/workflows/deploy.yml  Deploy: build+push image, migrate, flyctl deploy
```

## Secrets

No real seller credentials in the repo, ever. Local dev uses `.env`
(git-ignored); staging/prod inject secrets from the platform secret manager.
Seller marketplace credentials are envelope-encrypted before persistence. See
`ARCHITECTURE.md` → "Secrets & credentials".

## Deployment

See `docs/deployment.md` for the staging/production runbook and
`docs/adr/0004-deployment-secrets-alerting-baseline.md` for the rationale.
Not live yet — pipeline is implemented but gated on a Git remote + hosting
account (CEO action, see that doc).
