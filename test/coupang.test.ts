import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MarketplaceError } from "../src/integrations/marketplace.js";
import { withRetry } from "../src/integrations/retry.js";
import {
  CoupangHttpClient,
  buildSignedQuery,
  formatSignedDate,
  mapHttpError,
  type FetchLike,
} from "../src/integrations/coupang/coupang.http.js";
import { CoupangAdapter } from "../src/integrations/coupang/coupang.adapter.js";
import {
  mapOrderSheetsToOrders,
  mapSellerProductsToProducts,
} from "../src/integrations/coupang/coupang.mapper.js";
import {
  CoupangOrderSheetsResponse,
  CoupangSellerProductsResponse,
} from "../src/integrations/coupang/coupang.types.js";

const CRED = {
  vendorId: "A00000000",
  accessKey: "access-1",
  secretKey: "s3cr3t",
};

// --- a tiny fetch double, routed by URL substring ---
type Handler = (url: string, init: { body?: string }) => {
  status: number;
  body: unknown;
};

function fakeFetch(handler: Handler): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(url);
    const { status, body } = handler(url, init);
    return {
      status,
      headers: { get: () => null },
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  };
  return { fetch, calls };
}

const noopRetry = { sleep: async () => {}, random: () => 0 };

describe("Coupang auth signature", () => {
  it("formats signed-date as UTC yyMMdd'T'HHmmss'Z'", () => {
    const ms = Date.parse("2026-07-02T09:15:03.000Z");
    expect(formatSignedDate(ms)).toBe("260702T091503Z");
  });

  it("sorts query keys before building the signed query string", () => {
    expect(buildSignedQuery({ b: 2, a: 1, c: undefined })).toBe("a=1&b=2");
    expect(buildSignedQuery(undefined)).toBe("");
  });

  it("builds the CEA header with a hex HMAC-SHA256 signature", () => {
    const nowMs = Date.parse("2026-07-02T09:15:03.000Z");
    const client = new CoupangHttpClient(
      { baseUrl: "https://api.test" },
      CRED,
      { now: () => nowMs },
    );
    const header = client.sign("GET", "/x", "a=1");
    const signedDate = formatSignedDate(nowMs);
    const expectedSig = createHmac("sha256", CRED.secretKey)
      .update(`${signedDate}GET/xa=1`)
      .digest("hex");
    expect(header).toBe(
      `CEA algorithm=HmacSHA256, access-key=${CRED.accessKey}, signed-date=${signedDate}, signature=${expectedSig}`,
    );
  });
});

describe("error mapping", () => {
  it("mapHttpError treats 429/5xx as retryable, 4xx as not", () => {
    const h = { get: () => null };
    expect(mapHttpError(429, h, "{}", "x").opts.retryable).toBe(true);
    expect(mapHttpError(503, h, "{}", "x").opts.retryable).toBe(true);
    expect(mapHttpError(401, h, "{}", "x").opts.retryable).toBe(false);
    expect(mapHttpError(404, h, "{}", "x").opts.retryable).toBe(false);
  });

  it("honours a Retry-After header on 429", () => {
    const h = { get: (name: string) => (name === "retry-after" ? "3" : null) };
    const err = mapHttpError(429, h, "{}", "x");
    expect(err.opts.retryAfterMs).toBe(3000);
  });

  it("withRetry retries a 429 then succeeds", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) throw mapHttpError(429, { get: () => null }, "{}", "x");
      return "ok";
    };
    expect(await withRetry(fn, noopRetry)).toBe("ok");
    expect(calls).toBe(2);
  });
});

describe("CoupangHttpClient.request", () => {
  it("throws mapHttpError on a non-2xx response", async () => {
    const { fetch } = fakeFetch(() => ({
      status: 401,
      body: { code: "AUTH_FAILED", message: "invalid signature" },
    }));
    const client = new CoupangHttpClient(
      { baseUrl: "https://api.test" },
      CRED,
      { fetch, retry: noopRetry },
    );
    await expect(
      client.request({ method: "GET", path: "/x" }),
    ).rejects.toThrow(/401/);
  });

  it("returns the parsed body on a 2xx response", async () => {
    const { fetch } = fakeFetch(() => ({
      status: 200,
      body: { code: "200", data: [] },
    }));
    const client = new CoupangHttpClient(
      { baseUrl: "https://api.test" },
      CRED,
      { fetch, retry: noopRetry },
    );
    const res = await client.request<{ code: string }>({ method: "GET", path: "/x" });
    expect(res.code).toBe("200");
  });
});

