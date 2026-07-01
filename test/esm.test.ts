import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MarketplaceError } from "../src/integrations/marketplace.js";
import { withRetry } from "../src/integrations/retry.js";
import {
  EsmHttpClient,
  mapHttpError,
  mapResultError,
  type FetchLike,
} from "../src/integrations/esm/esm.http.js";
import { EsmAdapter } from "../src/integrations/esm/esm.adapter.js";
import {
  mapGoodsSearchToProducts,
  mapOrderRowsToOrders,
} from "../src/integrations/esm/esm.mapper.js";
import { EsmGoodsSearchResponse, EsmOrderSearchResponse } from "../src/integrations/esm/esm.types.js";

const CRED = {
  masterId: "master-1",
  secretKey: "s3cr3t",
  clientDomain: "arkain.example",
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

describe("ESM auth signature", () => {
  it("builds header.payload.signature with the documented JWT shape", () => {
    const client = new EsmHttpClient(
      { baseUrl: "https://api.test" },
      { ...CRED, gmarketSellerId: "seller-g" },
    );
    const token = client.sign("gmarket");
    const [headerB64, payloadB64, sigB64] = token.split(".");
    const header = JSON.parse(Buffer.from(headerB64!, "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8"));
    expect(header).toEqual({ alg: "HS256", typ: "JWT", kid: "master-1" });
    expect(payload).toEqual({
      iss: "arkain.example",
      sub: "sell",
      aud: "sa.esmplus.com",
      ssi: "G:seller-g",
    });
    const expectedSig = createHmac("sha256", CRED.secretKey)
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(sigB64).toBe(expectedSig);
  });

  it("throws a non-retryable error when the site's seller id is missing", () => {
    const client = new EsmHttpClient({ baseUrl: "https://api.test" }, CRED);
    expect(() => client.sign("auction")).toThrow(MarketplaceError);
  });
});

describe("error mapping", () => {
  it("mapHttpError treats 429/5xx as retryable, 4xx as not", () => {
    const h = { get: () => null };
    expect(mapHttpError(429, h, "{}", "x").opts.retryable).toBe(true);
    expect(mapHttpError(503, h, "{}", "x").opts.retryable).toBe(true);
    expect(mapHttpError(400, h, "{}", "x").opts.retryable).toBe(false);
  });

  it("mapResultError treats the documented rate-limit message as retryable", () => {
    const err = mapResultError(1001, "주문 조회는 5초당 1회 호출 가능합니다. 잠시 후 다시 시도해 주세요.", "x");
    expect(err.opts.retryable).toBe(true);
    expect(err.opts.retryAfterMs).toBe(5000);
  });

  it("mapResultError treats other non-zero codes as permanent", () => {
    const err = mapResultError(1000, "카테고리 코드가 없습니다", "x");
    expect(err.opts.retryable).toBe(false);
  });

  it("withRetry retries a rate-limited ResultCode then succeeds", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) throw mapResultError(1001, "잠시 후 다시 시도해 주세요.", "x");
      return "ok";
    };
    expect(await withRetry(fn, noopRetry)).toBe("ok");
    expect(calls).toBe(2);
  });
});

describe("EsmHttpClient.request", () => {
  it("throws mapResultError when ResultCode is non-zero even on HTTP 200", async () => {
    const { fetch } = fakeFetch(() => ({
      status: 200,
      body: { ResultCode: 1000, Message: "bad request" },
    }));
    const client = new EsmHttpClient(
      { baseUrl: "https://api.test" },
      { ...CRED, gmarketSellerId: "g" },
      { fetch, retry: noopRetry },
    );
    await expect(
      client.request("gmarket", { method: "POST", path: "/x", body: {} }),
    ).rejects.toThrow(/ResultCode 1000/);
  });

  it("returns the parsed body on ResultCode 0", async () => {
    const { fetch } = fakeFetch(() => ({
      status: 200,
      body: { ResultCode: 0, Data: { RequestOrders: [] } },
    }));
    const client = new EsmHttpClient(
      { baseUrl: "https://api.test" },
      { ...CRED, gmarketSellerId: "g" },
      { fetch, retry: noopRetry },
    );
    const res = await client.request<{ ResultCode: number }>("gmarket", {
      method: "POST",
      path: "/x",
      body: {},
    });
    expect(res.ResultCode).toBe(0);
  });
});

