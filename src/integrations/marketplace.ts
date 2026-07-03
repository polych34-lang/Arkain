/**
 * The marketplace adapter contract — the heart of the "second marketplace is a
 * config/adapter, not a rewrite" goal.
 *
 * Every marketplace (네이버 스마트스토어, 쿠팡, 11번가, ...) implements this same
 * interface. The sync engine and the unified domain model only ever talk to
 * `MarketplaceAdapter`; they never know which marketplace they are pulling from.
 *
 * Normalized types here are intentionally minimal for the foundation. The full
 * unified product/order/settlement schema is owned by ENG-Domain-Model.
 */

/** `gsshop` (GS샵) has no `MarketplaceAdapter` — no public order API, so there is
 * no `fetchOrders` to implement (ARK-15 §3(a)). Orders arrive via the separate
 * `src/imports/gsshop` excel-import pipeline instead, which produces the same
 * `NormalizedOrder` shape so it shares `PrismaDomainStore.upsertOrders` with
 * every adapter-backed marketplace below. See docs/gsshop-excel-import.md. */
export type MarketplaceId =
  | "naver_smartstore"
  | "coupang"
  | "eleven_st"
  | "esm_2_0"
  | "gsshop";

/** Opaque, resolved per-seller credentials handed to an adapter at call time. */
export interface SellerCredential {
  sellerId: string;
  marketplace: MarketplaceId;
  /** Adapter-specific secret material, already decrypted by the CredentialStore. */
  secret: Record<string, string>;
}

/** A normalized order line, marketplace-agnostic. Money in minor units (KRW won). */
export interface NormalizedOrderItem {
  marketplaceProductId: string;
  productName: string;
  quantity: number;
  unitPriceKrw: number;
}

/** A normalized order. Money fields are integer KRW to avoid float drift. */
export interface NormalizedOrder {
  marketplace: MarketplaceId;
  marketplaceOrderId: string;
  orderedAt: string; // ISO 8601
  status: string; // raw marketplace status, mapped later by domain model
  buyerName: string | null;
  totalAmountKrw: number;
  items: NormalizedOrderItem[];
  /** Untouched marketplace payload, kept for audit/debugging correctness issues. */
  raw: unknown;
}

export interface FetchOrdersParams {
  /** Inclusive lower bound. Adapters page forward from here. */
  since: Date;
  /** Optional cursor for resuming pagination across sync runs. */
  cursor?: string;
}

export interface FetchOrdersPage {
  orders: NormalizedOrder[];
  /** Present when more pages remain. Pass back as `cursor` to continue. */
  nextCursor?: string;
}

/** A normalized product/listing, marketplace-agnostic. Money in minor units (KRW won). */
export interface NormalizedProduct {
  marketplace: MarketplaceId;
  /** The marketplace's listing id (the channel-level product the seller manages). */
  marketplaceProductId: string;
  /** The marketplace's catalog/origin id when distinct from the listing id. */
  originProductId: string | null;
  name: string;
  /** Current sale price in integer KRW. */
  salePriceKrw: number;
  stockQuantity: number;
  /** Raw marketplace status string, mapped to a unified status by the domain model. */
  status: string;
  /** Untouched marketplace payload, kept for audit/debugging correctness issues. */
  raw: unknown;
}

export interface FetchProductsParams {
  /** 1-based page index. Adapters that page by cursor ignore this and use `cursor`. */
  page?: number;
  /** Page size hint; adapters clamp to their own maximum. */
  pageSize?: number;
  /** Optional cursor for resuming pagination across sync runs. */
  cursor?: string;
}

export interface FetchProductsPage {
  products: NormalizedProduct[];
  /** Present when more pages remain. Pass back as `cursor` to continue. */
  nextCursor?: string;
}

export interface MarketplaceAdapter {
  readonly id: MarketplaceId;

  /** Verify credentials are valid (cheap call). Used on connect + health checks. */
  verifyCredential(cred: SellerCredential): Promise<boolean>;

  /** Pull a page of normalized orders. The sync engine handles scheduling/retry. */
  fetchOrders(
    cred: SellerCredential,
    params: FetchOrdersParams,
  ): Promise<FetchOrdersPage>;

  /**
   * Pull a page of normalized products. Optional: not every marketplace exposes a
   * catalog API, and the order-sync MVP is gated only on `fetchOrders`. Adapters
   * that support it page the same way (cursor in → page + nextCursor out).
   */
  fetchProducts?(
    cred: SellerCredential,
    params: FetchProductsParams,
  ): Promise<FetchProductsPage>;
}

/** Raised by adapters so the sync engine can apply uniform retry/backoff policy. */
export class MarketplaceError extends Error {
  constructor(
    message: string,
    readonly opts: {
      marketplace: MarketplaceId;
      /** True when the caller should back off and retry (429 / 5xx / network). */
      retryable: boolean;
      status?: number;
      /** Server-provided backoff hint (from a Retry-After header), in ms. */
      retryAfterMs?: number;
      /** Marketplace error code from the response body (e.g. Naver "GW.RATELIMIT"). */
      code?: string;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "MarketplaceError";
  }
}
