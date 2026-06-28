import bcrypt from "bcryptjs";
import { describe, expect, it, vi } from "vitest";
import { MarketplaceError } from "../src/integrations/marketplace.js";
import { withRetry } from "../src/integrations/retry.js";
import {
  NaverHttpClient,
  mapHttpError,
  type FetchLike,
} from "../src/integrations/naver/naver.http.js";
import { NaverSmartstoreAdapter } from "../src/integrations/naver/naver.adapter.js";
import {
  mapProductOrdersToOrders,
  mapProductSearchToProducts,
} from "../src/integrations/naver/naver.mapper.js";
import { ProductOrderDetail } from "../src/integrations/naver/naver.types.js";

// A valid bcrypt salt string usable as a fake client_secret.
const FAKE_SECRET = "$2a$10$abcdefghijklmnopqrstuv";
const FAKE_ID = "client-123";

// --- a tiny fetch double, routed by URL substring ---
type Handler = (url: string, init: { body?: string }) => {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

function fakeFetch(handler: Handler): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(url);
    const { status, body, headers = {} } = handler(url, init);
    return {
      status,
      headers: { get: (n) => headers[n.toLowerCase()] ?? null },
      text: async () =>
        typeof body === "string" ? body : JSON.stringify(body),
    };
  };
  return { fetch, calls };
}

const noopRetry = { sleep: async () => {}, random: () => 0 };

describe("Naver auth signature", () => {
  it("signs '{clientId}_{ts}' with bcrypt(secret as salt) and base64s it", () => {
    const ts = 1_700_000_000_000;
    const sig = NaverHttpClient.sign(FAKE_ID, FAKE_SECRET, ts);
    const decoded = Buffer.from(sig, "base64").toString("utf8");
    // The decoded value is a bcrypt hash of the password under the secret salt.
    expect(bcrypt.compareSync(`${FAKE_ID}_${ts}`, decoded)).toBe(true);
  });
});

describe("NaverHttpClient token cache", () => {
  it("issues once, reuses until near expiry, then refreshes", async () => {
    let nowMs = 1_000_000;
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      body: { access_token: "tok-1", expires_in: 10800, token_type: "Bearer" },
    }));
    const client = new NaverHttpClient(
      { baseUrl: "https://api.test", clientId: FAKE_ID, clientSecret: FAKE_SECRET },
      { fetch, now: () => nowMs, retry: noopRetry },
    );

    expect(await client.getToken()).toBe("tok-1");
    expect(await client.getToken()).toBe("tok-1"); // cached, no new call
    expect(calls.length).toBe(1);

    // Advance past (expiry - skew) -> a refresh is forced.
    nowMs += 10800 * 1000;
    await client.getToken();
    expect(calls.length).toBe(2);
  });
});

