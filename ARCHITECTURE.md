# ARKAIN — Architecture Decision Doc (ADR-0001)

**Status:** Accepted (foundation committed) · **Owner:** Founding Engineer ·
**Date:** 2026-06-28 · **Issue:** ARK-2

This is the foundational architecture decision for ARKAIN. It records the stack
choice, the trade-offs considered, and the conventions the next hire inherits.
Subsequent ADRs append to `docs/adr/`.

- **ADR-0002** (`docs/adr/0002-multi-tenancy-b2b-b2c.md`, ARK-13): multi-tenant
  data isolation (`tenant_id` + PostgreSQL RLS, reusing `Seller` as the tenant
  boundary) and B2B/B2C order-level separation. Design only; ARK-10 implements
  the migration.
- **ADR-0003** (`docs/adr/0003-b2b-accounts-purchase-orders.md`, ARK-16): 거래처
  (`Account`) management + direct 대량발주 (`PurchaseOrder`) flow, deliberately
  **separate tables** from `Order`/`OrderItem` — not an extension of ADR-0002's
  `dealType` flag. Design + basic implementation done.

---

## 1. Context

ARKAIN is integration plumbing plus a clean operations UI: pull orders (then
products, then settlement) from many Korean marketplaces (네이버 스마트스토어,
쿠팡, 11번가, …), normalize them into one schema, and let a seller run everything
from one console. The gating proof point is the **order-sync MVP**: live orders
from 네이버 스마트스토어 in one unified dashboard.

The forces that should drive the stack choice, in priority order (from the
mandate):

1. **Order-sync MVP fast** — one engineer, demoable quickly.
2. **Correctness of seller money/order data** — a wrong number erodes trust
   permanently.
3. **An integration pattern that generalizes** — the second marketplace must be
   an adapter/config, not a rewrite.
4. Speed over polish/scale; no premature distributed-systems complexity.

## 2. Decision

**Language/runtime:** **TypeScript on Node.js (≥20).**
**HTTP framework:** **Fastify.**
**Database:** **PostgreSQL**, accessed via **Prisma** (typed client + migrations).
**Validation/config:** **zod** (env + external payload parsing).
**Logging:** **pino** (structured JSON, secret redaction).
**Frontend (later):** thin React UI, likely **Next.js**, in the same repo. Not
built yet — the MVP path is API + sync first.
**Process model:** a single deployable Node service. Background order polling
starts as an in-process scheduler; a queue (BullMQ + Redis) is introduced only
when sync volume justifies it.
**Packaging/deploy:** Docker image; **docker compose** for local Postgres. Host
on a single small container platform (Render / Fly.io / Korean cloud such as
NCP) — **no Kubernetes** for the MVP.

## 3. Why this stack

**One language, full stack.** TypeScript spans backend, the future UI, and
integration code. A solo founding engineer context-switches zero times, and the
normalized domain types are shared end to end. This directly serves priority #1
(speed) and #3 (a typed adapter contract).

