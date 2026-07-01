import { describe, expect, it, vi } from "vitest";
import type {
  FetchOrdersPage,
  FetchOrdersParams,
  MarketplaceAdapter,
  NormalizedOrder,
  SellerCredential,
} from "../src/integrations/marketplace.js";
import {
  OrderSyncEngine,
  type OrderSyncStore,
  type SyncConnection,
} from "../src/sync/orderSyncEngine.js";

function order(id: string): NormalizedOrder {
  return {
    marketplace: "naver_smartstore",
    marketplaceOrderId: id,
    orderedAt: "2026-06-20T01:00:00.000Z",
    status: "PAYED",
    buyerName: "홍길동",
    totalAmountKrw: 1000,
    items: [{ marketplaceProductId: "p1", productName: "A", quantity: 1, unitPriceKrw: 1000 }],
    raw: {},
  };
}

/** In-memory fake of the narrow store the engine depends on — no DB needed. */
function fakeStore(): OrderSyncStore & { runs: Array<{ status: string; ordersPulled: number; error?: string }>; upserted: NormalizedOrder[] } {
  const upserted: NormalizedOrder[] = [];
  const runs: Array<{ status: string; ordersPulled: number; error?: string }> = [];
  const cursors = new Map<string, string>();
  return {
    upserted,
    runs,
    async getLastCursor(connectionId) {
      return cursors.get(connectionId);
    },
    async recordSyncStart() {
      return `run-${runs.length}`;
    },
    async recordSyncFinish(_runId, result) {
      runs.push(result);
      if (result.cursor) cursors.set("conn-1", result.cursor);
    },
    async upsertOrders(orders) {
      upserted.push(...orders);
      return upserted.length;
    },
  };
}

function connection(overrides: Partial<SyncConnection> = {}): SyncConnection {
  return {
    id: "conn-1",
    marketplace: "naver_smartstore",
    credential: { sellerId: "s1", marketplace: "naver_smartstore", secret: {} },
    ...overrides,
  };
}

describe("OrderSyncEngine.syncConnection", () => {
  it("pages until nextCursor is absent, upserting every page", async () => {
    const store = fakeStore();
    const pages: FetchOrdersPage[] = [
      { orders: [order("o1"), order("o2")], nextCursor: "c1" },
      { orders: [order("o3")], nextCursor: undefined },
    ];
    let call = 0;
    const adapter: MarketplaceAdapter = {
      id: "naver_smartstore",
      verifyCredential: vi.fn(),
      fetchOrders: vi.fn(async () => pages[call++]!),
    };

    const engine = new OrderSyncEngine({ naver_smartstore: adapter }, store);
    const summary = await engine.syncConnection(connection());

    expect(summary.status).toBe("success");
    expect(summary.ordersFetched).toBe(3);
    expect(store.upserted).toHaveLength(3);
    expect(adapter.fetchOrders).toHaveBeenCalledTimes(2);
    expect(store.runs).toEqual([{ status: "success", ordersPulled: 3, cursor: undefined }]);
  });

  it("resumes from the last successful cursor instead of the default lookback", async () => {
    const store = fakeStore();
    // Seed a prior successful run's cursor for "conn-1" (see fakeStore()).
    await store.recordSyncFinish("run-0", { status: "success", ordersPulled: 1, cursor: "resume-here" });

    let seenCursor: string | undefined;
    const adapter: MarketplaceAdapter = {
      id: "naver_smartstore",
      verifyCredential: vi.fn(),
      fetchOrders: vi.fn(async (_cred: SellerCredential, params: FetchOrdersParams) => {
        seenCursor = params.cursor;
        return { orders: [] };
      }),
    };

    const engine = new OrderSyncEngine({ naver_smartstore: adapter }, store);
    await engine.syncConnection(connection());
    expect(seenCursor).toBe("resume-here");
  });

  it("records a failed SyncRun and returns status failed when the adapter throws", async () => {
    const store = fakeStore();
    const adapter: MarketplaceAdapter = {
      id: "naver_smartstore",
      verifyCredential: vi.fn(),
      fetchOrders: vi.fn(async () => {
        throw new Error("naver down");
      }),
    };

    const engine = new OrderSyncEngine({ naver_smartstore: adapter }, store);
    const summary = await engine.syncConnection(connection());

    expect(summary.status).toBe("failed");
    expect(summary.error).toBe("naver down");
    expect(store.runs).toEqual([{ status: "failed", ordersPulled: 0, cursor: undefined, error: "naver down" }]);
  });

  it("fails cleanly when no adapter is registered for the connection's marketplace", async () => {
    const store = fakeStore();
    const engine = new OrderSyncEngine({}, store);
    const summary = await engine.syncConnection(connection());
    expect(summary.status).toBe("failed");
    expect(summary.error).toMatch(/no adapter registered/);
  });

  it("stops paging at maxPagesPerCycle so one connection can't starve the scheduler", async () => {
    const store = fakeStore();
    const adapter: MarketplaceAdapter = {
      id: "naver_smartstore",
      verifyCredential: vi.fn(),
      fetchOrders: vi.fn(async () => ({ orders: [order("o")], nextCursor: "always-more" })),
    };
    const engine = new OrderSyncEngine({ naver_smartstore: adapter }, store, { maxPagesPerCycle: 3 });
    await engine.syncConnection(connection());
    expect(adapter.fetchOrders).toHaveBeenCalledTimes(3);
  });
});

describe("OrderSyncEngine.syncAll", () => {
  it("syncs every connection and returns one summary each", async () => {
    const store = fakeStore();
    const adapter: MarketplaceAdapter = {
      id: "naver_smartstore",
      verifyCredential: vi.fn(),
      fetchOrders: vi.fn(async () => ({ orders: [] })),
    };
    const engine = new OrderSyncEngine({ naver_smartstore: adapter }, store);
    const results = await engine.syncAll([connection({ id: "a" }), connection({ id: "b" })]);
    expect(results.map((r) => r.connectionId)).toEqual(["a", "b"]);
  });
});