describe("error mapping + retry policy", () => {
  it("marks 429 / 5xx / RATELIMIT retryable and 4xx not", () => {
    const h = { get: () => null };
    expect(mapHttpError(429, h, "{}", "x").opts.retryable).toBe(true);
    expect(mapHttpError(503, h, "{}", "x").opts.retryable).toBe(true);
    expect(
      mapHttpError(200, h, JSON.stringify({ code: "GW.RATELIMIT" }), "x").opts
        .retryable,
    ).toBe(true);
    expect(mapHttpError(400, h, "{}", "x").opts.retryable).toBe(false);
    expect(mapHttpError(401, h, "{}", "x").opts.retryable).toBe(false);
  });

  it("parses Retry-After seconds into a ms backoff hint", () => {
    const err = mapHttpError(429, { get: (n) => (n === "retry-after" ? "3" : null) }, "{}", "x");
    expect(err.opts.retryAfterMs).toBe(3000);
  });

  it("withRetry retries retryable errors then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        new MarketplaceError("rl", { marketplace: "naver_smartstore", retryable: true }),
      )
      .mockResolvedValueOnce("ok");
    const out = await withRetry(fn, noopRetry);
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("withRetry does not retry non-retryable errors", async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(
        new MarketplaceError("auth", { marketplace: "naver_smartstore", retryable: false }),
      );
    await expect(withRetry(fn, noopRetry)).rejects.toThrow("auth");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// --- adapter helpers: a fetch that serves token + order/product endpoints ---
function makeFetch(opts: {
  lastChanged: Array<{ status: number; body: unknown }>;
  detailFor: (ids: string[]) => unknown;
  productSearch?: (page: number) => unknown;
}) {
  let lcCall = 0;
  return fakeFetch((url, init) => {
    if (url.includes("/oauth2/token")) {
      return {
        status: 200,
        body: { access_token: "tok", expires_in: 10800, token_type: "Bearer" },
      };
    }
    if (url.includes("last-changed-statuses")) {
      const r = opts.lastChanged[lcCall++] ?? { status: 200, body: { data: {} } };
      return r;
    }
    if (url.includes("product-orders/query")) {
      const ids = JSON.parse(init.body ?? "{}").productOrderIds as string[];
      return { status: 200, body: opts.detailFor(ids) };
    }
    if (url.includes("/products/search")) {
      const page = JSON.parse(init.body ?? "{}").page as number;
      return { status: 200, body: opts.productSearch?.(page) ?? { contents: [] } };
    }
    return { status: 404, body: { code: "NOT_FOUND", message: url } };
  });
}

function detail(productOrderId: string, orderId: string, extra: object = {}) {
  return {
    productOrder: { productOrderId, productName: `p-${productOrderId}`, quantity: 1, totalPaymentAmount: 1000, ...extra },
    order: { orderId, ordererName: "홍길동", paymentDate: "2026-06-20T10:00:00.000+09:00" },
  };
}

describe("NaverSmartstoreAdapter.fetchOrders", () => {
  const cred = { sellerId: "s", marketplace: "naver_smartstore" as const, secret: { clientId: FAKE_ID, clientSecret: FAKE_SECRET } };

  it("groups product-orders by orderId and pages via moreSequence", async () => {
    const nowMs = new Date("2026-06-28T00:00:00.000Z").getTime();
    const { fetch, calls } = makeFetch({
      lastChanged: [
        { status: 200, body: { data: { lastChangeStatuses: [{ productOrderId: "po1" }, { productOrderId: "po2" }], more: { moreSequence: "seq1" } } } },
        { status: 200, body: { data: { lastChangeStatuses: [{ productOrderId: "po3" }] } } },
      ],
      detailFor: (ids) => ({
        data: ids.map((id) => (id === "po3" ? detail(id, "orderB") : detail(id, "orderA"))),
      }),
    });
    const adapter = new NaverSmartstoreAdapter(
      { baseUrl: "https://api.test" },
      { fetch, now: () => nowMs, retry: noopRetry },
    );

    const since = new Date(nowMs - 60 * 60 * 1000); // 1h ago -> window end is now
    const page1 = await adapter.fetchOrders(cred, { since });
    expect(page1.orders).toHaveLength(1); // po1 + po2 collapse into orderA
    expect(page1.orders[0]!.marketplaceOrderId).toBe("orderA");
    expect(page1.orders[0]!.items).toHaveLength(2);
    expect(page1.orders[0]!.totalAmountKrw).toBe(2000);
    expect(page1.nextCursor).toBeDefined(); // moreSequence present

    const page2 = await adapter.fetchOrders(cred, { since, cursor: page1.nextCursor });
    expect(page2.orders[0]!.marketplaceOrderId).toBe("orderB");
    expect(page2.nextCursor).toBeUndefined(); // no more, window already at now
    expect(calls.some((c) => c.includes("moreSequence=seq1"))).toBe(true);
  });

  it("advances the time window when it lags behind now", async () => {
    const nowMs = new Date("2026-06-28T00:00:00.000Z").getTime();
    const { fetch } = makeFetch({
      lastChanged: [{ status: 200, body: { data: { lastChangeStatuses: [] } } }],
      detailFor: () => ({ data: [] }),
    });
    const adapter = new NaverSmartstoreAdapter(
      { baseUrl: "https://api.test" },
      { fetch, now: () => nowMs, retry: noopRetry },
    );
    const since = new Date(nowMs - 48 * 60 * 60 * 1000); // 48h ago -> 1 window left
    const page = await adapter.fetchOrders(cred, { since });
    expect(page.nextCursor).toBeDefined(); // window (24h) < 48h, so continue
  });

  it("batches detail queries at 300 ids", async () => {
    const nowMs = new Date("2026-06-28T00:00:00.000Z").getTime();
    const ids = Array.from({ length: 301 }, (_, i) => `po${i}`);
    let queryCalls = 0;
    const { fetch } = fakeFetch((url, init) => {
      if (url.includes("/oauth2/token")) return { status: 200, body: { access_token: "t", expires_in: 10800 } };
      if (url.includes("last-changed-statuses")) return { status: 200, body: { data: { lastChangeStatuses: ids.map((id) => ({ productOrderId: id })) } } };
      if (url.includes("product-orders/query")) {
        queryCalls++;
        const reqIds = JSON.parse(init.body ?? "{}").productOrderIds as string[];
        return { status: 200, body: { data: reqIds.map((id) => detail(id, id)) } };
      }
      return { status: 404, body: {} };
    });
    const adapter = new NaverSmartstoreAdapter({ baseUrl: "https://api.test" }, { fetch, now: () => nowMs, retry: noopRetry });
    const page = await adapter.fetchOrders(cred, { since: new Date(nowMs - 3600_000) });
    expect(queryCalls).toBe(2); // 300 + 1
    expect(page.orders).toHaveLength(301);
  });
});

describe("NaverSmartstoreAdapter.fetchProducts", () => {
  const cred = { sellerId: "s", marketplace: "naver_smartstore" as const, secret: { clientId: FAKE_ID, clientSecret: FAKE_SECRET } };
  it("maps channel products and pages by totalPages", async () => {
    const nowMs = Date.parse("2026-06-28T00:00:00.000Z");
    const { fetch } = makeFetch({
      lastChanged: [],
      detailFor: () => ({ data: [] }),
      productSearch: (page) => ({
        totalPages: 2,
        page,
        contents: [
          { originProductNo: 1000 + page, channelProducts: [{ channelProductNo: 2000 + page, name: `상품${page}`, salePrice: 19900, stockQuantity: 5, statusType: "SALE" }] },
        ],
      }),
    });
    const adapter = new NaverSmartstoreAdapter({ baseUrl: "https://api.test" }, { fetch, now: () => nowMs, retry: noopRetry });

    const p1 = await adapter.fetchProducts(cred, {});
    expect(p1.products[0]!.salePriceKrw).toBe(19900);
    expect(p1.products[0]!.marketplaceProductId).toBe("2001");
    expect(p1.products[0]!.originProductId).toBe("1001");
    expect(p1.nextCursor).toBeDefined();

    const p2 = await adapter.fetchProducts(cred, { cursor: p1.nextCursor });
    expect(p2.products[0]!.marketplaceProductId).toBe("2002");
    expect(p2.nextCursor).toBeUndefined();
  });
});

describe("mappers", () => {
  it("marks an order MIXED when its line statuses differ and derives unit price", () => {
    const details = [
      ProductOrderDetail.parse(detail("po1", "o1", { productOrderStatus: "PAYED", quantity: 2, totalPaymentAmount: 3000, unitPrice: undefined })),
      ProductOrderDetail.parse(detail("po2", "o1", { productOrderStatus: "CANCELED" })),
    ];
    const [order] = mapProductOrdersToOrders(details);
    expect(order!.status).toBe("MIXED");
    expect(order!.items.find((i) => i.productName === "p-po1")!.unitPriceKrw).toBe(1500); // 3000/2
    expect(order!.totalAmountKrw).toBe(4000); // 3000 + 1000
  });

  it("flattens product search contents into normalized products", () => {
    const products = mapProductSearchToProducts({
      totalElements: 1, totalPages: 1, page: 1, size: 1,
      contents: [{ originProductNo: 9, channelProducts: [{ channelProductNo: 99, name: "n", salePrice: 100, stockQuantity: 0, statusType: "SALE" }] }],
    } as any);
    expect(products).toHaveLength(1);
    expect(products[0]!.originProductId).toBe("9");
  });
});
