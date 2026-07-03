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

/**
 * GS샵 파트너스 주문리스트 엑셀의 "주문상태" 컬럼 -> unified. **실 샘플 엑셀 미확보
 * 상태의 최선 추정**(ARK-46, docs/gsshop-excel-import.md 블로커) — 다른 채널처럼
 * 공개 API 문서 대조조차 못 한 상태라 다른 어댑터보다 신뢰도가 낮다. 매핑에 없는
 * 값은 전부 `UNKNOWN`으로 떨어지고 `rawStatus`에 원문이 그대로 남으므로, 실 파일
 * 확보 후 이 테이블만 고치면 재수입 없이 교정 가능하다.
 */
const GSSHOP_ORDER_STATUS: Record<string, UnifiedOrderStatus> = {
  입금전: "PENDING",
  결제완료: "PAID",
  상품준비중: "PAID",
  배송중: "DISPATCHED",
  배송완료: "DELIVERED",
  구매확정: "CONFIRMED",
  취소: "CANCELLED",
  반품: "RETURNED",
  교환: "EXCHANGED",
  MIXED: "MIXED",
};

const ORDER_STATUS_BY_MARKETPLACE: Record<
  MarketplaceId,
  Record<string, UnifiedOrderStatus> | undefined
> = {
  naver_smartstore: NAVER_ORDER_STATUS,
  coupang: COUPANG_ORDER_STATUS,
  eleven_st: undefined,
  esm_2_0: ESM_ORDER_STATUS,
  gsshop: GSSHOP_ORDER_STATUS,
};

const PRODUCT_STATUS_BY_MARKETPLACE: Record<
  MarketplaceId,
  Record<string, UnifiedProductStatus> | undefined
> = {
  naver_smartstore: NAVER_PRODUCT_STATUS,
  coupang: COUPANG_PRODUCT_STATUS,
  eleven_st: undefined,
  esm_2_0: ESM_PRODUCT_STATUS,
  // 엑셀 임포트는 주문만 다룬다 — GS샵에는 상품 카탈로그 개념이 없다(no adapter).
  gsshop: undefined,
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
