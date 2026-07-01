-- ARK-10 (per ADR-0002, docs/adr/0002-multi-tenancy-b2b-b2c.md §2c): multi-
-- tenant collision defense — Postgres Row Level Security.
--
-- Scope: Order / Product / Settlement. Deliberately NOT OrderItem — it has no
-- tenantId of its own (ADR-0002 §2b: always reached via its parent Order in
-- every query path this app has today; see the residual-gap note on the
-- OrderItem model in schema.prisma and docs/multi-tenancy.md). Deliberately
-- NOT MarketplaceConnection/Seller/SyncRun either — the in-process sync
-- scheduler needs cross-tenant visibility of connections, which RLS on that
-- table would block without a second privileged DB role; that's a follow-up,
-- not this migration (docs/multi-tenancy.md).
--
-- IMPORTANT — this only does anything if the application connects as a
-- non-superuser, non-BYPASSRLS role. Table owners and superusers bypass RLS
-- even with FORCE ROW LEVEL SECURITY. Local dev's docker-compose Postgres user
-- ("postgres") is a superuser, so RLS is inert there by default — see
-- docs/multi-tenancy.md for how to point DATABASE_URL at "arkain_app" locally
-- to actually exercise it.

-- Least-privilege application role. No password is set here — a committed
-- migration must never carry a credential. Set one out-of-band
-- (`ALTER ROLE arkain_app WITH PASSWORD '...'`) via the platform secret
-- manager, matching ARCHITECTURE.md §7.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'arkain_app') THEN
    CREATE ROLE arkain_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO arkain_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "Seller",
  "MarketplaceConnection",
  "SyncRun",
  "Order",
  "OrderItem",
  "Product",
  "Settlement"
TO arkain_app;

-- Row Level Security: every row must match the session's current tenant.
-- The app sets this per-transaction via
--   SELECT set_config('app.tenant_id', $tenantId, true)  -- true = tx-local (SET LOCAL semantics)
-- see src/domain/tenantContext.ts. `current_setting(..., true)` (the missing_ok
-- arg) returns NULL rather than raising when unset, so an unscoped connection
-- sees zero rows here — fail closed, not fail open.

ALTER TABLE "Order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Order" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Order"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "Product" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Product" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Product"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "Settlement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Settlement" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Settlement"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
