import { describe, expect, it } from "vitest";
import { buildApp, type OrderReadStore } from "../src/app.js";
import type { OrderListFilter, OrderListItem } from "../src/domain/repository.js";

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
