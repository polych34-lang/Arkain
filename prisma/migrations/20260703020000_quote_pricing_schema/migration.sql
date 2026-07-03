-- ARK-36/ARK-42 (per ARK-36 schema design doc, ARK-32 feature-audit §2.2):
-- DB-izes the reference OMS's 3-tier price master (cost_pricing ->
-- price_segments -> model_seg_discounts) plus its tenant-wide localStorage
-- calculation rules (pricing_rules, color_surcharge), scoping every table by
-- (tenantId[, segmentId]) so 업종-level pricing differs per tenant instead of
-- being pinned globally. QuoteItem snapshots every price-calculation input
-- alongside the result (see the ARK-36 design doc §2.7) so a later
-- PricingRule/ModelSegDiscount/ColorSurcharge change never alters a past
-- quote's amount.
--
-- RLS is added in the companion migration
-- (20260703020001_quote_pricing_rls), matching the ARK-10/ARK-35 split of
-- "table DDL" vs "RLS + GRANT" into separate files.

-- CreateEnum
CREATE TYPE "ModelSegPriceType" AS ENUM ('WHOLESALE', 'RETAIL', 'EVENT');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "PriceSegment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "wholesaleFactor" DECIMAL(6,4) NOT NULL,
    "d10Factor" DECIMAL(6,4) NOT NULL,
    "d20Factor" DECIMAL(6,4) NOT NULL,
    "d30Factor" DECIMAL(6,4) NOT NULL,
    "roundUnit" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelSegDiscount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "priceType" "ModelSegPriceType" NOT NULL,
    "discountRate" DECIMAL(6,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelSegDiscount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ColorTaxonomy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "rawValue" TEXT NOT NULL,
    "groupLabel" TEXT NOT NULL,
    "material" TEXT,
    "displayLabel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ColorTaxonomy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ColorSurcharge" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "colorTaxonomyId" TEXT NOT NULL,
    "surchargeKrw" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ColorSurcharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT,
    "status" "QuoteStatus" NOT NULL DEFAULT 'DRAFT',
    "totalAmountKrw" INTEGER,
    "convertedOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteItem" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "segmentId" TEXT,
    "segmentCodeSnapshot" TEXT,
    "priceType" "ModelSegPriceType" NOT NULL,
    "basePriceKrw" INTEGER NOT NULL,
    "discountRateSnapshot" DECIMAL(6,4) NOT NULL,
    "colorSurchargeKrw" INTEGER NOT NULL DEFAULT 0,
    "roundUnitSnapshot" INTEGER NOT NULL,
    "unitPriceKrw" INTEGER NOT NULL,
    "lineTotalKrw" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuoteItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PriceSegment_tenantId_code_key" ON "PriceSegment"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PricingRule_tenantId_segmentId_key" ON "PricingRule"("tenantId", "segmentId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelSegDiscount_tenantId_segmentId_modelName_priceType_key" ON "ModelSegDiscount"("tenantId", "segmentId", "modelName", "priceType");

-- CreateIndex
CREATE UNIQUE INDEX "ColorTaxonomy_tenantId_rawValue_key" ON "ColorTaxonomy"("tenantId", "rawValue");

-- CreateIndex
CREATE UNIQUE INDEX "ColorSurcharge_tenantId_segmentId_colorTaxonomyId_key" ON "ColorSurcharge"("tenantId", "segmentId", "colorTaxonomyId");

-- CreateIndex
CREATE INDEX "Quote_tenantId_customerId_idx" ON "Quote"("tenantId", "customerId");

-- CreateIndex
CREATE INDEX "Quote_tenantId_status_idx" ON "Quote"("tenantId", "status");

-- CreateIndex
CREATE INDEX "QuoteItem_quoteId_idx" ON "QuoteItem"("quoteId");

-- AddForeignKey
ALTER TABLE "PriceSegment" ADD CONSTRAINT "PriceSegment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingRule" ADD CONSTRAINT "PricingRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingRule" ADD CONSTRAINT "PricingRule_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "PriceSegment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelSegDiscount" ADD CONSTRAINT "ModelSegDiscount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelSegDiscount" ADD CONSTRAINT "ModelSegDiscount_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "PriceSegment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ColorTaxonomy" ADD CONSTRAINT "ColorTaxonomy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ColorSurcharge" ADD CONSTRAINT "ColorSurcharge_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ColorSurcharge" ADD CONSTRAINT "ColorSurcharge_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "PriceSegment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ColorSurcharge" ADD CONSTRAINT "ColorSurcharge_colorTaxonomyId_fkey" FOREIGN KEY ("colorTaxonomyId") REFERENCES "ColorTaxonomy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_convertedOrderId_fkey" FOREIGN KEY ("convertedOrderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteItem" ADD CONSTRAINT "QuoteItem_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteItem" ADD CONSTRAINT "QuoteItem_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "PriceSegment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

