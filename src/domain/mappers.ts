import type { Prisma } from "@prisma/client";
import type {
  NormalizedOrder,
  NormalizedProduct,
} from "../integrations/marketplace.js";
import { toUnifiedOrderStatus, toUnifiedProductStatus } from "./status.js";

/**
 * Pure functions: adapter-normalized types (already marketplace-agnostic) ->
 * unified-domain Prisma inputs. No I/O, fully unit-testable — mirrors the
 * ARK-3 mapper pattern (naver.mapper.ts: raw -> normalized). This is the
 * second half of the pipeline: normalized -> unified rows.
 */

/** Order scalar fields only (no items) — shared by the create and update
 * branches of `prisma.order.upsert` in domain/repository.ts. */
export function toOrderScalarFields(
  order: NormalizedOrder,
): Omit<Prisma.OrderCreateInput, "items"> {
  return {
    marketplace: order.marketplace,
    marketplaceOrderId: order.marketplaceOrderId,
    status: toUnifiedOrderStatus(order.marketplace, order.status),
    rawStatus: order.status,
    orderedAt: new Date(order.orderedAt),
    buyerName: order.buyerName,
    totalAmountKrw: order.totalAmountKrw,
    raw: order.raw as Prisma.InputJsonValue,
  };
}

/** Line items for nested create. Reused for the upsert's update branch after
 * an idempotent `deleteMany` (Prisma has no nested "replace" op). */
export function toOrderItemsCreate(
  order: NormalizedOrder,
): Prisma.OrderItemCreateWithoutOrderInput[] {
  return order.items.map((item) => ({
    marketplaceProductId: item.marketplaceProductId,
    productName: item.productName,
    quantity: item.quantity,
    unitPriceKrw: item.unitPriceKrw,
  }));
}

/** Order + its line items, keyed for the create branch of `prisma.order.upsert`. */
export function toOrderUpsertInput(
  order: NormalizedOrder,
): Prisma.OrderCreateInput {
  return {
    ...toOrderScalarFields(order),
    items: { create: toOrderItemsCreate(order) },
  };
}

/** Product keyed for `prisma.product.upsert`. */
export function toProductUpsertInput(
  product: NormalizedProduct,
): Prisma.ProductCreateInput {
  return {
    marketplace: product.marketplace,
    marketplaceProductId: product.marketplaceProductId,
    originProductId: product.originProductId,
    name: product.name,
    salePriceKrw: product.salePriceKrw,
    stockQuantity: product.stockQuantity,
    status: toUnifiedProductStatus(product.marketplace, product.status),
    rawStatus: product.status,
    raw: product.raw as Prisma.InputJsonValue,
  };
}
