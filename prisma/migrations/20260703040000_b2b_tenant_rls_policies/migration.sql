-- ARK-62 (per ARK-55 finding, ARK-10/ARK-35/ARK-42 pattern reused verbatim —
-- see prisma/migrations/20260701000001_tenant_rls_policies and
-- docs/multi-tenancy.md): least-privilege role grant + tenant-isolation RLS
-- on the B2B module's own-tenantId tables (schema.prisma's B2B section
-- header comment + docs/adr/0003-b2b-accounts-purchase-orders.md §5 called
-- this an intentional pre-RLS interim state, same posture ADR-0002 §2d
-- describes for Order pre-ARK-10).
--
-- Deliberately NOT on PurchaseOrderItem — same reasoning as OrderItem/
-- QuoteItem (ADR-0002 §2b): it has no tenantId of its own and is always
-- reached through its parent PurchaseOrder, which is FORCE ROW LEVEL
-- SECURITY-protected. PurchaseOrderItem still needs a GRANT (it's a real
-- table the app writes to), just no RLS policy.
--
-- `arkain_app` already exists (created by the ARK-10 migration) — this only
-- extends its grants and adds matching policies. Only does anything once the
-- app connects as that non-superuser, non-BYPASSRLS role (docs/multi-tenancy.md).

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "Account",
  "AccountPriceListEntry",
  "PurchaseOrder",
  "PurchaseOrderItem"
TO arkain_app;

ALTER TABLE "Account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Account" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Account"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "AccountPriceListEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AccountPriceListEntry" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AccountPriceListEntry"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "PurchaseOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PurchaseOrder" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PurchaseOrder"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
