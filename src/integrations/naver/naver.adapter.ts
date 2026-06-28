import {
  MarketplaceError,
  type FetchOrdersPage,
  type FetchOrdersParams,
  type FetchProductsPage,
  type FetchProductsParams,
  type MarketplaceAdapter,
  type MarketplaceId,
  type SellerCredential,
} from "../marketplace.js";
import {
  NaverHttpClient,
  type NaverHttpConfig,
  type NaverHttpDeps,
} from "./naver.http.js";
import {
  mapProductOrdersToOrders,
  mapProductSearchToProducts,
} from "./naver.mapper.js";
import {
  LastChangedStatusesResponse,
  ProductOrderQueryResponse,
  ProductSearchResponse,
} from "./naver.types.js";

/**
 * 네이버 스마트스토어 (Naver Commerce API) adapter — REAL implementation.
 *
 * Implements the marketplace contract end to end: bcrypt-signed OAuth2 auth,
 * order pull (last-changed window -> detail query), product pull (paged search),
 * and normalization. The sync engine only ever sees `MarketplaceAdapter` +
 * normalized types, so adding 쿠팡 is a new adapter, not a rewrite.
 *
 * Auth modes (one quirk worth knowing):
 *   - SELF: a store's own app. The per-seller credential carries that store's
 *     own `clientId` + `clientSecret`.
 *   - SELLER: ARKAIN as a solution provider. App-level `clientId`/`clientSecret`
 *     come from config (env), and the per-seller credential carries `accountId`.
 *
 * Constants below reflect Naver's documented limits — see
 * docs/naver-commerce-integration.md.
 */

/** Naver caps the last-changed query window at 24h. */
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
/** product-orders/query accepts at most 300 ids per call. */
const ORDER_QUERY_BATCH = 300;
/** Default products/search page size. */
const DEFAULT_PRODUCT_PAGE_SIZE = 100;

/** App-level config: the ARKAIN application's own Naver keys + base URL. */
export interface NaverAdapterConfig {
  baseUrl: string;
  clientId?: string;
  clientSecret?: string;
}

interface OrderCursor {
  /** ISO lower bound of the current sub-window. */
  from: string;
  /** Naver "more" cursor within the current window, when truncated. */
  moreSequence?: string;
}

function encodeCursor(c: object): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}
function decodeCursor<T>(cursor: string | undefined): T | null {
  if (!cursor) return null;
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class NaverSmartstoreAdapter implements MarketplaceAdapter {
  readonly id: MarketplaceId = "naver_smartstore";

  constructor(
    private readonly config: NaverAdapterConfig,
    private readonly deps: NaverHttpDeps = {},
  ) {}

  /** Build a transport for a specific seller, merging app + per-seller secrets. */
  private clientFor(cred: SellerCredential): NaverHttpClient {
    const clientId = cred.secret.clientId ?? this.config.clientId;
    const clientSecret = cred.secret.clientSecret ?? this.config.clientSecret;
    if (!clientId || !clientSecret) {
      throw new MarketplaceError(
        "Missing Naver clientId/clientSecret (set app-level config or per-seller credential)",
        { marketplace: this.id, retryable: false },
      );
    }
    const httpConfig: NaverHttpConfig = {
      baseUrl: this.config.baseUrl,
      clientId,
      clientSecret,
    };
    if (cred.secret.accountId) httpConfig.accountId = cred.secret.accountId;
    return new NaverHttpClient(httpConfig, this.deps);
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  async verifyCredential(cred: SellerCredential): Promise<boolean> {
    try {
      await this.clientFor(cred).getToken();
      return true;
    } catch (err) {
      // Auth failure (4xx) => invalid credential. Anything retryable (network /
      // 5xx / rate limit) is a transient problem, not a verdict — rethrow it.
      if (err instanceof MarketplaceError && !err.opts.retryable) return false;
      throw err;
    }
  }

  async fetchOrders(
    cred: SellerCredential,
    params: FetchOrdersParams,
  ): Promise<FetchOrdersPage> {
    const http = this.clientFor(cred);
    const state =
      decodeCursor<OrderCursor>(params.cursor) ??
      ({ from: params.since.toISOString() } as OrderCursor);

    const fromMs = new Date(state.from).getTime();
    const nowMs = this.now();
    const toMs = Math.min(fromMs + MAX_WINDOW_MS, nowMs);
    const to = new Date(toMs).toISOString();

    // 1) Which product orders changed in this window?
    const rawStatuses = await http.request({
      method: "GET",
      path: "/external/v1/pay-order/seller/product-orders/last-changed-statuses",
      query: {
        lastChangedFrom: state.from,
        lastChangedTo: to,
        moreSequence: state.moreSequence,
      },
    });
    const statuses = LastChangedStatusesResponse.parse(rawStatuses);
    const ids = [
      ...new Set(statuses.data.lastChangeStatuses.map((s) => s.productOrderId)),
    ];

    // 2) Fetch full details (batched at 300) and normalize.
    const orders = [] as FetchOrdersPage["orders"];
    for (const batch of chunk(ids, ORDER_QUERY_BATCH)) {
      const rawDetails = await http.request({
        method: "POST",
        path: "/external/v1/pay-order/seller/product-orders/query",
        body: { productOrderIds: batch },
      });
      const details = ProductOrderQueryResponse.parse(rawDetails);
      orders.push(...mapProductOrdersToOrders(details.data));
    }

    // 3) Decide the next cursor: more within window? else more time to cover?
    let nextCursor: string | undefined;
    const moreSequence = statuses.data.more?.moreSequence;
    if (moreSequence) {
      nextCursor = encodeCursor({ from: state.from, moreSequence } as OrderCursor);
    } else if (toMs < nowMs) {
      nextCursor = encodeCursor({ from: to } as OrderCursor);
    }

    return { orders, nextCursor };
  }

  async fetchProducts(
    cred: SellerCredential,
    params: FetchProductsParams,
  ): Promise<FetchProductsPage> {
    const http = this.clientFor(cred);
    const cursorState = decodeCursor<{ page: number }>(params.cursor);
    const page = cursorState?.page ?? params.page ?? 1;
    const size = params.pageSize ?? DEFAULT_PRODUCT_PAGE_SIZE;

    const raw = await http.request({
      method: "POST",
      path: "/external/v1/products/search",
      body: { page, size, orderType: "NO_DESC" },
    });
    const parsed = ProductSearchResponse.parse(raw);
    const products = mapProductSearchToProducts(parsed);

    const nextCursor =
      page < parsed.totalPages
        ? encodeCursor({ page: page + 1 })
        : undefined;

    return { products, nextCursor };
  }
}