function orderRow(orderNo: string, extra: object = {}) {
  return {
    OrderNo: orderNo,
    OrderStatus: "2",
    OrderDate: "2026-06-20 10:00",
    PayDate: "2026-06-20 10:05",
    SiteGoodsNo: `sg-${orderNo}`,
    GoodsName: `상품-${orderNo}`,
    SalePrice: 10000,
    ContrAmount: 1,
    AcntMoney: 10000,
    BuyerName: "홍길동",
    ...extra,
  };
}

describe("EsmAdapter.fetchOrders", () => {
  const cred = {
    sellerId: "s",
    marketplace: "esm_2_0" as const,
    secret: { ...CRED, gmarketSellerId: "g-seller" },
  };

  it("advances statusIdx when a status query returns a partial page", async () => {
    const nowMs = Date.parse("2026-06-28T00:00:00.000Z");
    let calls = 0;
    const { fetch } = fakeFetch((url, init) => {
      calls++;
      const body = JSON.parse(init.body ?? "{}");
      // ORDER_STATUSES = [1,2,3,4,5]; the first call queries status 1.
      if (body.orderStatus === 1) {
        return { status: 200, body: { ResultCode: 0, Data: { RequestOrders: [orderRow("o1")] } } };
      }
      return { status: 200, body: { ResultCode: 0, Data: { RequestOrders: [] } } };
    });
    const adapter = new EsmAdapter({ baseUrl: "https://api.test" }, { fetch, now: () => nowMs, retry: noopRetry });

    const since = new Date(nowMs - 3600_000);
    const page1 = await adapter.fetchOrders(cred, { since });
    expect(page1.orders).toHaveLength(1);
    expect(page1.orders[0]!.marketplaceOrderId).toBe("o1");
    expect(page1.nextCursor).toBeDefined(); // partial page -> advance to next status
    expect(calls).toBe(1);

    const page2 = await adapter.fetchOrders(cred, { since, cursor: page1.nextCursor });
    expect(page2.orders).toHaveLength(0); // status 2's window is empty in this fake
  });

  it("stays on the same status/site and advances pageIndex on a full page", async () => {
    const nowMs = Date.parse("2026-06-28T00:00:00.000Z");
    const PAGE_SIZE = 200;
    const fullPage = Array.from({ length: PAGE_SIZE }, (_, i) => orderRow(`o${i}`));
    let call = 0;
    const { fetch } = fakeFetch((_url, init) => {
      call++;
      const body = JSON.parse(init.body ?? "{}");
      if (call === 1) {
        expect(body.pageIndex).toBe(1);
        return { status: 200, body: { ResultCode: 0, Data: { RequestOrders: fullPage } } };
      }
      expect(body.pageIndex).toBe(2);
      expect(body.orderStatus).toBe(1); // same status as call 1
      return { status: 200, body: { ResultCode: 0, Data: { RequestOrders: [] } } };
    });
    const adapter = new EsmAdapter({ baseUrl: "https://api.test" }, { fetch, now: () => nowMs, retry: noopRetry });
    const since = new Date(nowMs - 3600_000);
    const page1 = await adapter.fetchOrders(cred, { since });
    expect(page1.orders).toHaveLength(PAGE_SIZE);
    expect(page1.nextCursor).toBeDefined();
  });

  it("returns no orders and no cursor when the seller has no configured storefront", async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: { ResultCode: 0, Data: {} } }));
    const adapter = new EsmAdapter({ baseUrl: "https://api.test" }, { fetch, retry: noopRetry });
    const noSiteCred = { sellerId: "s", marketplace: "esm_2_0" as const, secret: { ...CRED } };
    const page = await adapter.fetchOrders(noSiteCred, { since: new Date() });
    expect(page).toEqual({ orders: [] });
  });
});

