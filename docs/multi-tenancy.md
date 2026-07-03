# Multi-tenancy migration (ARK-10)

**Status:** schema + RLS migration + tenant-context wrapper implemented and
unit-tested. Implements the design in
[ADR-0002](adr/0002-multi-tenancy-b2b-b2c.md) (ARK-13). **Not yet exercised
against a live Postgres** (no `DATABASE_URL` reachable in this environment —
same mechanical gap as ARK-4/ARK-5, see "Sandbox verification" below).

## What this is

ARK-9's decision log: ARKAIN is a multi-tenant SaaS serving many seller
companies from one deployment — shared DB + `tenant_id` + PostgreSQL RLS,
explicitly not per-tenant databases/schemas or Supabase. ADR-0002 designed the
approach; this is the implementation.

### The bug this closes

Before this migration, `Order`/`Product`/`Settlement` had **no tenant scoping
at all** — the idempotent upsert key was globally `(marketplace,
marketplaceOrderId)`. Two different sellers' stores could collide on that key
today; it wasn't just a privacy gap, it was a live correctness bug waiting for
a second real seller.

## Tenant boundary: `Seller`, not a new `Tenant` model

Per ADR-0002 §2a: `Seller` already represents one ARKAIN customer, and nothing
in the roadmap requires one customer to own multiple `Seller` rows yet. Every
new column is named `tenantId` (not `sellerId`) specifically so that if an
agency/multi-store customer becomes real later, a `Tenant` model can be
inserted above `Seller` (`Seller.tenantId -> Tenant.id`, backfilled 1:1) without
renaming anything downstream.

## Schema (`prisma/schema.prisma`)

- `Order`, `Product`, `Settlement` gain a **required** `tenantId String` (FK ->
  `Seller.id`). Required, not nullable, because no migration has ever been
  applied against a live database in this project (confirmed: `prisma/migrations/`
  didn't exist before this issue) — there is no pre-existing data to backfill,
  so the nullable→backfill→`NOT NULL` sequence ADR-0002 describes for a live
  system isn't needed here; this migration starts at the target end state
  directly.
- Unique/index keys are rescoped: `Order` and `Product` use
  `@@unique([tenantId, marketplace, marketplaceOrderId/marketplaceProductId])`;
  `Settlement` indexes `[tenantId, marketplace, marketplaceOrderId]`.
- **`OrderItem` deliberately has no `tenantId` of its own** (ADR-0002 §2b) —
  it's only ever reached via its parent `Order` (nested create/include,
  cascade delete) in every query path this app has today. A denormalized copy
  would be copy-paste scoping that can drift out of sync. **Residual gap this
  accepts:** a future direct/raw query against `OrderItem` alone (not via
  `Order`) would not be RLS-protected or tenant-filtered. If that query pattern
  is ever added, add `tenantId` + RLS to `OrderItem` at that point.
- `Marketplace` enum gained `esm_2_0` as a one-line fast-follow flagged by the
  concurrently-landed ARK-11 (ESM 2.0 adapter) commit, which correctly avoided
  editing this same file while this migration was in flight.

## Migrations (`prisma/migrations/`)

Two migrations, hand-authored (see "Sandbox verification" for why):

1. `20260701000000_init_domain_model` — the full baseline schema (every model
   to date), generated via `prisma migrate diff --from-empty
   --to-schema-datamodel prisma/schema.prisma --script`. This is the first
   migration ever committed for this project.
2. `20260701000001_tenant_rls_policies` — RLS: enables + forces row level
   security on `Order`, `Product`, `Settlement`, creates a least-privileged
   `arkain_app` Postgres role (no password committed — set one via the secret
   manager, per ARCHITECTURE.md §7), and grants it table access.

Run them the normal way once a real Postgres is reachable:
`docker compose up -d && npm run db:migrate` (dev) or `npm run db:deploy`
(staging/prod).

### Why Order/Product/Settlement only, not MarketplaceConnection/Seller/SyncRun

`MarketplaceConnection`/`SyncRun` already have a `sellerId`/transitive tenant
reference. They're deliberately **not** RLS-protected in this migration: the
in-process sync scheduler (`OrderSyncEngine.startScheduler` via
`listActiveConnections()`) needs to enumerate every tenant's active
connections in one query to run its poll loop. Enabling RLS on
`MarketplaceConnection` would block that unless the scheduler used a second,
privileged DB role — a real design decision (how does a cross-tenant
background job authenticate) that ADR-0002 didn't resolve and this issue
doesn't need to force. Flagged as a follow-up, not silently skipped.

## RLS policy design

```sql
ALTER TABLE "Order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Order" FORCE ROW LEVEL SECURITY; -- applies even to the table owner
CREATE POLICY tenant_isolation ON "Order"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
```

`current_setting(..., true)` (the `missing_ok` argument) returns `NULL`
instead of raising when the session variable isn't set, and `x = NULL` is
never true in SQL — so a connection with no tenant context set sees **zero**
rows. Fail closed, not fail open.

Deviation from ADR-0002's literal SQL sample: the sample casts
`current_setting(...)::uuid`. `Seller.id`/`tenantId` are Prisma `String @id
@default(uuid())` columns, which map to Postgres `TEXT`, not the native
`uuid` type — so the cast would fail to compile against the actual schema.
The policies here compare as `TEXT`, matching the real column type.

### This only works if the app doesn't connect as a superuser