function orderSheet(id: number, extra: object = {}) {
  return {
    shipmentBoxId: id,
    orderId: `o-${id}`,
    orderedAt: "2026-06-20T10:00:00",
    paidAt: "2026-06-20T10:05:00",
    status: "ACCEPT",
    orderer: { name: "홍길동" },
    orderItems: [
      {
        vendorItemId: `vi-${id}`,
        vendorItemName: `상품-${id}`,
        shippingCount: 1,
        salesPrice: 10000,
      },
    ],
    ...extra,
  };
}

describe("CoupangAdapter.fetchOrders", () => {
  const cred = {
    sellerId: "s",
    marketplace: "coupang" as const,
    secret: { ...CRED },
  };

  it("advances statusIdx when a status query returns no nextToken", async () => {
    const nowMs = Date.parse("2026-06-28T00:00:00.000Z");
    let calls = 0;
    const { fetch } = fakeFetch((url) => {
      calls++;
      // ORDER_STATUSES[0] === "ACCEPT"; the first call queries that status.
      if (url.includes("status=ACCEPT")) {
        return { status: 200, body: { code: "200", data: [orderSheet(1)] } };
      }
      return { status: 200, body: { code: "200", data: [] } };
    });
    const adapter = new CoupangAdapter(
      { baseUrl: "https://api.test" },
      { fetch, now: () => nowMs, retry: noopRetry },
    );

    const since = new Date(nowMs - 3600_000);
    const page1 = await adapter.fetchOrders(cred, { since });
    expect(page1.orders).toHaveLength(1);
    expect(page1.orders[0]!.marketplaceOrderId).toBe("1");
    expect(page1.nextCursor).toBeDefined(); // no nextToken -> advance to next status
    expect(calls).toBe(1);

    const page2 = await adapter.fetchOrders(cred, { since, cursor: page1.nextCursor });
    expect(page2.orders).toHaveLength(0); // next status's window is empty in this fake
  });

  it("stays on the same status and follows nextToken when present", async () => {
    let call = 0;
    const { fetch } = fakeFetch((url) => {
      call++;
      if (call === 1) {
        expect(url).not.toContain("nextToken=");
        return {
          status: 200,
          body: { code: "200", data: [orderSheet(1)], nextToken: "cursor-2" },
        };
      }
      expect(url).toContain("nextToken=cursor-2");
      expect(url).toContain("status=ACCEPT"); // same status as call 1
      return { status: 200, body: { code: "200", data: [] } };
    });
    const adapter = new CoupangAdapter({ baseUrl: "https://api.test" }, { fetch, retry: noopRetry });
    const since = new Date(Date.now() - 3600_000);
    const page1 = await adapter.fetchOrders(cred, { since });
    expect(page1.orders).toHaveLength(1);
    expect(page1.nextCursor).toBeDefined();
  });

  it("throws a non-retryable error when the credential is incomplete", async () => {
    const adapter = new CoupangAdapter({ baseUrl: "https://api.test" }, { retry: noopRetry });
    const badCred = { sellerId: "s", marketplace: "coupang" as const, secret: {} };
    await expect(
      adapter.fetchOrders(badCred, { since: new Date() }),
    ).rejects.toThrow(MarketplaceError);
  });
});

