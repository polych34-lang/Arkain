# ADR-0002 — Multi-tenancy (tenant_id + RLS) and B2B/B2C separation

**Status:** Accepted (design) · **Owner:** Founding Engineer ·
**Date:** 2026-07-01 · **Issue:** ARK-13 · **Decision source:** ARK-9 decision-log
(2026-07-01) · **Implements into:** ARK-10 (migration + RLS), ARK-11/ARK-12 (ESM
adapter, sequenced after this lands)

This is a design doc, not an implementation. ARK-13's deliverable is the
approach; ARK-10 executes the schema migration + RLS policy + isolation test
against it.

---

## 1. Context

ARK-9's decision-log confirmed the product direction: ARKAIN (working name
"SellerDesk") is a multi-tenant SaaS serving many seller companies from one
deployment, benchmarked against 사방넷/플레이오토. Two concerns fall out of
that, and this issue is scoped to design both:

1. **Multi-tenancy** — data isolation between ARKAIN's own customers (sellers).
   Decision already made in ARK-9: **shared DB + `tenant_id` + PostgreSQL RLS**,
   explicitly **not** Supabase.
2. **B2B/B2C separation** — within one tenant, distinguishing marketplace
   consumer orders from direct wholesale/business orders, matching the
   competitor benchmarking finding.

### Current state (gap analysis)

The ARK-4/ARK-5 domain model was built for a single implicit seller and has
**no tenant scoping at all** today:

- `Order`, `OrderItem`, `Product`, `Settlement` have no `sellerId`/`tenantId`
  column or relation (`prisma/schema.prisma`). Only `MarketplaceConnection` and
  `SyncRun` relate to `Seller`.
- The idempotent upsert key is globally `(marketplace, marketplaceOrderId)`
  (`src/domain/repository.ts:63-68`, `:87-91`). Across two different sellers'
  stores this is not just a privacy gap — Naver order IDs are only guaranteed
  unique **per seller account**, so two tenants' orders can collide on this
  key today. This is a correctness bug waiting for a second real seller, not
  just an isolation gap.
- `OrderSyncEngine.upsertOrders` (`src/sync/orderSyncEngine.ts:41`) and
  `PrismaDomainStore.upsertOrders` (`src/domain/repository.ts:61`) take
  `NormalizedOrder[]` only — `ActiveConnection.sellerId`
  (`src/domain/repository.ts:37`) is loaded but never threaded through to the
  write. The seller identity is dropped exactly where it needs to attach.
- There is no auth/session layer at all (`src/app.ts`) — `/api/orders` and the
  dashboard serve one global order list to anyone. Tenant-scoping the data
  model is necessary but not sufficient; something must also establish "which
  tenant is this request for" before RLS has anything to filter on.

## 2. Decision — multi-tenancy

### 2a. Tenant boundary: reuse `Seller`, don't introduce a new `Tenant` table yet

`Seller` already represents one ARKAIN customer. Nothing in the ARK-9 decision
log or the current roadmap requires one paying customer to own multiple
`Seller` records (e.g. an agency managing several client stores under one
contract) — that's a plausible future shape, not a confirmed one.

**Decision:** add `tenantId` columns that are, for now, literally `Seller.id`
(one seller == one tenant). Do not add a separate `Tenant` model today.

Why: per the mandate's "no premature abstractions" boundary — an extra
`Tenant → many Seller` layer is speculative until an agency/multi-store
customer is real. The upgrade path stays cheap: if that need appears, insert
`Tenant` above `Seller`, add `Seller.tenantId → Tenant.id` (backfill 1:1,
non-breaking), and every downstream `tenantId` column is unaffected because it
was never named `sellerId`. Naming the column `tenantId` (not `sellerId`) now
is what keeps that door open — see §5.

### 2b. Schema change

Add `tenantId String` (FK → `Seller.id`) to `Order`, `OrderItem` (via `Order`,
not duplicated), `Product`, `Settlement`, `MarketplaceConnection`, `SyncRun`.
Re-scope the idempotent unique keys to include it:

