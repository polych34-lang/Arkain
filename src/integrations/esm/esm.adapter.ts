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
  EsmHttpClient,
  type EsmCredential,
  type EsmHttpConfig,
  type EsmHttpDeps,
} from "./esm.http.js";
import { mapGoodsSearchToProducts, mapOrderRowsToOrders, type EsmSite } from "./esm.mapper.js";
import { EsmGoodsSearchResponse, EsmOrderSearchResponse } from "./esm.types.js";

/**
 * ESM 2.0 (G마켓·옥션 ESM Trading API) adapter.
 *
 * Implements the marketplace contract end to end: per-request JWT auth, order
 * pull (windowed + per-status + paged, across both storefronts), product pull
 * (paged, both storefronts in one response), and normalization. The sync
 * engine only ever sees `MarketplaceAdapter` + normalized types — adding this
 * marketplace did not touch the sync engine or domain model (ARCHITECTURE.md
 * §5's "second marketplace is an adapter, not a rewrite" claim, now proven for
 * a second real marketplace beyond Naver).
 *
 * IMPORTANT — confidence caveat (see docs/esm-2.0-integration.md §7): the wire
 * format here is transcribed from public ESM Trading API reference pages
 * (https://etapi.gmarket.com), not verified against a live ESM PLUS account.
 * Unlike Naver (ARK-3), no credentials have ever been obtained for this
 * marketplace, so this is one caveat-tier below Naver's "verified shape,
 * unverified live data." Every raw payload is retained on `raw` so a wrong
 * assumption is correctable without re-pulling once real credentials land.
 *
 * ESM quirk: 지마켓 and 옥션 are two storefronts under one ESM PLUS master
 * account. Order inquiry is scoped to one storefront (`siteType`) per call
 * and to one `orderStatus` value per call (the API has no "all statuses"
 * mode — see the request spec) — so a single sync pass loops over
 * {storefront × status × time-window × page}, one axis advancing per
 * `fetchOrders` call. Product search returns BOTH storefronts' price/stock
 * in one row, so it needs no such loop.
 */

/** ESM caps the order-inquiry date window at 31 days; we use 30 for headroom. */
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Real order states the API exposes (excludes the "by id" search modes 0/6). */
const ORDER_STATUSES = [1, 2, 3, 4, 5] as const;
const ORDER_PAGE_SIZE = 200;
const PRODUCT_PAGE_SIZE = 200;

export interface EsmAdapterConfig extends EsmHttpConfig {}

