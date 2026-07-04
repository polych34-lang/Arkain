import { describe, expect, it } from "vitest";
import { buildApp, type OrderReadStore } from "../src/app.js";
import type { OrderDetail, OrderListFilter, OrderListItem } from "../src/domain/repository.js";

function fakeStore(orders: OrderListItem[]): OrderReadStore {
  return {
    async listOrders(filter: OrderListFilter = {}) {
      let out = orders;
      if (filter.marketplace) out = out.filter((o) => o.marketplace === filter.marketplace);
      if (filter.status) out = out.filter((o) => o.status === filter.status);
      return out.slice(0, filter.limit ?? 50);
    },
  };
}

const AUTH_DEPS = {
  store: {
    createSeller: async () => {
      throw new Error("not used in these tests");
    },
    findSellerByEmail: async () => null,
    findSellerById: async () => null,
  },
  sessionSecret: "test-secret",
  cookieSecure: false,
};

function fakeDetailStore(details: OrderDetail[]): OrderReadStore {
  const byId = new Map(details.map((d) => [d.id, d]));
  return {
    async listOrders() {
      return details;
    },
    async getOrderById(tenantId: string, orderId: string) {
      const found = byId.get(orderId);
      return found && found.id === orderId ? found : null;
    },
    async updateOrderStatus(tenantId: string, orderId: string, status) {
      const found = byId.get(orderId);
      if (!found) return null;
      const updated = { ...found, status };
      byId.set(orderId, updated);
      return updated;
    },
  };
}

async function loginCookie(sellerId: string) {
  const { sessionSetCookieHeader } = await import("../src/auth/session.js");
  const header = sessionSetCookieHeader(sellerId, AUTH_DEPS.sessionSecret, { secure: false });
  return header.split(";")[0];
}

const sample: OrderListItem = {
  id: "1",
  marketplace: "naver_smartstore",
  marketplaceOrderId: "o1",
  status: "PAID",
  rawStatus: "PAYED",
  orderedAt: "2026-06-20T01:00:00.000Z",
  buyerName: "홍길동",
  totalAmountKrw: 4000,
  itemCount: 1,
};

describe("GET /api/orders", () => {
  it("reports configured: false when no store is wired (no DATABASE_URL)", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    const res = await app.inject({ method: "GET", url: "/api/orders" });
    expect(res.json()).toEqual({ configured: false, orders: [] });
    await app.close();
  });

  it("returns unified orders from the injected store", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      store: fakeStore([sample]),
    });
    const res = await app.inject({ method: "GET", url: "/api/orders" });
    expect(res.json()).toEqual({ configured: true, orders: [sample] });
    await app.close();
  });

  it("filters by marketplace and status query params", async () => {
    const other: OrderListItem = { ...sample, id: "2", marketplace: "coupang", status: "CANCELLED" };
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      store: fakeStore([sample, other]),
    });
    const res = await app.inject({ method: "GET", url: "/api/orders?marketplace=coupang&status=CANCELLED" });
    expect(res.json().orders).toEqual([other]);
    await app.close();
  });

  it("ignores an invalid marketplace/status filter instead of throwing", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      store: fakeStore([sample]),
    });
    const res = await app.inject({ method: "GET", url: "/api/orders?marketplace=bogus&status=bogus" });
    expect(res.statusCode).toBe(200);
    expect(res.json().orders).toEqual([sample]);
    await app.close();
  });
});

const sampleDetail: OrderDetail = {
  ...sample,
  items: [{ id: "i1", productName: "테스트 상품", quantity: 2, unitPriceKrw: 2000 }],
};

describe("GET /api/orders/:id", () => {
  it("returns 503 when getOrderById/auth isn't configured", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      store: fakeStore([sample]),
    });
    const res = await app.inject({ method: "GET", url: "/api/orders/1" });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("returns 401 without a session", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      store: fakeDetailStore([sampleDetail]),
      auth: AUTH_DEPS,
    });
    const res = await app.inject({ method: "GET", url: "/api/orders/1" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns the order detail with items for the owning tenant", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      store: fakeDetailStore([sampleDetail]),
      auth: AUTH_DEPS,
    });
    const cookie = await loginCookie("seller-1");
    const res = await app.inject({ method: "GET", url: "/api/orders/1", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().order).toEqual(sampleDetail);
    await app.close();
  });

  it("returns 404 for an unknown order id", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      store: fakeDetailStore([sampleDetail]),
      auth: AUTH_DEPS,
    });
    const cookie = await loginCookie("seller-1");
    const res = await app.inject({ method: "GET", url: "/api/orders/missing", headers: { cookie } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("PATCH /api/orders/:id", () => {
  it("updates the order status and returns the updated detail", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      store: fakeDetailStore([sampleDetail]),
      auth: AUTH_DEPS,
    });
    const cookie = await loginCookie("seller-1");
    const res = await app.inject({
      method: "PATCH",
      url: "/api/orders/1",
      headers: { cookie },
      payload: { status: "DISPATCHED" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().order.status).toBe("DISPATCHED");
    await app.close();
  });

  it("rejects an invalid status value", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      store: fakeDetailStore([sampleDetail]),
      auth: AUTH_DEPS,
    });
    const cookie = await loginCookie("seller-1");
    const res = await app.inject({
      method: "PATCH",
      url: "/api/orders/1",
      headers: { cookie },
      payload: { status: "NOT_A_STATUS" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 401 without a session", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      store: fakeDetailStore([sampleDetail]),
      auth: AUTH_DEPS,
    });
    const res = await app.inject({
      method: "PATCH",
      url: "/api/orders/1",
      payload: { status: "DISPATCHED" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("GET /orders", () => {
  it("serves the dashboard HTML shell", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    const res = await app.inject({ method: "GET", url: "/orders" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("/api/orders");
    await app.close();
  });
});

describe("POST /api/sync/run", () => {
  it("returns 503 when the sync engine isn't configured", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    const res = await app.inject({ method: "POST", url: "/api/sync/run" });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("invokes the injected sync trigger and returns its summaries", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      runSync: async () => [
        { connectionId: "c1", marketplace: "naver_smartstore", ordersFetched: 2, totalOrders: 2, status: "success" },
      ],
    });
    const res = await app.inject({ method: "POST", url: "/api/sync/run" });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toHaveLength(1);
    await app.close();
  });
});
