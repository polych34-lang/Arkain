-- ARK-35 (per feature-audit §2.3/§5, ARK-32): introduces `Customer` — the
-- reference OMS has no such table, so re-purchase/LTV/a 360-degree customer
-- view is structurally impossible there (customer identity is two free-text
-- phone columns compared as strings). This migration adds the table before
-- any CS/quote feature writes to it, and links `Order` to it, reusing ARK-10's
-- tenant_id + Postgres RLS pattern verbatim (see
-- prisma/migrations/20260701000001_tenant_rls_policies and
-- docs/multi-tenancy.md).

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "customerId" TEXT;

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "primaryPhone" TEXT NOT NULL,
    "primaryEmail" TEXT,
    "name" TEXT NOT NULL,
    "channelIds" JSONB,
    "firstInquiryAt" TIMESTAMP(3),
    "lastContactedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_tenantId_primaryPhone_key" ON "Customer"("tenantId", "primaryPhone");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ARK-10 pattern reused verbatim: least-privilege role grant + RLS on the new
-- table. `arkain_app` was already created by the ARK-10 migration; this just
-- extends its grants and adds a matching policy. Only does anything once the
-- app connects as that non-superuser, non-BYPASSRLS role — see
-- docs/multi-tenancy.md "This only works if the app doesn't connect as a
-- superuser".

GRANT SELECT, INSERT, UPDATE, DELETE ON "Customer" TO arkain_app;

ALTER TABLE "Customer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Customer" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Customer"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- customer_activity: unified 문의+주문+견적 timeline (issue ARK-35's stated
-- prep for future CS/quote work). `Inquiry`/`Quote` don't exist as tables yet
-- (no CS/quote feature has been built) — this view unions in `Order` only for
-- now and is deliberately written so each future entity adds one more
-- `UNION ALL` arm without touching this one. Not exposed via any app code
-- yet; the first CS/quote issue that needs a timeline is the intended
-- consumer (per the issue description).
--
-- No separate RLS policy is needed on the view itself: it selects only from
-- `Order`/`Customer`, both FORCE ROW LEVEL SECURITY, and FORCE means the
-- session's `app.tenant_id` scoping applies even though a view normally
-- executes with the view owner's privileges (see docs/multi-tenancy.md).
CREATE VIEW customer_activity AS
SELECT
  c."tenantId"        AS tenant_id,
  c.id                AS customer_id,
  'order'::text        AS activity_type,
  o.id                AS activity_id,
  o."orderedAt"       AS occurred_at,
  o.status::text       AS status,
  o."totalAmountKrw"  AS amount_krw
FROM "Order" o
JOIN "Customer" c ON c.id = o."customerId";

GRANT SELECT ON customer_activity TO arkain_app;