Table owners and Postgres superusers bypass RLS regardless of `FORCE ROW
LEVEL SECURITY`. Local dev's `docker-compose.yml` Postgres user (`postgres`)
is a superuser — **RLS is inert in local dev by default.** To actually
exercise it locally: after running migrations, `ALTER ROLE arkain_app WITH
PASSWORD '...'` (pick a dev password, don't commit it) and point a second
`DATABASE_URL` at `arkain_app` instead of `postgres` for whatever you're
testing.

## Tenant-context wrapper (`src/tenancy/tenantContext.ts`)

Prisma has no native RLS/session-variable API. Per ADR-0002 §2c, `forTenant`
is a `$extends` client extension: every operation issued through the
returned client runs inside a transaction that first sets `app.tenant_id`
via `set_config(..., true)` (transaction-local, like `SET LOCAL`). This is
the officially documented Prisma pattern for RLS.

This is **defense-in-depth**, not the primary defense — `domain/repository.ts`
also filters explicitly by `tenantId` in application code (see below). RLS
matters when the app connects as `arkain_app`; the explicit filters matter
regardless of DB role, including in this repo's own test suite, which has no
real Postgres to enforce RLS against at all.

## `PrismaDomainStore` changes (`src/domain/repository.ts`)

- `upsertOrders(orders, tenantId)` / `upsertProducts(products, tenantId)` —
  `tenantId` is now a required parameter, threaded through `forTenant` and
  into the compound unique key. The sync engine supplies it for free: it's
  `SellerCredential.sellerId`, decrypted per connection already — see
  `OrderSyncEngine.syncConnection`'s call to
  `store.upsertOrders(page.orders, conn.credential.sellerId)`.
- `listOrders(filter)` — `filter.tenantId` is **optional**. When set, reads
  run through `forTenant` and filter explicitly by tenant. When omitted, it's
  a plain global read — today's `/api/orders` dashboard has no per-request
  tenant to supply (see "What's still missing" below). That global path is
  only safe from a privileged (superuser/`BYPASSRLS`) DB connection.

## `credentialStore.ts` — confirmed and hardened

The issue asked to confirm marketplace credentials are automatically
separated per tenant. `MarketplaceConnection` is already unique per
`(sellerId, marketplace)`, so credential rows were already structurally
scoped. But `EnvelopeCredentialStore.get()` had a latent gap: AES-256-GCM
decryption didn't cryptographically bind the ciphertext to the seller it
belongs to — `sellerId` on `StoredCredential` was trusted metadata, not an
enforced guarantee. If a future bug ever attached seller B's encrypted
connection row to seller A's context, `get()` would have silently decrypted
and returned seller B's real marketplace token to seller A.

**Fix:** `put`/`get` now pass `` `${sellerId}:${marketplace}` `` as AES-GCM
additional authenticated data (AAD). A `StoredCredential` decrypted with a
mismatched `sellerId`/`marketplace` now fails auth-tag verification (throws)
instead of returning the wrong seller's secret. See
`test/credentialStore.test.ts`.

## Reused by ARK-35 (`Customer`)

`Customer` (`prisma/migrations/20260703000000_customers_activity_view`)
reuses this exact pattern — `ENABLE`/`FORCE ROW LEVEL SECURITY`, the same
`tenant_isolation` policy shape, the same `arkain_app` grant — rather than
inventing a second one. See `docs/domain-model.md` "Customer identity
(ARK-35)" for what's new there (the table itself, `Order.customerId`, and the
`customer_activity` VIEW).

## What's still missing (explicitly out of scope for this issue)

- **No HTTP-level tenant auth.** `/api/orders` and the dashboard have no
  session/login layer (ADR-0002 §2d flags this as separable follow-up work,
  not blocking this issue's schema/RLS/isolation-test deliverable). Until it
  lands, the dashboard is the pre-launch global ops view described above.
- **B2B/B2C `dealType`** (ADR-0002 §3) — explicitly deferred by the ADR
  itself ("implementation detail for whoever picks up ARK-10, not a blocking
  design decision"). Not implemented here; a natural next issue.
- **`MarketplaceConnection`/`SyncRun` RLS** — see above; needs a privileged
  scheduler role design first.

## Sandbox verification

This environment has no reachable Postgres (no Docker) — the same
constraint noted in `docs/order-sync-mvp.md`. What was actually verified:

- **Migration SQL correctness**: both migrations were applied against a real
  (if limited) Postgres-compatible engine — `@electric-sql/pglite`
  (WebAssembly Postgres) via its socket-server wire-protocol bridge, driven
  through the actual `prisma migrate deploy` CLI. Both applied cleanly,
  confirming the DDL (enum, tables, FKs, composite unique keys, `ENABLE
  ROW LEVEL SECURITY`, `CREATE POLICY`, `CREATE ROLE`) is syntactically and
  semantically valid Postgres — including the exact scenario this migration
  fixes: two rows with the same `(marketplace, marketplaceOrderId)` but
  different `tenantId` now coexist under the new composite key, where the
  old global unique constraint would have rejected the second insert.
- **RLS *enforcement* itself could not be verified in this sandbox.**
  PGlite's role/session model doesn't reliably honor `SET ROLE`-equivalent
  connection-level role switching or Prisma's interactive `$transaction`
  protocol (observed: querying as the non-superuser `arkain_app` role still
  returned all tenants' rows, and `$transaction` calls failed to reach the
  server at all) — this is a known limitation of an embedded, effectively
  single-connection engine, not evidence the RLS policies themselves are
  wrong. **This must be re-verified against a real Postgres** (`docker
  compose up -d && npm run db:migrate`, then connect as `arkain_app` and
  confirm cross-tenant `SELECT`s return nothing) before relying on RLS as a
  production security boundary.
- **Tenant-scoping application logic** (the compound key, the explicit
  `tenantId` filters, the credential AAD binding) is verified with real unit
  tests against fakes — `test/repository.test.ts`,
  `test/credentialStore.test.ts` — since none of that logic depends on
  Postgres actually being reachable.
