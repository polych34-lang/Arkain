-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Marketplace" AS ENUM ('naver_smartstore', 'coupang', 'eleven_st', 'esm_2_0');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'PAID', 'DISPATCHED', 'DELIVERED', 'CONFIRMED', 'CANCELLED', 'RETURNED', 'EXCHANGED', 'MIXED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('ON_SALE', 'OUT_OF_STOCK', 'SUSPENDED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "Seller" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Seller_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceConnection" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "ordersPulled" INTEGER NOT NULL DEFAULT 0,
    "cursor" TEXT,
    "error" TEXT,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "marketplaceOrderId" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "rawStatus" TEXT NOT NULL,
    "orderedAt" TIMESTAMP(3) NOT NULL,
    "buyerName" TEXT,
    "totalAmountKrw" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "marketplaceProductId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceKrw" INTEGER NOT NULL,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "marketplaceProductId" TEXT NOT NULL,
    "originProductId" TEXT,
    "name" TEXT NOT NULL,
    "salePriceKrw" INTEGER NOT NULL,
    "stockQuantity" INTEGER NOT NULL,
    "status" "ProductStatus" NOT NULL,
    "rawStatus" TEXT NOT NULL,
    "raw" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "orderId" TEXT,
    "marketplaceOrderId" TEXT,
    "settledAt" TIMESTAMP(3),
    "payoutAmountKrw" INTEGER NOT NULL,
    "feeAmountKrw" INTEGER NOT NULL,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceConnection_sellerId_marketplace_key" ON "MarketplaceConnection"("sellerId", "marketplace");

-- CreateIndex
CREATE UNIQUE INDEX "Order_tenantId_marketplace_marketplaceOrderId_key" ON "Order"("tenantId", "marketplace", "marketplaceOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_tenantId_marketplace_marketplaceProductId_key" ON "Product"("tenantId", "marketplace", "marketplaceProductId");

-- CreateIndex
CREATE INDEX "Settlement_tenantId_marketplace_marketplaceOrderId_idx" ON "Settlement"("tenantId", "marketplace", "marketplaceOrderId");

-- AddForeignKey
ALTER TABLE "MarketplaceConnection" ADD CONSTRAINT "MarketplaceConnection_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "MarketplaceConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

