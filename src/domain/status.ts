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

const ORDER_STATUS_BY_MARKETPLACE: Record<
  MarketplaceId,
  Record<string, UnifiedOrderStatus> | undefined
> = {
  naver_smartstore: NAVER_ORDER_STATUS,
  coupang: undefined,
  eleven_st: undefined,
};

const PRODUCT_STATUS_BY_MARKETPLACE: Record<
  MarketplaceId,
  Record<string, UnifiedProductStatus> | undefined
> = {
  naver_smartstore: NAVER_PRODUCT_STATUS,
  coupang: undefined,
  eleven_st: undefined,
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
