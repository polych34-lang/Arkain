import type { PrismaClient } from "@prisma/client";
import type {
  NormalizedOrder,
  NormalizedProduct,
} from "../integrations/marketplace.js";
import {
  toOrderItemsCreate,
  toOrderScalarFields,
  toProductUpsertInput,
} from "./mappers.js";

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
}
