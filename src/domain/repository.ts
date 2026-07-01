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
import { forTenant } from "../tenancy/tenantContext.js";

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
  /** ARK-10: scope to one tenant (Seller.id). Omitted only by the pre-auth
   * global ops dashboard (docs/multi-tenancy.md) — every tenant-facing caller
   * must set this once per-session auth exists. */
  tenantId?: string;
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

  /** Upsert one tenant's orders by `(tenantId, marketplace,
   * marketplaceOrderId)` (ARK-10 — previously unscoped, so two sellers with
   * the same marketplace order id would collide); returns the tenant's new
   * order count. Runs through `forTenant` so Postgres RLS applies alongside
   * this explicit scoping (docs/multi-tenancy.md). */
  async upsertOrders(orders: NormalizedOrder[], tenantId: string): Promise<number> {
    const tenantPrisma = forTenant(this.prisma, tenantId);
    for (const order of orders) {
      const where = {
        tenantId_marketplace_marketplaceOrderId: {
          tenantId,
          marketplace: order.marketplace,
          marketplaceOrderId: order.marketplaceOrderId,
        },
      };
      const scalars = toOrderScalarFields(order, tenantId);
      const items = toOrderItemsCreate(order);
      await tenantPrisma.order.upsert({
        where,
        create: { ...scalars, items: { create: items } },
        // No nested "replace" op in Prisma — clear and recreate items so a
        // re-pulled order's line items never duplicate or go stale.
        update: { ...scalars, items: { deleteMany: {}, create: items } },
      });
    }
    return tenantPrisma.order.count({ where: { tenantId } });
  }

  /** Upsert one tenant's products by `(tenantId, marketplace,
   * marketplaceProductId)` (ARK-10); returns the tenant's new product count. */
  async upsertProducts(products: NormalizedProduct[], tenantId: string): Promise<number> {
    const tenantPrisma = forTenant(this.prisma, tenantId);
    for (const product of products) {
      const input = toProductUpsertInput(product, tenantId);
      await tenantPrisma.product.upsert({
        where: {
          tenantId_marketplace_marketplaceProductId: {
            tenantId,
            marketplace: product.marketplace,
            marketplaceProductId: product.marketplaceProductId,
          },
        },
        create: input,
        update: input,
      });
    }
    return tenantPrisma.product.count({ where: { tenantId } });
  }

  /** The unified order dashboard's read path. Newest orders first.
   *
   * ARK-10: when `filter.tenantId` is set, this runs through `forTenant` and
   * filters explicitly by tenant — the caller's real isolation boundary.
   * When omitted, it runs as a plain global read: today's pre-auth ops
   * dashboard has no per-request tenant to supply. That global path is only
   * safe from a privileged (superuser/BYPASSRLS) DB connection — see
   * docs/multi-tenancy.md — and is expected to go away once per-tenant
   * auth/session lands (tracked separately from this issue). */
  async listOrders(filter: OrderListFilter = {}): Promise<OrderListItem[]> {
    const limit = Math.min(filter.limit ?? 50, 200);
    const args = {
      where: {
        tenantId: filter.tenantId,
        marketplace: filter.marketplace,
        status: filter.status,
      },
      orderBy: { orderedAt: "desc" as const },
      take: limit,
      include: { items: true },
    };
    const orders = filter.tenantId
      ? await forTenant(this.prisma, filter.tenantId).order.findMany(args)
      : await this.prisma.order.findMany(args);
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
