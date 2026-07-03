import type { NormalizedOrder } from "../../integrations/marketplace.js";
import type { GsShopRowT } from "./gsshop.types.js";

/**
 * Pure function: validated GS샵 엑셀 행(row) -> 정규화된 `NormalizedOrder[]`.
 * No I/O, fully unit-testable — 네이버 어댑터의 `naver.mapper.ts`
 * (`mapProductOrdersToOrders`)와 같은 "같은 주문번호 여러 줄 -> 하나의 주문"
 * 그룹핑 패턴을 그대로 재사용한다.
 */

const MARKETPLACE = "gsshop" as const;

/** 엑셀 날짜/시간 텍스트를 ISO 8601로. 파싱 안 되면 원문을 그대로 보존한다
 * (raw에 원본 행이 남으므로 나중에 교정 가능 — 조용히 버리지 않는다). */
function toIso(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

export function mapGsShopRowsToOrders(rows: GsShopRowT[]): NormalizedOrder[] {
  const byOrderNo = new Map<string, GsShopRowT[]>();
  for (const row of rows) {
    const bucket = byOrderNo.get(row.orderNo);
    if (bucket) bucket.push(row);
    else byOrderNo.set(row.orderNo, [row]);
  }

  const orders: NormalizedOrder[] = [];
  for (const [orderNo, lines] of byOrderNo) {
    const first = lines[0]!;
    const statuses = new Set(lines.map((l) => l.status));
    const status = statuses.size === 1 ? [...statuses][0]! : "MIXED";

    const items = lines.map((l) => ({
      marketplaceProductId: l.productCode ?? l.productName,
      productName: l.productName,
      quantity: l.quantity,
      unitPriceKrw: l.quantity > 0 ? Math.round(l.amountKrw / l.quantity) : 0,
    }));

    orders.push({
      marketplace: MARKETPLACE,
      marketplaceOrderId: orderNo,
      orderedAt: toIso(first.orderedAt),
      status,
      buyerName: first.buyerName,
      totalAmountKrw: lines.reduce((sum, l) => sum + l.amountKrw, 0),
      items,
      raw: lines,
    });
  }
  return orders;
}