interface OrderCursor {
  siteIdx: number;
  statusIdx: number;
  /** ISO lower bound of the current sub-window. */
  from: string;
  pageIndex: number;
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

/** "YYYY-MM-DD hh:mm" per the documented request format. */
function formatEsmDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export class EsmAdapter implements MarketplaceAdapter {
  readonly id: MarketplaceId = "esm_2_0";

  constructor(
    private readonly config: EsmAdapterConfig,
    private readonly deps: EsmHttpDeps = {},
  ) {}

  private clientFor(cred: SellerCredential): EsmHttpClient {
    const esmCred: EsmCredential = {
      masterId: cred.secret.masterId ?? "",
      secretKey: cred.secret.secretKey ?? "",
      clientDomain: cred.secret.clientDomain ?? "",
      auctionSellerId: cred.secret.auctionSellerId,
      gmarketSellerId: cred.secret.gmarketSellerId,
    };
    if (!esmCred.masterId || !esmCred.secretKey || !esmCred.clientDomain) {
      throw new MarketplaceError(
        "Missing ESM 2.0 masterId/secretKey/clientDomain credential",
        { marketplace: this.id, retryable: false },
      );
    }
    if (!esmCred.auctionSellerId && !esmCred.gmarketSellerId) {
      throw new MarketplaceError(
        "ESM 2.0 credential needs at least one of auctionSellerId/gmarketSellerId",
        { marketplace: this.id, retryable: false },
      );
    }
    return new EsmHttpClient(this.config, esmCred, this.deps);
  }

  /** Configured storefronts for a credential, in a fixed, deterministic order. */
  private sitesFor(cred: SellerCredential): EsmSite[] {
    const sites: EsmSite[] = [];
    if (cred.secret.gmarketSellerId) sites.push("gmarket");
    if (cred.secret.auctionSellerId) sites.push("auction");
    return sites;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  async verifyCredential(cred: SellerCredential): Promise<boolean> {
    try {
      const http = this.clientFor(cred);
      const sites = this.sitesFor(cred);
      const site = sites[0];
      if (!site) return false;
      await http.request(site, {
        method: "POST",
        path: "/item/v1/goods/search",
        body: { pageIndex: 1, pageSize: 1, query: {} },
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
    const sites = this.sitesFor(cred);
    if (sites.length === 0) return { orders: [] };
    const http = this.clientFor(cred);

    const state =
      decodeCursor<OrderCursor>(params.cursor) ??
      ({ siteIdx: 0, statusIdx: 0, from: params.since.toISOString(), pageIndex: 1 } as OrderCursor);

    const site = sites[state.siteIdx];
    if (!site) return { orders: [] }; // exhausted (shouldn't normally happen)

    const siteType = site === "auction" ? 1 : 2;
    const orderStatus = ORDER_STATUSES[state.statusIdx]!;
    const fromMs = new Date(state.from).getTime();
    const nowMs = this.now();
    const toMs = Math.min(fromMs + MAX_WINDOW_MS, nowMs);

    const raw = await http.request(site, {
      method: "POST",
      path: "/shipping/v1/Order/RequestOrders",
      body: {
        siteType,
        orderStatus,
        requestDateType: 2, // 결제일 기준
        requestDateFrom: formatEsmDate(fromMs),
        requestDateTo: formatEsmDate(toMs),
        pageIndex: state.pageIndex,
        pageSize: ORDER_PAGE_SIZE,
      },
    });
    const parsed = EsmOrderSearchResponse.parse(raw);
    const orders = mapOrderRowsToOrders(parsed.Data.RequestOrders, site);

    const fullPage = parsed.Data.RequestOrders.length >= ORDER_PAGE_SIZE;
    let next: OrderCursor | undefined;
    if (fullPage) {
      next = { ...state, siteIdx: state.siteIdx, pageIndex: state.pageIndex + 1 };
    } else if (state.statusIdx + 1 < ORDER_STATUSES.length) {
      next = { siteIdx: state.siteIdx, statusIdx: state.statusIdx + 1, from: state.from, pageIndex: 1 };
    } else if (state.siteIdx + 1 < sites.length) {
      next = { siteIdx: state.siteIdx + 1, statusIdx: 0, from: state.from, pageIndex: 1 };
    } else if (toMs < nowMs) {
      next = { siteIdx: 0, statusIdx: 0, from: formatIsoFromMs(toMs), pageIndex: 1 };
    }

    return { orders, nextCursor: next ? encodeCursor(next) : undefined };
  }

  async fetchProducts(
    cred: SellerCredential,
    params: FetchProductsParams,
  ): Promise<FetchProductsPage> {
    const sites = this.sitesFor(cred);
    if (sites.length === 0) return { products: [] };
    const http = this.clientFor(cred);
    // goods/search returns both storefronts per row; sign as whichever site
    // is configured first (see class doc — cross-site identity assumption).
    const signingSite = sites[0]!;

    const cursorState = decodeCursor<{ pageIndex: number }>(params.cursor);
    const pageIndex = cursorState?.pageIndex ?? params.page ?? 1;
    const pageSize = params.pageSize ?? PRODUCT_PAGE_SIZE;

    const raw = await http.request(signingSite, {
      method: "POST",
      path: "/item/v1/goods/search",
      body: { pageIndex, pageSize, query: {} },
    });
    const parsed = EsmGoodsSearchResponse.parse(raw);
    const products = mapGoodsSearchToProducts(parsed);

    const fetchedSoFar = pageIndex * pageSize;
    const nextCursor =
      fetchedSoFar < parsed.totalItems
        ? encodeCursor({ pageIndex: pageIndex + 1 })
        : undefined;

    return { products, nextCursor };
  }
}

function formatIsoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}