**TypeScript types protect correctness (priority #2).** Order/settlement money
flows through explicitly typed, zod-validated boundaries. Marketplace JSON is
parsed and validated at the edge, not trusted. Money is stored/handled as
**integer KRW (minor units)** to avoid floating-point drift — see §6.

**Fastify over NestJS/Express.** Fastify gives schema-based validation, fast JSON
handling, first-class structured logging (pino), and a tiny surface — right for
an MVP. NestJS was considered (nice DI/module story that maps to adapters) but
its ceremony is overkill before the MVP is real (boundary: "no premature
abstractions"). Express is lighter on built-ins (validation, logging) and we'd
rebuild what Fastify ships. The adapter pattern (§5) gives us NestJS's main
benefit — clean per-marketplace modules — without the framework weight.

**PostgreSQL + Prisma.** Orders/settlement are relational and need correctness:
transactions, unique constraints (idempotent upserts on marketplace order IDs),
and money types. Postgres is the boring, correct default. Prisma gives a typed
client and a real migration history so the schema evolves safely — important
when hire #2 arrives. Trade-off: Prisma's generated client adds a build step
(`prisma generate`) and some abstraction over raw SQL; acceptable, and we can
drop to raw SQL via Prisma for hot paths.

**pino logging with redaction.** Structured JSON logs from day one (any
aggregator ingests them), with a redaction list so tokens/credentials/PII can't
leak through a stray log line (priority #2: don't betray seller trust).

## 4. Alternatives considered (and rejected, for now)

| Option | Why not (yet) |
| --- | --- |
| **Next.js full-stack (API routes + UI)** | Serverless route model fights long-running order polling, schedulers, and retry/backoff. We keep Next.js as the **UI layer later**, talking to this service. |
| **NestJS** | Good structure, but ceremony before MVP. Adapter pattern covers the need. |
| **Python (FastAPI) / Go / Kotlin** | All viable, but split the stack from the UI and slow a TS-fluent solo engineer. Go's perf isn't the bottleneck (marketplace rate limits are). |
| **MongoDB / NoSQL** | Settlement and orders are relational and correctness-critical; we want constraints and transactions. |
| **Kubernetes / microservices** | Explicitly out of scope for the MVP (mandate boundary). One service, scale later. |
| **Message queue (Kafka/BullMQ) on day one** | Premature. In-process scheduler first; add a queue when sync volume/retry needs it. |

## 5. The generalizing integration pattern (priority #3)

Every marketplace implements one contract — `src/integrations/marketplace.ts`:

```
interface MarketplaceAdapter {
  id: MarketplaceId;
  verifyCredential(cred): Promise<boolean>;
  fetchOrders(cred, params): Promise<FetchOrdersPage>;  // normalized + paged
}
```

The sync engine and domain model only ever see `MarketplaceAdapter` and the
**normalized** types (`NormalizedOrder`, etc.) — never marketplace-specific
shapes. Adding 쿠팡 means writing one `CoupangAdapter`, not touching the core.
Adapters raise `MarketplaceError{retryable}` so retry/backoff policy lives in one
place. The raw marketplace payload is retained on each normalized order for
audit when a number looks wrong.

`NaverSmartstoreAdapter` is now a **real implementation** (ARK-3): bcrypt-signed
OAuth2 auth, order + product pull, cursor pagination, shared retry. The contract
gained `NormalizedProduct` + an optional `fetchProducts`. Live verification is
gated on Naver credentials (CEO sign-off) — see
`docs/naver-commerce-integration.md`.

`EsmAdapter` (ARK-11, G마켓·옥션 ESM 2.0) is the **second** real implementation —
proves the pattern generalizes without touching the sync engine, domain model, or
`retry.ts`. Per-request JWT auth (no token-issuance round trip, unlike Naver),
order pull loops {storefront × status × time-window × page} since the API has no
"all statuses" mode, product pull is a single paged call. One confidence tier
below Naver: the wire format is transcribed from public docs, not a live account
(no ESM PLUS credentials exist yet). Live verification gated on CEO sign-off — see
`docs/esm-2.0-integration.md`. **Known gap:** `prisma/schema.prisma`'s
`Marketplace` enum does not yet include `esm_2_0` (deliberately left to ARK-10,
which was concurrently migrating that same file for tenant_id/RLS) — a real
ESM 2.0 connection cannot be persisted via `PrismaDomainStore` until that
one-line addition lands.

## 6. Correctness conventions (non-negotiable)

- **Money = integer KRW (minor units).** No floats for money, anywhere.
- **Idempotent upserts** keyed on `(marketplace, marketplaceOrderId)` so repeated
  syncs never double-count.
- **Every sync is audited** (`SyncRun` row: started/finished/status/ordersPulled/
  error) so any number is traceable to the run that produced it.
- **Validate at the edge.** All external JSON is zod-parsed before use.
- **UTC in storage, KST for display.** Marketplace timestamps normalized to ISO.

## 7. Secrets & credentials

**Principle: no real seller credentials in the repo, ever; a leaked DB dump must
not expose seller marketplace tokens.**

- **Local dev:** `.env` (git-ignored; `.env.example` is the template). CI fails
  if any `.env` is ever tracked (`secret-scan` job).
- **Staging/prod:** secrets injected by the platform secret manager (cloud
  KMS / Vault / SOPS), never committed, never in the DB in plaintext.
- **Seller marketplace credentials:** envelope-encrypted with **AES-256-GCM**
  before persistence (`src/secrets/credentialStore.ts`). The data key
  (`CREDENTIAL_ENC_KEY`) lives in the secret manager and is versioned for
  rotation. Ciphertext + IV + auth tag + key version are stored in
  `MarketplaceConnection`; plaintext exists only in memory, briefly, during a
  sync call.
- **Just-in-time access:** adapters receive a decrypted credential only for the
  duration of the call. No broad standing access.
- **App-level marketplace keys** (the ARKAIN app's own Naver/Coupang client
  credentials) are env/secret-manager values, distinct from per-seller tokens.

**Production hardening before real seller creds are touched** (gated on explicit
CEO sign-off): move the data key to a managed KMS, add a dedicated secret scanner
(gitleaks/trufflehog) to CI, and add audit logging on credential access.

## 8. CI / environments / observability baseline

- **CI** (`.github/workflows/ci.yml`): `npm ci` → `prisma generate` → typecheck →
  build → test, plus a `secret-scan` job that blocks committed `.env` files.
- **Environments:** `development` (local), `test` (CI/vitest), `staging`,
  `production` — selected by `NODE_ENV`, all config validated by zod at boot so a
  missing/bad var fails loudly instead of corrupting data later.
- **Logging:** pino JSON with redaction; request logging via Fastify. Metrics/
  tracing deferred until there's traffic to observe.
- **Health:** `/health` liveness today; readiness checks (DB, marketplace
  reachability) added alongside those subsystems.

## 9. What this is NOT (scope guardrails)

No real marketplace calls yet, no UI yet, no queue, no k8s, no multi-service
split, and only a foundation slice of the domain model. Those are sequenced in
the roadmap below — deliberately, to keep the MVP path short.

## 10. Roadmap (gated MVP path)

1. **ARK-2 ENG-Foundation** — this doc + booting skeleton + CI/secrets. ✅
2. **ENG-Naver-Spike (ARK-3)** — real 네이버 커머스 API auth + order/product pull.
   ✅ adapter implemented + mock-tested; live run blocked on creds (CEO).
3. **ENG-Domain-Model (ARK-4)** — unified product/order/settlement schema +
   Naver mapping. ✅ `Order`/`OrderItem`/`Product` tables + status mapping
   implemented and unit-tested; `Settlement` is a foundation-only slice
   (mapping lands with ARK-7, no adapter produces settlement data yet). See
   `docs/domain-model.md`.
4. **ENG-Orders-MVP (ARK-5)** — sync engine + unified order dashboard. ✅
   implemented and unit-tested (poll loop, cursor resume, dashboard UI/API);
   live Naver data still gated on ARK-3's credential blocker. See
   `docs/order-sync-mvp.md`.
5. **ENG-Products-MVP**, 6. **ENG-Settlement-MVP** — after the order loop is proven.
6. **Multi-tenancy + B2B/B2C design (ARK-13)** — ✅ design complete, see
   ADR-0002 above. Domain model currently has **no tenant scoping at all**
   (flagged as a correctness gap, not just isolation, in ADR-0002 §1); ARK-10
   implements the `tenant_id`/RLS migration this design specifies.
7. **B2B module: 거래처 + 대량발주 (ARK-16)** — ✅ design + basic implementation.
   `Account`/`AccountPriceListEntry`/`PurchaseOrder`/`PurchaseOrderItem` are new
   tables, tenant-scoped at the application layer pending ARK-10's RLS policy
   set. See ADR-0003 above and `docs/b2b-module.md`.

## 11. One-way vs two-way doors

Most of this is **reversible** early (framework, hosting, even DB-via-Prisma can
be swapped while data volume is tiny). The genuinely sticky commitments are:
**(a)** TypeScript as the language, **(b)** PostgreSQL as the system of record,
and **(c)** the `MarketplaceAdapter` normalization boundary. These three are the
ones worth CEO awareness; all are mainstream, low-regret choices aligned with the
mandate. Proceeding without blocking — **raise objections on ARK-1 before the
Naver spike if you disagree.**
