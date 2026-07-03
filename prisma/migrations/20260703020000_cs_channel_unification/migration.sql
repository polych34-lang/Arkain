-- ARK-37 (per feature-audit §2.3/§4, ARK-32): unifies the reference OMS's 4 CS
-- channels (상품문의/고객문의/톡톡/카카오) into one `Inquiry` table, with TalkTalk/Kakao
-- conversation turns held in an append-only `ChannelMessage` table that a
-- trigger rolls up into `Inquiry.content`. This is the verified fix for the
-- reference's v455 image-loss bug (feature-audit §4): the old flow read the
-- current content client-side, appended a message, and wrote it back — two
-- concurrent messages landing in that window silently dropped one
-- image/message (read-modify-write race). Making the message log INSERT-only
-- (enforced below via GRANT, not just convention) and rolling it up via an
-- AFTER INSERT trigger in the same transaction as the INSERT removes the race
-- by construction — there is no read-then-write step for two writers to
-- interleave. Adopted verbatim, per the issue's explicit instruction.
--
-- Also links `Inquiry.customerId` to ARK-35's `Customer` (the reference has
-- no such link — customer history lookup there is phone-string comparison
-- only, feature-audit §2.3's diagnosed structural defect) and adds
-- `InquiryOrderLink` (composite PK, 1:N) for 문의↔주문 연결.

-- CreateEnum
CREATE TYPE "InquiryChannel" AS ENUM ('PRODUCT_QNA', 'CUSTOMER_QNA', 'TALK', 'KAKAO');

-- CreateEnum
CREATE TYPE "InquiryStatus" AS ENUM ('OPEN', 'ANSWERED', 'CLOSED');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('CUSTOMER', 'SELLER');

-- CreateTable
CREATE TABLE "Inquiry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channel" "InquiryChannel" NOT NULL,
    "externalInquiryNo" TEXT NOT NULL,
    "marketplace" "Marketplace",
    "customerId" TEXT,
    "customerName" TEXT,
    "customerPhone" TEXT,
    "productId" TEXT,
    "subject" TEXT,
    "content" TEXT NOT NULL,
    "status" "InquiryStatus" NOT NULL DEFAULT 'OPEN',
    "answeredAt" TIMESTAMP(3),
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Inquiry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelMessage" (
    "id" TEXT NOT NULL,
    "inquiryId" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "content" TEXT NOT NULL,
    "attachments" JSONB,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InquiryOrderLink" (
    "inquiryId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "linkType" TEXT,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InquiryOrderLink_pkey" PRIMARY KEY ("inquiryId","orderId")
);

-- CreateIndex
CREATE INDEX "Inquiry_tenantId_customerId_idx" ON "Inquiry"("tenantId", "customerId");

-- CreateIndex
CREATE INDEX "Inquiry_tenantId_status_idx" ON "Inquiry"("tenantId", "status");

-- CreateIndex: channel (not marketplace) + the channel's own inquiry id is the
-- idempotent upsert key, matching Order's (tenantId, marketplace,
-- marketplaceOrderId) pattern (ARK-10) — see the schema comment on
-- `Inquiry.marketplace` for why `marketplace` itself can't be part of this key
-- (KAKAO has no Marketplace value; NULLs don't collide in a unique index).
CREATE UNIQUE INDEX "Inquiry_tenantId_channel_externalInquiryNo_key" ON "Inquiry"("tenantId", "channel", "externalInquiryNo");

-- CreateIndex
CREATE INDEX "ChannelMessage_inquiryId_sentAt_idx" ON "ChannelMessage"("inquiryId", "sentAt");

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMessage" ADD CONSTRAINT "ChannelMessage_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "Inquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InquiryOrderLink" ADD CONSTRAINT "InquiryOrderLink_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "Inquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InquiryOrderLink" ADD CONSTRAINT "InquiryOrderLink_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: ARK-10 pattern reused verbatim (see docs/multi-tenancy.md) for
-- `Inquiry`, the only new table here with its own `tenantId` — `ChannelMessage`
-- and `InquiryOrderLink` are reached only via their parent `Inquiry`/`Order`
-- (both already RLS'd), same reasoning as `OrderItem` (ADR-0002 §2b). Residual
-- gap this accepts, same as `OrderItem`/`JournalLine`: a future direct/raw
-- query against `ChannelMessage` or `InquiryOrderLink` alone (not joined
-- through its parent) would not be RLS-protected.
ALTER TABLE "Inquiry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Inquiry" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Inquiry"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "Inquiry" TO arkain_app;

-- Append-only enforcement (the actual fix for the v455 race, not just the
-- trigger below): no UPDATE/DELETE grant at all on ChannelMessage. An
-- attachment/message is durable the instant its row commits; there is no
-- write-back step where a second writer's insert could race it out.
GRANT SELECT, INSERT ON "ChannelMessage" TO arkain_app;

-- InquiryOrderLink is a mutable join table (a link can be corrected/removed
-- via the manual-link UI), unlike ChannelMessage — full CRUD.
GRANT SELECT, INSERT, UPDATE, DELETE ON "InquiryOrderLink" TO arkain_app;

-- fn_channel_message_rollup: atomically appends each new ChannelMessage into
-- its parent Inquiry.content, in the same transaction as the INSERT. Runs
-- with the invoking role's (arkain_app's) privileges (no SECURITY DEFINER
-- needed — arkain_app already has UPDATE on Inquiry above), so Inquiry's
-- `tenant_isolation` RLS policy applies to this UPDATE exactly as it would to
-- any other, with no privilege-escalation footgun.
CREATE FUNCTION fn_channel_message_rollup() RETURNS TRIGGER AS $$
BEGIN
  UPDATE "Inquiry"
  SET "content" = CASE
        WHEN "content" IS NULL OR "content" = '' THEN NEW."content"
        ELSE "content" || E'\n' || NEW."content"
      END,
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = NEW."inquiryId";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_channel_message_rollup
  AFTER INSERT ON "ChannelMessage"
  FOR EACH ROW
  EXECUTE FUNCTION fn_channel_message_rollup();

-- customer_activity (ARK-35, prisma/migrations/20260703000000_customers_activity_view):
-- that migration's comment says the view is "written to gain one UNION ALL arm
-- per future Quote/Inquiry table without touching this one" — this is that
-- arm. CREATE OR REPLACE VIEW keeps the same output column list/order, just
-- adds rows; no RLS policy needed on the view itself for the same reason as
-- before (both underlying tables FORCE ROW LEVEL SECURITY).
CREATE OR REPLACE VIEW customer_activity AS
SELECT
  c."tenantId"        AS tenant_id,
  c.id                AS customer_id,
  'order'::text        AS activity_type,
  o.id                AS activity_id,
  o."orderedAt"       AS occurred_at,
  o.status::text       AS status,
  o."totalAmountKrw"  AS amount_krw
FROM "Order" o
JOIN "Customer" c ON c.id = o."customerId"
UNION ALL
SELECT
  c."tenantId"        AS tenant_id,
  c.id                AS customer_id,
  'inquiry'::text      AS activity_type,
  i.id                AS activity_id,
  i."createdAt"       AS occurred_at,
  i.status::text       AS status,
  NULL::integer        AS amount_krw
FROM "Inquiry" i
JOIN "Customer" c ON c.id = i."customerId";