```prisma
model Order {
  tenantId           String
  seller             Seller      @relation(fields: [tenantId], references: [id])
  // ...existing fields...
  @@unique([tenantId, marketplace, marketplaceOrderId])
}

model Product {
  tenantId String
  // ...
  @@unique([tenantId, marketplace, marketplaceProductId])
}

model Settlement {
  tenantId String
  // ...
  @@index([tenantId, marketplace, marketplaceOrderId])
}
```

`OrderItem` does not need its own `tenantId` — it's only ever reached via its
parent `Order`, and RLS on `Order` plus the `onDelete: Cascade` FK already
scopes it. Adding a redundant column there would be the kind of copy-paste
scoping that drifts out of sync; keep the boundary on the row that owns the
identity.

**Migration order** (so this ships without downtime on top of existing demo
data): add `tenantId` nullable → backfill (existing rows get a `default`
Seller created for local/demo data) → make `NOT NULL` → add the composite
unique/index → enable RLS. This is a standard Prisma migration; ARK-10 owns
running it.

### 2c. RLS policy design

Postgres RLS filters rows by a **session-local variable**, set once per
request/transaction, not per query:

```sql
ALTER TABLE "Order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Order" FORCE ROW LEVEL SECURITY; -- applies even to the table owner
CREATE POLICY tenant_isolation ON "Order"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- repeat per tenant-scoped table
```

The app's Postgres role must **not** have `BYPASSRLS` (that's the default for
non-superuser roles Prisma migrations create, but verify explicitly — the
Postgres table owner bypasses RLS unless `FORCE ROW LEVEL SECURITY` is set,
hence including it above).

**Prisma integration** — Prisma has no native RLS/session-variable concept, so
tenant context is set via a thin wrapper, not scattered `SET LOCAL` calls:

```ts
// src/tenancy/tenantContext.ts (new, ARK-10)
export function forTenant(prisma: PrismaClient, tenantId: string) {
  return prisma.$extends({
    query: {
      $allOperations({ args, query }) {
        return prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
          return query(args);
        });
      },
    },
  });
}
```

Every request-scoped Prisma call goes through `forTenant(prisma, tenantId)`
instead of the raw client. This is the one non-trivial engineering piece —
everything else is standard Postgres/Prisma, so **the current stack needs no
framework change** (see §4).

### 2d. Tenant context propagation — the missing piece

RLS needs a `tenantId` to set, and today nothing identifies the caller. This
issue's scope is design, but it must name this gap so ARK-10 doesn't
discover it mid-migration: **there is no auth/session layer yet**
(`src/app.ts` has no request-scoped identity at all). For the MVP, the
recommendation is the smallest thing that unblocks ARK-10/ARK-11's isolation
test without building real seller login:

- A per-request `x-tenant-id` header (or API key → tenant lookup) validated
  against `Seller`, read once in a Fastify `preHandler`, attached to
  `req.tenantId`. Real seller authentication (login, session, per-seller API
  keys) is separable follow-up work, not blocking this design or ARK-10's
  schema/RLS/isolation-test deliverable — it blocks *exposing* the dashboard to
  real sellers, which is already sequenced after the order-sync MVP proof
  point.
- Internal jobs (the sync scheduler) already have `tenantId` for free — it's
  `ActiveConnection.sellerId` (`src/domain/repository.ts:37`), just not
  threaded through yet. Fixing that threading (`OrderSyncEngine.syncConnection`
  → `upsertOrders(orders, tenantId)`) is in scope for ARK-10.

## 3. Decision — B2B/B2C separation

### 3a. What it is

Per ARK-9's competitor benchmarking, B2B/B2C is **not** about the seller's own
tier (every ARKAIN customer is a business) — it's about **the deal type of
each order**: marketplace consumer sales (B2C — what ARK-3/ARK-5 already
handle) versus direct wholesale/business orders (B2B — different buyer
identity, tax invoice requirements, and typically no marketplace commission).
Sellers in 유통·건강식품·제조 commonly run both side by side, which is exactly
the gap 사방넷/플레이오토 both address with a B2B/B2C split.

### 3b. Schema

A `dealType` enum on `Order`, **not** a parallel table or separate service —
one Order table stays the single source of truth for the dashboard, sync
engine, and settlement linkage already built:

```prisma
enum DealType {
  B2C
  B2B
}

model Order {
  dealType              DealType @default(B2C)
  businessBuyerName     String?  // B2B only
  businessRegistrationNo String? // 사업자등록번호, B2B only
  taxInvoiceStatus      String?  // 세금계산서 상태, B2B only
  // ...
}
```

Every marketplace-sourced order normalizes to `B2C` (no adapter changes
needed — `NormalizedOrder` gains an optional `dealType` that defaults to
`B2C` when absent, so ARK-3's Naver mapper needs zero changes). A future
direct/wholesale entry path (manual entry, ERP import — out of scope here)
would be the first producer of `B2B` rows through the same normalized
pipeline, consistent with the `MarketplaceAdapter` boundary in
ARCHITECTURE.md §5.

`Product` does **not** get a `dealType` — a catalog listing isn't inherently
B2B or B2C; the deal type is a property of the transaction, not the item. This
avoids duplicating the split onto a model where it doesn't apply.

### 3c. API / dashboard

- `OrderListFilter` (`src/domain/repository.ts:27`) gains `dealType?: DealType`,
  same pattern as the existing `marketplace`/`status` filters.
- `renderOrdersDashboard` (`src/web/ordersDashboard.ts`) gains a B2B/B2C tab or
  toggle above the existing table — two filtered views over the same
  `/api/orders` endpoint, not two pages/services. Matches competitor UX
  without adding backend surface area.

## 4. Stack fit — confirmed, no change needed

TypeScript/Fastify/PostgreSQL+Prisma (ARCHITECTURE.md §2) supports this
decision as-is:

- **PostgreSQL RLS** is a database feature, orthogonal to the app framework —
  Fastify needs nothing beyond the `preHandler` that resolves `req.tenantId`.
- **Prisma** has no native RLS/session-variable API, but the `$extends`
  wrapper in §2c is the standard, documented pattern for this (Prisma issue
  #ORM-based RLS is a known gap, not a bug we're working around specially) —
  a few dozen lines, applied once at the client-construction site.
- **No Supabase** — already excluded by ARK-9; nothing here depends on it.
- **B2B/B2C** is a plain enum + optional columns; no schema paradigm change.

Conclusion: this is additive engineering on the existing stack, not a
re-architecture. The one new piece of infrastructure is the tenant-context
wrapper (§2c) and the request-scoping `preHandler` (§2d) — both small,
neither framework-level.

## 5. One-way vs two-way doors

Per ARCHITECTURE.md §11's framing, most of this is reversible:

- **Reversible:** the `dealType` enum, the API filter, the dashboard tab — all
  additive, no data migration risk if the shape needs to change.
- **Cheap to extend later:** `Seller`-as-tenant today, `Tenant` model later
  (§2a) — deliberately designed so that split is additive, not a rewrite.
- **Sticky:** the RLS-based isolation model itself (vs. e.g. per-tenant
  schemas or per-tenant databases) is the one commitment worth CEO awareness —
  it's mainstream and matches ARK-9's explicit instruction, low-regret, but
  changing isolation strategy later means a real data migration. Proceeding
  without blocking, consistent with how ARCHITECTURE.md §11 handled the
  original stack ADR — raise objections if you disagree before ARK-10 starts
  the migration.

## 6. Sequencing

1. **ARK-13 (this doc)** — design. Done.
2. **ARK-10** — schema migration (§2b), RLS policies (§2c), tenant-context
   wrapper, thread `tenantId` through `OrderSyncEngine`/`PrismaDomainStore`,
   isolation test (tenant A cannot read tenant B's rows, via both a raw query
   and the Prisma-extended client).
3. **B2B/B2C schema (§3)** can land in the same migration as ARK-10 (it's a
   small additive change) or as an immediate follow-up — implementation detail
   for whoever picks up ARK-10, not a blocking design decision here.
4. **ARK-11/ARK-12 (ESM adapter)** — already sequenced by their own
   descriptions to start after this lands, so new marketplace rows are
   tenant-scoped from day one instead of needing a backfill later.
