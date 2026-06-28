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

export type MarketplaceId = "naver_smartstore" | "coupang" | "eleven_st";

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

export interface MarketplaceAdapter {
  readonly id: MarketplaceId;

  /** Verify credentials are valid (cheap call). Used on connect + health checks. */
  verifyCredential(cred: SellerCredential): Promise<boolean>;

  /** Pull a page of normalized orders. The sync engine handles scheduling/retry. */
  fetchOrders(
    cred: SellerCredential,
    params: FetchOrdersParams,
  ): Promise<FetchOrdersPage>;
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
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "MarketplaceError";
  }
}