describe("EsmAdapter.fetchProducts", () => {
  const cred = {
    sellerId: "s",
    marketplace: "esm_2_0" as const,
    secret: { ...CRED, gmarketSellerId: "g-seller" },
  };

  it("maps both storefronts from one row and pages by totalItems", async () => {
    const { fetch } = fakeFetch((_url, init) => {
      const body = JSON.parse(init.body ?? "{}");
      return {
        status: 200,
        body: {
          ResultCode: 0,
          totalItems: 3,
          pageIndex: body.pageIndex,
          pageSize: 2,
          items: [
            {
              goodsNo: "1000",
              goodsName: "테스트상품",
              price: { gmkt: 19900, iac: 18900 },
              stock: { gmkt: 5, iac: 3 },
              sellStatus: { gmkt: "11", iac: "31" },
              siteGoodsNo: { gmkt: "g-2001", iac: "a-3001" },
            },
          ],
        },
      };
    });
    const adapter = new EsmAdapter({ baseUrl: "https://api.test" }, { fetch, retry: noopRetry });

    const p1 = await adapter.fetchProducts!(cred, { pageSize: 2 });
    expect(p1.products).toHaveLength(2); // gmarket + auction rows from the one goodsNo
    const gmkt = p1.products.find((p) => p.marketplaceProductId === "g-2001")!;
    expect(gmkt.salePriceKrw).toBe(19900);
    expect(gmkt.status).toBe("11");
    expect(gmkt.originProductId).toBe("1000");
    const iac = p1.products.find((p) => p.marketplaceProductId === "a-3001")!;
    expect(iac.stockQuantity).toBe(3);
    expect(p1.nextCursor).toBeDefined(); // 1*2=2 < totalItems(3)

    const p2 = await adapter.fetchProducts!(cred, { cursor: p1.nextCursor, pageSize: 2 });
    expect(p2.nextCursor).toBeUndefined(); // 2*2=4 >= totalItems(3)
  });
});

describe("EsmAdapter.verifyCredential", () => {
  it("returns false on a non-retryable auth failure", async () => {
    const { fetch } = fakeFetch(() => ({
      status: 200,
      body: { ResultCode: 1000, Message: "invalid credential" },
    }));
    const cred = { sellerId: "s", marketplace: "esm_2_0" as const, secret: { ...CRED, gmarketSellerId: "g" } };
    const adapter = new EsmAdapter({ baseUrl: "https://api.test" }, { fetch, retry: noopRetry });
    expect(await adapter.verifyCredential(cred)).toBe(false);
  });

  it("returns true on success", async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: { ResultCode: 0, items: [] } }));
    const cred = { sellerId: "s", marketplace: "esm_2_0" as const, secret: { ...CRED, gmarketSellerId: "g" } };
    const adapter = new EsmAdapter({ baseUrl: "https://api.test" }, { fetch, retry: noopRetry });
    expect(await adapter.verifyCredential(cred)).toBe(true);
  });
});

describe("mappers", () => {
  it("mapOrderRowsToOrders normalizes a row and tags the site in raw", () => {
    const rows = EsmOrderSearchResponse.parse({
      ResultCode: 0,
      Data: { RequestOrders: [orderRow("o9")] },
    }).Data.RequestOrders;
    const [order] = mapOrderRowsToOrders(rows, "gmarket");
    expect(order!.marketplaceOrderId).toBe("o9");
    expect(order!.totalAmountKrw).toBe(10000);
    expect(order!.items[0]!.unitPriceKrw).toBe(10000);
    expect((order!.raw as any).site).toBe("gmarket");
  });

  it("mapGoodsSearchToProducts flattens per-site listings", () => {
    const parsed = EsmGoodsSearchResponse.parse({
      totalItems: 1,
      items: [
        {
          goodsNo: 55,
          goodsName: "n",
          price: { gmkt: 100 },
          stock: { gmkt: 1 },
          sellStatus: { gmkt: "11" },
          siteGoodsNo: { gmkt: "gg-1" },
        },
      ],
    });
    const products = mapGoodsSearchToProducts(parsed);
    expect(products).toHaveLength(1); // only gmkt has a siteGoodsNo
    expect(products[0]!.marketplaceProductId).toBe("gg-1");
    expect(products[0]!.originProductId).toBe("55");
  });
});
