import type { MarketplaceId } from "../integrations/marketplace.js";

/**
 * Marketplace-agnostic statuses. Mirrors prisma/schema.prisma's `OrderStatus`
 * and `ProductStatus` enums exactly (Prisma enum values are the source of
 * truth; these string unions must stay in sync with it).
 *
 * Adding a marketplace means adding one entry to the tables below, not a new
 * code path — the sync engine and domain model never see a raw marketplace
 * status string outside of `rawStatus` (kept for audit).
 */
export type UnifiedOrderStatus =
  | "PENDING"
  | "PAID"
  | "DISPATCHED"
  | "DELIVERED"
  | "CONFIRMED"
  | "CANCELLED"
  | "RETURNED"
  | "EXCHANGED"
  | "MIXED"
  | "UNKNOWN";

export type UnifiedProductStatus =
  | "ON_SALE"
  | "OUT_OF_STOCK"
  | "SUSPENDED"
  | "UNKNOWN";

/**
 * Naver `productOrderStatus` -> unified. Values per Naver Commerce API docs.
 * `MIXED` is not a Naver value — it is synthesized by
 * naver.mapper.ts#mapProductOrdersToOrders when an order's line items disagree.
 * Unverified against live data (ARK-3 credential blocker); `rawStatus` is
 * always preserved so a wrong bucket is correctable without re-pulling data.
 */
const NAVER_ORDER_STATUS: Record<string, UnifiedOrderStatus> = {
  PAYMENT_WAITING: "PENDING",
  PAYED: "PAID",
  DELIVERING: "DISPATCHED",
  DELIVERED: "DELIVERED",
  PURCHASE_DECIDED: "CONFIRMED",
  CANCELED: "CANCELLED",
  CANCELED_BY_NOPAYMENT: "CANCELLED",
  RETURNED: "RETURNED",
  EXCHANGED: "EXCHANGED",
  MIXED: "MIXED",
};

/** Naver `statusType` (product) -> unified. Same live-data caveat as above. */
const NAVER_PRODUCT_STATUS: Record<string, UnifiedProductStatus> = {
  SALE: "ON_SALE",
  OUTOFSTOCK: "OUT_OF_STOCK",
  SUSPENSION: "SUSPENDED",
  CLOSE: "SUSPENDED",
  UNADMISSION: "SUSPENDED",
  REJECTION: "SUSPENDED",
  DELETE: "SUSPENDED",
};

/**
 * ESM 2.0 (G마켓/옥션 ESM Trading API) `OrderStatus` -> unified. Values per
 * https://etapi.gmarket.com/67 (주문조회 API), confirmed via public docs but
 * NOT against a live account (ARK-11 credential caveat — see
 * docs/esm-2.0-integration.md §7). Numeric codes are stringified since
 * `NormalizedOrder.status`/`NormalizedProduct.status` are `string`.
 */
const ESM_ORDER_STATUS: Record<string, UnifiedOrderStatus> = {
  "1": "PENDING", // 신규주문
  "2": "PAID", // 발송대기
  "3": "DISPATCHED", // 배송중
  "4": "DELIVERED", // 배송완료
  "5": "CONFIRMED", // 구매확정
};

/**
 * ESM 2.0 `sellStatus` (product, per-site: gmkt/iac) -> unified. Codes per
 * https://etapi.gmarket.com/160 (상품 목록 조회 API). Same live-data caveat.
 */
const ESM_PRODUCT_STATUS: Record<string, UnifiedProductStatus> = {
  "11": "ON_SALE",
  "21": "SUSPENDED", // 판매중지
  "22": "SUSPENDED", // 판매보류
  "31": "OUT_OF_STOCK",
};

/**
 * Coupang Wing/Open API 발주서 `status` -> unified. Values per the public
 * Coupang Open API reference, confirmed via docs but NOT against a live
 * vendor account (ARK-27 credential caveat — see docs/coupang-integration.md
 * §6). `CANCEL`/`RETURN` states are handled by separate Coupang endpoints not
 * yet pulled by this adapter, so they have no entry here.
 */
const COUPANG_ORDER_STATUS: Record<string, UnifiedOrderStatus> = {
  ACCEPT: "PAID", // 결제완료
  INSTRUCT: "PAID", // 상품준비중
  DEPARTURE: "DISPATCHED", // 배송지시
  DELIVERING: "DISPATCHED", // 배송중
  FINAL_DELIVERY: "DELIVERED", // 배송완료
  NONE_TRACKING: "DELIVERED", // 업체배송(추적 불가)
};

/**
 * Coupang `saleStatusName` (seller-products item) -> unified. Same live-data
 * caveat as above.
 */
const COUPANG_PRODUCT_STATUS: Record<string, UnifiedProductStatus> = {
  ON_SALE: "ON_SALE",
  OUT_OF_STOCK: "OUT_OF_STOCK",
  SUSPENSION: "SUSPENDED",
  DELETING: "SUSPENDED",
};

const ORDER_STATUS_BY_MARKETPLACE: Record<
  MarketplaceId,
  Record<string, UnifiedOrderStatus> | undefined
> = {
  naver_smartstore: NAVER_ORDER_STATUS,
  coupang: COUPANG_ORDER_STATUS,
  eleven_st: undefined,
  esm_2_0: ESM_ORDER_STATUS,
};

const PRODUCT_STATUS_BY_MARKETPLACE: Record<
  MarketplaceId,
  Record<string, UnifiedProductStatus> | undefined
> = {
  naver_smartstore: NAVER_PRODUCT_STATUS,
  coupang: COUPANG_PRODUCT_STATUS,
  eleven_st: undefined,
  esm_2_0: ESM_PRODUCT_STATUS,
};

export function toUnifiedOrderStatus(
  marketplace: MarketplaceId,
  rawStatus: string,
): UnifiedOrderStatus {
  return ORDER_STATUS_BY_MARKETPLACE[marketplace]?.[rawStatus] ?? "UNKNOWN";
}

export function toUnifiedProductStatus(
  marketplace: MarketplaceId,
  rawStatus: string,
): UnifiedProductStatus {
  return PRODUCT_STATUS_BY_MARKETPLACE[marketplace]?.[rawStatus] ?? "UNKNOWN";
}
