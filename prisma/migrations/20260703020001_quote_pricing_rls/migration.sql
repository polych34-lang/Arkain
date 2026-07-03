-- ARK-36/ARK-42 (per ARK-36 schema design doc §3, ARK-10/ARK-35 pattern
-- reused verbatim — see prisma/migrations/20260701000001_tenant_rls_policies
-- and docs/multi-tenancy.md): least-privilege role grant + tenant-isolation
-- RLS on every new tenant-scoped table from the companion migration
-- (20260703020000_quote_pricing_schema).
--
-- Deliberately NOT on QuoteItem — same reasoning as OrderItem (ADR-0002 §2b):
-- it has no tenantId of its own and is always reached through its parent
-- Quote, which is FORCE ROW LEVEL SECURITY-protected. QuoteItem still needs a
-- GRANT (it's a real table the app writes to), just no RLS policy.
--
-- `arkain_app` already exists (created by the ARK-10 migration) — this only
-- extends its grants and adds matching policies. Only does anything once the
-- app connects as that non-superuser, non-BYPASSRLS role (docs/multi-tenancy.md).

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "PriceSegment",
  "PricingRule",
  "ModelSegDiscount",
  "ColorTaxonomy",
  "ColorSurcharge",
  "Quote",
  "QuoteItem"
TO arkain_app;

ALTER TABLE "PriceSegment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PriceSegment" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PriceSegment"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "PricingRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PricingRule" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PricingRule"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "ModelSegDiscount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ModelSegDiscount" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ModelSegDiscount"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "ColorTaxonomy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ColorTaxonomy" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ColorTaxonomy"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "ColorSurcharge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ColorSurcharge" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ColorSurcharge"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "Quote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Quote" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Quote"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
