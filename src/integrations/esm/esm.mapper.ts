import type { NormalizedOrder, NormalizedProduct } from "../marketplace.js";
import type { EsmOrderRowT, EsmGoodsSearchResponseT } from "./esm.types.js";

/**
 * Pure functions: raw (already zod-validated) ESM 2.0 payloads -> normalized,
 * marketplace-agnostic domain types. No I/O, fully unit-testable.
 *
 * ESM 2.0 quirk: G마켓 and 옥션 are two storefronts under one ESM PLUS master
 * account, queried with a `siteType` filter per call — the response itself
 * does not carry which site it came from. `esm.adapter.ts` calls the mapper
 * once per site and passes `site` through so it lands in `raw` for audit
 * (both storefronts are unified under the single `esm_2_0` marketplace id;
 * see docs/esm-2.0-integration.md §2 for why).
 */

const MARKETPLACE = "esm_2_0" as const;

export type EsmSite = "auction" | "gmarket";

/** Normalize ESM's KST timestamps ("YYYY-MM-DD hh:mm") to ISO 8601. */
function toIso(value: string | undefined): string {
  if (!value) return "";
  const parsed = new Date(value.replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

export function mapOrderRowsToOrders(
  rows: EsmOrderRowT[],
  site: EsmSite,
): NormalizedOrder[] {
  return rows.map((row) => {
    const unit = row.SalePrice ?? 0;
    const quantity = row.ContrAmount || 1;
    return {
      marketplace: MARKETPLACE,
      marketplaceOrderId: row.OrderNo,
      orderedAt: toIso(row.PayDate ?? row.OrderDate),
      status: row.OrderStatus,
      buyerName: row.BuyerName ?? null,
      totalAmountKrw: row.AcntMoney ?? unit * quantity,
      items: [
        {
          marketplaceProductId: row.SiteGoodsNo || row.OrderNo,
          productName: row.GoodsName,
          quantity,
          unitPriceKrw: unit,
        },
      ],
      raw: { site, row },
    };
  });
}

/**
 * Flatten master products into one `NormalizedProduct` per site listing
 * (mirrors Naver's origin/channel flatten — one master `goodsNo` can list on
 * both 지마켓 and 옥션 with independent price/stock/status).
 */
export function mapGoodsSearchToProducts(
  res: EsmGoodsSearchResponseT,
): NormalizedProduct[] {
  const products: NormalizedProduct[] = [];
  for (const item of res.items) {
    const sites: Array<{ site: EsmSite; key: "gmkt" | "iac" }> = [
      { site: "gmarket", key: "gmkt" },
      { site: "auction", key: "iac" },
    ];
    for (const { site, key } of sites) {
      const siteGoodsNo = item.siteGoodsNo?.[key];
      if (!siteGoodsNo) continue;
      products.push({
        marketplace: MARKETPLACE,
        marketplaceProductId: siteGoodsNo,
        originProductId: item.goodsNo,
        name: item.goodsName,
        salePriceKrw: item.price?.[key] ?? 0,
        stockQuantity: item.stock?.[key] ?? 0,
        status: item.sellStatus?.[key] ?? "UNKNOWN",
        raw: { site, goodsNo: item.goodsNo, item },
      });
    }
  }
  return products;
}
