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
  CoupangHttpClient,
  type CoupangCredential,
  type CoupangHttpConfig,
  type CoupangHttpDeps,
} from "./coupang.http.js";
import { mapOrderSheetsToOrders, mapSellerProductsToProducts } from "./coupang.mapper.js";
import { CoupangOrderSheetsResponse, CoupangSellerProductsResponse } from "./coupang.types.js";

/**
 * 쿠팡 Wing/Open API adapter — implements the marketplace contract end to end:
 * per-request HMAC auth, order pull (windowed + per-status + cursor), product
 * pull (paged catalog), and normalization. The sync engine only ever sees
 * `MarketplaceAdapter` + normalized types, proving ARCHITECTURE.md §5's
 * "second marketplace is an adapter, not a rewrite" claim for 쿠팡 specifically
 * (ARK-27) — same claim already proven once for ESM 2.0 (ARK-11).
 *
 * IMPORTANT — confidence caveat (see docs/coupang-integration.md §6): the wire
 * format here is transcribed from the public Coupang Open API reference, not
 * verified against a live WING vendor account. No credentials have ever been
 * obtained for this marketplace. Every raw payload is retained on `raw` so a
 * wrong assumption is correctable without re-pulling once real credentials
 * land.
 *
 * Coupang quirk: the 발주서(order sheet) list endpoint requires exactly one
 * `status` value per call (no documented "all statuses" mode — same open
 * question ESM's order-status loop hit) — so a sync pass loops over
 * {status × time-window × cursor}, one axis advancing per `fetchOrders` call.
 */

/** Coupang's documented order-sheet date window cap (assumed 31 days, unverified). */
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
/** Order-sheet statuses the list endpoint accepts (no "ALL" mode documented). */
const ORDER_STATUSES = [
  "ACCEPT",
  "INSTRUCT",
  "DEPARTURE",
  "DELIVERING",
  "FINAL_DELIVERY",
  "NONE_TRACKING",
] as const;
const ORDER_PAGE_SIZE = 50; // documented max for ordersheets
const PRODUCT_PAGE_SIZE = 100; // documented max for seller-products

export interface CoupangAdapterConfig extends CoupangHttpConfig {}

interface OrderCursor {
  statusIdx: number;
  /** ISO lower bound of the current sub-window. */
  from: string;
  nextToken?: string;
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

/** "yyyy-MM-dd", the documented `createdAtFrom`/`createdAtTo` format. */
function formatOrderDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export class CoupangAdapter implements MarketplaceAdapter {
  readonly id: MarketplaceId = "coupang";

  constructor(
    private readonly config: CoupangAdapterConfig,
    private readonly deps: CoupangHttpDeps = {},
  ) {}

  /** Builds the transport for a seller (same shape as Naver/ESM's `clientFor`). */
  private clientFor(cred: SellerCredential): CoupangHttpClient {
    const coupangCred: CoupangCredential = {
      vendorId: cred.secret.vendorId ?? "",
      accessKey: cred.secret.accessKey ?? "",
      secretKey: cred.secret.secretKey ?? "",
    };
    if (!coupangCred.vendorId || !coupangCred.accessKey || !coupangCred.secretKey) {
      throw new MarketplaceError(
        "Missing Coupang vendorId/accessKey/secretKey credential",
        { marketplace: this.id, retryable: false },
      );
    }
    return new CoupangHttpClient(this.config, coupangCred, this.deps);
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  async verifyCredential(cred: SellerCredential): Promise<boolean> {
    try {
      const http = this.clientFor(cred);
      const vendorId = cred.secret.vendorId!;
      await http.request({
        method: "GET",
        path: `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products`,
        query: { vendorId, maxPerPage: 1 },
      });
      return true;
    } catch (err) {
      if (err instanceof MarketplaceError && !err.opts.retryable) return false;
      throw err;
    }
  }

  async fetchOrders(
    cred: SellerCredential,
    params: FetchOrdersParams,
  ): Promise<FetchOrdersPage> {
    const http = this.clientFor(cred);
    const vendorId = cred.secret.vendorId!;
    const state =
      decodeCursor<OrderCursor>(params.cursor) ??
      ({ statusIdx: 0, from: params.since.toISOString() } as OrderCursor);

    const status = ORDER_STATUSES[state.statusIdx];
    if (!status) return { orders: [] }; // exhausted (shouldn't normally happen)

    const fromMs = new Date(state.from).getTime();
    const nowMs = this.now();
    const toMs = Math.min(fromMs + MAX_WINDOW_MS, nowMs);

    const raw = await http.request({
      method: "GET",
      path: `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/ordersheets`,
      query: {
        createdAtFrom: formatOrderDate(fromMs),
        createdAtTo: formatOrderDate(toMs),
        status,
        maxPerPage: ORDER_PAGE_SIZE,
        nextToken: state.nextToken,
      },
    });
    const parsed = CoupangOrderSheetsResponse.parse(raw);
    const orders = mapOrderSheetsToOrders(parsed.data);

    let next: OrderCursor | undefined;
    if (parsed.nextToken) {
      next = { statusIdx: state.statusIdx, from: state.from, nextToken: parsed.nextToken };
    } else if (state.statusIdx + 1 < ORDER_STATUSES.length) {
      next = { statusIdx: state.statusIdx + 1, from: state.from };
    } else if (toMs < nowMs) {
      next = { statusIdx: 0, from: new Date(toMs).toISOString() };
    }

    return { orders, nextCursor: next ? encodeCursor(next) : undefined };
  }

  async fetchProducts(
    cred: SellerCredential,
    params: FetchProductsParams,
  ): Promise<FetchProductsPage> {
    const http = this.clientFor(cred);
    const vendorId = cred.secret.vendorId!;
    const cursorState = decodeCursor<{ nextToken?: string }>(params.cursor);
    const nextToken = cursorState?.nextToken;
    const pageSize = params.pageSize ?? PRODUCT_PAGE_SIZE;

    const raw = await http.request({
      method: "GET",
      path: `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products`,
      query: { vendorId, maxPerPage: pageSize, nextToken },
    });
    const parsed = CoupangSellerProductsResponse.parse(raw);
    const products = mapSellerProductsToProducts(parsed.data);

    const nextCursor = parsed.nextToken
      ? encodeCursor({ nextToken: parsed.nextToken })
      : undefined;

    return { products, nextCursor };
  }
}
