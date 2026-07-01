import { describe, expect, it } from "vitest";
import type {
  NormalizedOrder,
  NormalizedProduct,
} from "../src/integrations/marketplace.js";
import {
  toOrderItemsCreate,
  toOrderScalarFields,
  toOrderUpsertInput,
  toProductUpsertInput,
} from "../src/domain/mappers.js";
import {
  toUnifiedOrderStatus,
  toUnifiedProductStatus,
} from "../src/domain/status.js";

function order(overrides: Partial<NormalizedOrder> = {}): NormalizedOrder {
  return {
    marketplace: "naver_smartstore",
    marketplaceOrderId: "o1",
    orderedAt: "2026-06-20T01:00:00.000Z",
    status: "PAYED",
    buyerName: "홍길동",
    totalAmountKrw: 4000,
    items: [
      {
        marketplaceProductId: "p1",
        productName: "상품A",
        quantity: 2,
        unitPriceKrw: 2000,
      },
    ],
    raw: { source: "test" },
    ...overrides,
  };
}

function product(overrides: Partial<NormalizedProduct> = {}): NormalizedProduct {
  return {
    marketplace: "naver_smartstore",
    marketplaceProductId: "p1",
    originProductId: "op1",
    name: "상품A",
    salePriceKrw: 2000,
    stockQuantity: 5,
    status: "SALE",
    raw: { source: "test" },
    ...overrides,
  };
}

describe("status mapping", () => {
  it("maps known Naver order statuses, including the synthetic MIXED", () => {
    expect(toUnifiedOrderStatus("naver_smartstore", "PAYED")).toBe("PAID");
    expect(toUnifiedOrderStatus("naver_smartstore", "DELIVERED")).toBe(
      "DELIVERED",
    );
    expect(toUnifiedOrderStatus("naver_smartstore", "MIXED")).toBe("MIXED");
  });

  it("falls back to UNKNOWN for unmapped statuses and unconfigured marketplaces", () => {
    expect(toUnifiedOrderStatus("naver_smartstore", "SOME_NEW_STATUS")).toBe(
      "UNKNOWN",
    );
    expect(toUnifiedOrderStatus("coupang", "ANYTHING")).toBe("UNKNOWN");
    expect(toUnifiedProductStatus("coupang", "ANYTHING")).toBe("UNKNOWN");
  });

  it("maps known Naver product statuses", () => {
    expect(toUnifiedProductStatus("naver_smartstore", "SALE")).toBe("ON_SALE");
    expect(toUnifiedProductStatus("naver_smartstore", "OUTOFSTOCK")).toBe(
      "OUT_OF_STOCK",
    );
    expect(toUnifiedProductStatus("naver_smartstore", "REJECTION")).toBe(
      "SUSPENDED",
    );
  });
});

describe("order mapping", () => {
  it("maps scalar fields, preserving rawStatus and integer KRW money", () => {
    const fields = toOrderScalarFields(order());
    expect(fields.status).toBe("PAID");
    expect(fields.rawStatus).toBe("PAYED");
    expect(fields.totalAmountKrw).toBe(4000);
    expect(Number.isInteger(fields.totalAmountKrw)).toBe(true);
    expect(fields.orderedAt).toEqual(new Date("2026-06-20T01:00:00.000Z"));
  });

  it("maps every line item for nested create", () => {
    const items = toOrderItemsCreate(
      order({
        items: [
          { marketplaceProductId: "p1", productName: "A", quantity: 1, unitPriceKrw: 1000 },
          { marketplaceProductId: "p2", productName: "B", quantity: 3, unitPriceKrw: 500 },
        ],
      }),
    );
    expect(items).toHaveLength(2);
    expect(items[1]).toEqual({
      marketplaceProductId: "p2",
      productName: "B",
      quantity: 3,
      unitPriceKrw: 500,
    });
  });

  it("nests items under create for the upsert-create input", () => {
    const input = toOrderUpsertInput(order());
    expect(input.items).toEqual({
      create: [
        {
          marketplaceProductId: "p1",
          productName: "상품A",
          quantity: 2,
          unitPriceKrw: 2000,
        },
      ],
    });
  });

  it("maps an UNKNOWN-status order to UNKNOWN without dropping the raw value", () => {
    const fields = toOrderScalarFields(order({ status: "SOME_NEW_STATUS" }));
    expect(fields.status).toBe("UNKNOWN");
    expect(fields.rawStatus).toBe("SOME_NEW_STATUS");
  });
});

describe("product mapping", () => {
  it("maps a product, mapping status and preserving raw", () => {
    const input = toProductUpsertInput(product());
    expect(input.status).toBe("ON_SALE");
    expect(input.rawStatus).toBe("SALE");
    expect(input.salePriceKrw).toBe(2000);
    expect(input.raw).toEqual({ source: "test" });
  });

  it("passes through a null originProductId", () => {
    const input = toProductUpsertInput(product({ originProductId: null }));
    expect(input.originProductId).toBeNull();
  });
});
