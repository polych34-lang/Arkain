import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { PrismaDomainStore } from "../src/domain/repository.js";
import type { NormalizedOrder } from "../src/integrations/marketplace.js";

/**
 * ARK-10 collision test: a fake Prisma client that models just enough
 * relational behavior (an in-memory `Order` table keyed the same way
 * Postgres is — `(tenantId, marketplace, marketplaceOrderId)`) to prove
 * `PrismaDomainStore` itself never lets two tenants collide or see each
 * other's rows. This tests the application-level tenant-scoping logic
 * (`forTenant`'s argument wiring + the compound-key upsert); it does NOT
 * exercise real Postgres RLS, which has no in-memory equivalent — see
 * docs/multi-tenancy.md for how that's verified separately (migration SQL
 * reviewed + applied against a real Postgres-compatible engine).
 */
function fakePrisma() {
  type Row = Record<string, unknown> & {
    tenantId: string;
    marketplace: string;
    marketplaceOrderId: string;
    items: unknown[];
  };
  const orders: Row[] = [];
  let nextId = 0;

  function flattenOrderInput(input: Record<string, unknown>): Record<string, unknown> {
    const { tenant, items, ...rest } = input as {
      tenant?: { connect: { id: string } };
      items?: { create: unknown[] };
      [key: string]: unknown;
    };
    return { ...rest, tenantId: tenant?.connect.id, items: items?.create ?? [] };
  }

  const orderDelegate = {
    async upsert({ where, create, update }: { where: { tenantId_marketplace_marketplaceOrderId: { tenantId: string; marketplace: string; marketplaceOrderId: string } }; create: Record<string, unknown>; update: Record<string, unknown> }) {
      const key = where.tenantId_marketplace_marketplaceOrderId;
      const idx = orders.findIndex(
        (o) => o.tenantId === key.tenantId && o.marketplace === key.marketplace && o.marketplaceOrderId === key.marketplaceOrderId,
      );
      if (idx === -1) {
        const row = { id: `order-${++nextId}`, ...flattenOrderInput(create) } as Row;
        orders.push(row);
        return row;
      }
      orders[idx] = { ...orders[idx], ...flattenOrderInput(update) } as Row;
      return orders[idx];
    },
    async count({ where }: { where?: { tenantId?: string } } = {}) {
      return orders.filter((o) => where?.tenantId === undefined || o.tenantId === where.tenantId).length;
    },
    async findMany({ where }: { where?: { tenantId?: string; marketplace?: string; status?: string } } = {}) {
      return orders.filter((o) => {
        if (where?.tenantId !== undefined && o.tenantId !== where.tenantId) return false;
        if (where?.marketplace !== undefined && o.marketplace !== where.marketplace) return false;
        if (where?.status !== undefined && o.status !== where.status) return false;
        return true;
      });
    },
  };

  // Mirrors src/tenancy/tenantContext.ts's `forTenant`: `$extends` wraps
  // every delegate method through the same `$allOperations` hook the real
  // Prisma client would call.
  function wrapAllOperations<T extends Record<string, (...args: never[]) => unknown>>(
    delegate: T,
    allOperations: (params: { args: unknown; query: (args: unknown) => unknown }) => unknown,
  ): T {
    const wrapped: Record<string, unknown> = {};
    for (const key of Object.keys(delegate)) {
      wrapped[key] = (args: unknown) => allOperations({ args, query: (a) => (delegate as Record<string, (a: unknown) => unknown>)[key]!(a) });
    }
    return wrapped as T;
  }

  const client = {
    order: orderDelegate,
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(client);
    },
    async $executeRaw() {
      return 0;
    },
    $extends(config: { query: { $allOperations: (params: { args: unknown; query: (args: unknown) => unknown }) => unknown } }) {
      return {
        ...client,
        order: wrapAllOperations(orderDelegate, config.query.$allOperations),
      };
    },
  };

  return { client: client as unknown as PrismaClient, orders };
}

function order(id: string, overrides: Partial<NormalizedOrder> = {}): NormalizedOrder {
  return {
    marketplace: "naver_smartstore",
    marketplaceOrderId: id,
    orderedAt: "2026-06-20T01:00:00.000Z",
    status: "PAYED",
    buyerName: "홍길동",
    totalAmountKrw: 1000,
    items: [{ marketplaceProductId: "p1", productName: "A", quantity: 1, unitPriceKrw: 1000 }],
    raw: {},
    ...overrides,
  };
}

describe("PrismaDomainStore tenant isolation (ARK-10)", () => {
  it("lets two tenants use the identical marketplaceOrderId without colliding", async () => {
    const { client, orders } = fakePrisma();
    const store = new PrismaDomainStore(client);

    await store.upsertOrders([order("same-id-123", { buyerName: "Alice" })], "tenant-a");
    await store.upsertOrders([order("same-id-123", { buyerName: "Bob" })], "tenant-b");

    expect(orders).toHaveLength(2);
    expect(orders.find((o) => o.tenantId === "tenant-a")?.buyerName).toBe("Alice");
    expect(orders.find((o) => o.tenantId === "tenant-b")?.buyerName).toBe("Bob");
  });

  it("re-syncing the same tenant's order updates in place instead of duplicating", async () => {
    const { client, orders } = fakePrisma();
    const store = new PrismaDomainStore(client);

    await store.upsertOrders([order("o1", { totalAmountKrw: 1000 })], "tenant-a");
    await store.upsertOrders([order("o1", { totalAmountKrw: 2000 })], "tenant-a");

    expect(orders).toHaveLength(1);
    expect(orders[0]?.totalAmountKrw).toBe(2000);
  });

  it("listOrders(tenantId) never returns another tenant's rows", async () => {
    const { client } = fakePrisma();
    const store = new PrismaDomainStore(client);

    await store.upsertOrders([order("a-order", { buyerName: "Alice" })], "tenant-a");
    await store.upsertOrders([order("b-order", { buyerName: "Bob" })], "tenant-b");

    const asA = await store.listOrders({ tenantId: "tenant-a" });
    const asB = await store.listOrders({ tenantId: "tenant-b" });

    expect(asA).toHaveLength(1);
    expect(asA[0]?.marketplaceOrderId).toBe("a-order");
    expect(asB).toHaveLength(1);
    expect(asB[0]?.marketplaceOrderId).toBe("b-order");
  });

  it("listOrders() with no tenantId is the documented global ops view spanning every tenant", async () => {
    const { client } = fakePrisma();
    const store = new PrismaDomainStore(client);

    await store.upsertOrders([order("a-order")], "tenant-a");
    await store.upsertOrders([order("b-order")], "tenant-b");

    const all = await store.listOrders({});
    expect(all.map((o) => o.marketplaceOrderId).sort()).toEqual(["a-order", "b-order"]);
  });
});
