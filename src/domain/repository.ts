import type { PrismaClient } from "@prisma/client";
import type {
  MarketplaceId,
  NormalizedOrder,
  NormalizedProduct,
} from "../integrations/marketplace.js";
import type { UnifiedOrderStatus } from "./status.js";
import {
  toOrderItemsCreate,
  toOrderScalarFields,
  toProductUpsertInput,
} from "./mappers.js";

/** One row in the unified order dashboard. Money in integer KRW. */
export interface OrderListItem {
  id: string;
  marketplace: MarketplaceId;
  marketplaceOrderId: string;
  status: UnifiedOrderStatus;
  rawStatus: string;
  orderedAt: string; // ISO 8601
  buyerName: string | null;
  totalAmountKrw: number;
  itemCount: number;
}

export interface OrderListFilter {
  marketplace?: MarketplaceId;
  status?: UnifiedOrderStatus;
  /** Default 50, capped at 200 so the dashboard can't accidentally page the whole table. */
  limit?: number;
}

/** An active seller<->marketplace connection, credential still encrypted. */
export interface ActiveConnection {
  id: string;
  sellerId: string;
  marketplace: MarketplaceId;
  ciphertext: string;
  keyVersion: number;
}

export interface SyncRunResult {
  status: "success" | "failed";
  ordersPulled: number;
  cursor?: string;
  error?: string;
}

/**
 * Postgres-backed unified store, replacing the ARK-3 spike's `JsonFileStore`
 * for real persistence. Same idempotent-upsert contract (safe to re-run a
 * sync without double-counting) so the sync engine (ARK-5) can depend on
 * either store. The ARK-3 CLI (`naver-pull.ts`) is left untouched — it is a
 * spike tool, not the sync engine — and keeps writing to `./data/naver`.
 */
export class PrismaDomainStore {
  constructor(private readonly prisma: PrismaClient) {}

  /** Upsert orders by `(marketplace, marketplaceOrderId)`; returns new total count. */
  async upsertOrders(orders: NormalizedOrder[]): Promise<number> {
    for (const order of orders) {
      const where = {
        marketplace_marketplaceOrderId: {
          marketplace: order.marketplace,
          marketplaceOrderId: order.marketplaceOrderId,
        },
      };
      const scalars = toOrderScalarFields(order);
      const items = toOrderItemsCreate(order);
      await this.prisma.order.upsert({
        where,
        create: { ...scalars, items: { create: items } },
        // No nested "replace" op in Prisma — clear and recreate items so a
        // re-pulled order's line items never duplicate or go stale.
        update: { ...scalars, items: { deleteMany: {}, create: items } },
      });
    }
    return this.prisma.order.count();
  }

  /** Upsert products by `(marketplace, marketplaceProductId)`; returns new total count. */
  async upsertProducts(products: NormalizedProduct[]): Promise<number> {
    for (const product of products) {
      const input = toProductUpsertInput(product);
      await this.prisma.product.upsert({
        where: {
          marketplace_marketplaceProductId: {
            marketplace: product.marketplace,
            marketplaceProductId: product.marketplaceProductId,
          },
        },
        create: input,
        update: input,
      });
    }
    return this.prisma.product.count();
  }

  /** The unified order dashboard's read path. Newest orders first. */
  async listOrders(filter: OrderListFilter = {}): Promise<OrderListItem[]> {
    const limit = Math.min(filter.limit ?? 50, 200);
    const orders = await this.prisma.order.findMany({
      where: {
        marketplace: filter.marketplace,
        status: filter.status,
      },
      orderBy: { orderedAt: "desc" },
      take: limit,
      include: { items: true },
    });
    return orders.map((o) => ({
      id: o.id,
      marketplace: o.marketplace as MarketplaceId,
      marketplaceOrderId: o.marketplaceOrderId,
      status: o.status as UnifiedOrderStatus,
      rawStatus: o.rawStatus,
      orderedAt: o.orderedAt.toISOString(),
      buyerName: o.buyerName,
      totalAmountKrw: o.totalAmountKrw,
      itemCount: o.items.length,
    }));
  }

  /** Connections the sync scheduler should poll. Credentials stay encrypted here. */
  async listActiveConnections(): Promise<ActiveConnection[]> {
    const rows = await this.prisma.marketplaceConnection.findMany({
      where: { status: "active" },
    });
    return rows.map((r) => ({
      id: r.id,
      sellerId: r.sellerId,
      marketplace: r.marketplace as MarketplaceId,
      ciphertext: r.ciphertext,
      keyVersion: r.keyVersion,
    }));
  }

  /** The cursor from the connection's last *successful* sync, so a re-scheduled
   * run resumes instead of re-pulling from the default lookback window. */
  async getLastCursor(connectionId: string): Promise<string | undefined> {
    const last = await this.prisma.syncRun.findFirst({
      where: { connectionId, status: "success" },
      orderBy: { startedAt: "desc" },
    });
    return last?.cursor ?? undefined;
  }

  /** Open a `SyncRun` audit row; returns its id for `recordSyncFinish`. */
  async recordSyncStart(connectionId: string): Promise<string> {
    const run = await this.prisma.syncRun.create({
      data: { connectionId, status: "running" },
    });
    return run.id;
  }

  async recordSyncFinish(runId: string, result: SyncRunResult): Promise<void> {
    await this.prisma.syncRun.update({
      where: { id: runId },
      data: {
        finishedAt: new Date(),
        status: result.status,
        ordersPulled: result.ordersPulled,
        cursor: result.cursor,
        error: result.error,
      },
    });
  }
}
