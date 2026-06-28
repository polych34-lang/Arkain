import type {
  NormalizedOrder,
  NormalizedProduct,
} from "../marketplace.js";
import type {
  ProductOrderDetailT,
  ProductSearchResponseT,
} from "./naver.types.js";

/**
 * Pure functions: raw (already zod-validated) Naver payloads -> normalized,
 * marketplace-agnostic domain types. No I/O, fully unit-testable.
 *
 * Naver order granularity quirk: a Naver `orderId` (one payment) contains many
 * `productOrderId`s (line items that ship/cancel independently). We model one
 * `NormalizedOrder` per `orderId`, with each productOrder folded into `items[]`.
 * The unified order status is the single line status when uniform, else "MIXED"
 * — the per-line truth is preserved in `raw`.
 */

const MARKETPLACE = "naver_smartstore" as const;

/** Normalize Naver's KST timestamps to ISO 8601 (kept as-is if already ISO). */
function toIso(value: string | undefined): string {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

export function mapProductOrdersToOrders(
  details: ProductOrderDetailT[],
): NormalizedOrder[] {
  const byOrderId = new Map<string, ProductOrderDetailT[]>();
  for (const d of details) {
    const id = d.order.orderId;
    const bucket = byOrderId.get(id);
    if (bucket) bucket.push(d);
    else byOrderId.set(id, [d]);
  }

  const orders: NormalizedOrder[] = [];
  for (const [orderId, lines] of byOrderId) {
    const first = lines[0]!;
    const statuses = new Set(
      lines.map((l) => l.productOrder.productOrderStatus ?? "UNKNOWN"),
    );
    const status = statuses.size === 1 ? [...statuses][0]! : "MIXED";

    const items = lines.map((l) => {
      const po = l.productOrder;
      // Prefer an explicit unit price; else derive from the line total.
      const unit =
        po.unitPrice ??
        (po.quantity > 0 && po.totalPaymentAmount != null
          ? Math.round(po.totalPaymentAmount / po.quantity)
          : 0);
      return {
        marketplaceProductId: String(po.productId ?? po.productOrderId),
        productName: po.productName ?? "",
        quantity: po.quantity ?? 0,
        unitPriceKrw: unit,
      };
    });

    const totalAmountKrw = lines.reduce(
      (sum, l) =>
        sum +
        (l.productOrder.totalPaymentAmount ??
          l.productOrder.totalProductAmount ??
          0),
      0,
    );

    orders.push({
      marketplace: MARKETPLACE,
      marketplaceOrderId: orderId,
      orderedAt: toIso(first.order.paymentDate ?? first.order.orderDate),
      status,
      buyerName: first.order.ordererName ?? null,
      totalAmountKrw,
      items,
      raw: lines,
    });
  }
  return orders;
}

export function mapProductSearchToProducts(
  res: ProductSearchResponseT,
): NormalizedProduct[] {
  const products: NormalizedProduct[] = [];
  for (const item of res.contents) {
    const originId =
      item.originProductNo != null ? String(item.originProductNo) : null;
    for (const ch of item.channelProducts) {
      products.push({
        marketplace: MARKETPLACE,
        marketplaceProductId: String(ch.channelProductNo),
        originProductId: originId,
        name: ch.name ?? "",
        salePriceKrw: ch.salePrice ?? 0,
        stockQuantity: ch.stockQuantity ?? 0,
        status: ch.statusType ?? "UNKNOWN",
        raw: { origin: { originProductNo: item.originProductNo }, channel: ch },
      });
    }
  }
  return products;
}
