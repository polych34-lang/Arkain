import type { NormalizedOrder, NormalizedProduct } from "../marketplace.js";
import type { CoupangOrderSheetT, CoupangSellerProductT } from "./coupang.types.js";

/**
 * Pure functions: raw (already zod-validated) Coupang payloads -> normalized,
 * marketplace-agnostic domain types. No I/O, fully unit-testable.
 *
 * Coupang order granularity: one 발주서(order sheet) is already the seller's
 * unit of fulfillment (`shipmentBoxId`), so it maps 1:1 to `NormalizedOrder`
 * (no order/line split like Naver's orderId -> productOrderId). One seller
 * product listing can carry several option/SKU rows (`items[]`); each becomes
 * its own `NormalizedProduct`, same flatten shape as Naver's origin/channel
 * and ESM's per-site listings.
 */

const MARKETPLACE = "coupang" as const;

/** Normalize Coupang's timestamps to ISO 8601 (kept as-is if already ISO/unparseable). */
function toIso(value: string | undefined): string {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

export function mapOrderSheetsToOrders(
  sheets: CoupangOrderSheetT[],
): NormalizedOrder[] {
  return sheets.map((sheet) => {
    const items = sheet.orderItems.map((item) => ({
      marketplaceProductId: item.vendorItemId,
      productName: item.vendorItemName,
      quantity: item.shippingCount,
      unitPriceKrw: item.salesPrice ?? item.orderPrice ?? 0,
    }));
    const totalAmountKrw = items.reduce(
      (sum, i) => sum + i.unitPriceKrw * i.quantity,
      0,
    );

    return {
      marketplace: MARKETPLACE,
      marketplaceOrderId: String(sheet.shipmentBoxId),
      orderedAt: toIso(sheet.paidAt ?? sheet.orderedAt),
      status: sheet.status,
      buyerName: sheet.orderer?.name ?? null,
      totalAmountKrw,
      items,
      raw: sheet,
    };
  });
}

export function mapSellerProductsToProducts(
  rows: CoupangSellerProductT[],
): NormalizedProduct[] {
  const products: NormalizedProduct[] = [];
  for (const row of rows) {
    for (const item of row.items) {
      products.push({
        marketplace: MARKETPLACE,
        marketplaceProductId: item.vendorItemId,
        originProductId: row.sellerProductId,
        name: item.itemName || row.sellerProductName,
        salePriceKrw: item.salePrice ?? 0,
        stockQuantity: item.stockQuantity,
        status: item.saleStatusName,
        raw: { sellerProductId: row.sellerProductId, item },
      });
    }
  }
  return products;
}