describe("CoupangAdapter.fetchProducts", () => {
  const cred = {
    sellerId: "s",
    marketplace: "coupang" as const,
    secret: { ...CRED },
  };

  it("flattens per-item listings and follows nextToken", async () => {
    const { fetch } = fakeFetch(() => ({
      status: 200,
      body: {
        code: "200",
        nextToken: "np-2",
        data: [
          {
            sellerProductId: "sp-1",
            sellerProductName: "마스터상품",
            items: [
              {
                vendorItemId: "vi-1",
                itemName: "옵션A",
                salePrice: 19900,
                stockQuantity: 5,
                saleStatusName: "ON_SALE",
              },
              {
                vendorItemId: "vi-2",
                itemName: "옵션B",
                salePrice: 21900,
                stockQuantity: 0,
                saleStatusName: "OUT_OF_STOCK",
              },
            ],
          },
        ],
      },
    }));
    const adapter = new CoupangAdapter({ baseUrl: "https://api.test" }, { fetch, retry: noopRetry });

    const p1 = await adapter.fetchProducts!(cred, {});
    expect(p1.products).toHaveLength(2);
    const a = p1.products.find((p) => p.marketplaceProductId === "vi-1")!;
    expect(a.salePriceKrw).toBe(19900);
    expect(a.originProductId).toBe("sp-1");
    expect(p1.nextCursor).toBeDefined();

    const noMore = fakeFetch(() => ({
      status: 200,
      body: { code: "200", data: [] },
    }));
    const adapter2 = new CoupangAdapter(
      { baseUrl: "https://api.test" },
      { fetch: noMore.fetch, retry: noopRetry },
    );
    const p2 = await adapter2.fetchProducts!(cred, { cursor: p1.nextCursor });
    expect(p2.nextCursor).toBeUndefined();
  });
});

describe("CoupangAdapter.verifyCredential", () => {
  it("returns false on a non-retryable auth failure", async () => {
    const { fetch } = fakeFetch(() => ({
      status: 401,
      body: { code: "AUTH_FAILED", message: "invalid signature" },
    }));
    const cred = { sellerId: "s", marketplace: "coupang" as const, secret: { ...CRED } };
    const adapter = new CoupangAdapter({ baseUrl: "https://api.test" }, { fetch, retry: noopRetry });
    expect(await adapter.verifyCredential(cred)).toBe(false);
  });

  it("returns true on success", async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: { code: "200", data: [] } }));
    const cred = { sellerId: "s", marketplace: "coupang" as const, secret: { ...CRED } };
    const adapter = new CoupangAdapter({ baseUrl: "https://api.test" }, { fetch, retry: noopRetry });
    expect(await adapter.verifyCredential(cred)).toBe(true);
  });

  it("rethrows a retryable (rate-limit) failure instead of returning false", async () => {
    const { fetch } = fakeFetch(() => ({ status: 429, body: { message: "too many requests" } }));
    const cred = { sellerId: "s", marketplace: "coupang" as const, secret: { ...CRED } };
    const adapter = new CoupangAdapter(
      { baseUrl: "https://api.test" },
      { fetch, retry: { ...noopRetry, maxAttempts: 1 } },
    );
    await expect(adapter.verifyCredential(cred)).rejects.toThrow(MarketplaceError);
  });
});

describe("mappers", () => {
  it("mapOrderSheetsToOrders normalizes one sheet per shipmentBoxId", () => {
    const parsed = CoupangOrderSheetsResponse.parse({
      code: "200",
      data: [orderSheet(9)],
    });
    const [order] = mapOrderSheetsToOrders(parsed.data);
    expect(order!.marketplaceOrderId).toBe("9");
    expect(order!.totalAmountKrw).toBe(10000);
    expect(order!.items[0]!.unitPriceKrw).toBe(10000);
    expect(order!.buyerName).toBe("홍길동");
  });

  it("mapSellerProductsToProducts flattens per-item listings", () => {
    const parsed = CoupangSellerProductsResponse.parse({
      code: "200",
      data: [
        {
          sellerProductId: 55,
          sellerProductName: "n",
          items: [
            { vendorItemId: "v1", itemName: "a", salePrice: 100, stockQuantity: 1, saleStatusName: "ON_SALE" },
          ],
        },
      ],
    });
    const products = mapSellerProductsToProducts(parsed.data);
    expect(products).toHaveLength(1);
    expect(products[0]!.marketplaceProductId).toBe("v1");
    expect(products[0]!.originProductId).toBe("55");
  });
});
