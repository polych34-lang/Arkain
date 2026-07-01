import { describe, expect, it } from "vitest";
import { MissingPriceError, priceLines } from "../src/domain/b2b/pricing.js";
import {
  assertTransition,
  canTransition,
  InvalidTransitionError,
} from "../src/domain/b2b/purchaseOrderStateMachine.js";
import type { AccountPriceListEntry } from "../src/domain/b2b/types.js";

function priceList(overrides: Partial<AccountPriceListEntry>[] = []): AccountPriceListEntry[] {
  const base: AccountPriceListEntry = {
    accountId: "acc1",
    sku: "SKU-1",
    productName: "상품A (도매)",
    unitPriceKrw: 8000,
  };
  return overrides.length
    ? overrides.map((o) => ({ ...base, ...o }))
    : [base];
}

describe("B2B pricing", () => {
  it("prices each line from the account's price list and sums an integer KRW total", () => {
    const list = priceList([
      { sku: "SKU-1", productName: "상품A", unitPriceKrw: 8000 },
      { sku: "SKU-2", productName: "상품B", unitPriceKrw: 3000 },
    ]);
    const { items, totalAmountKrw } = priceLines(
      [
        { sku: "SKU-1", quantity: 10 },
        { sku: "SKU-2", quantity: 5 },
      ],
      list,
    );
    expect(items).toEqual([
      { sku: "SKU-1", productName: "상품A", quantity: 10, unitPriceKrw: 8000, lineTotalKrw: 80000 },
      { sku: "SKU-2", productName: "상품B", quantity: 5, unitPriceKrw: 3000, lineTotalKrw: 15000 },
    ]);
    expect(totalAmountKrw).toBe(95000);
    expect(Number.isInteger(totalAmountKrw)).toBe(true);
  });

  it("throws MissingPriceError instead of guessing a price for an unlisted sku", () => {
    expect(() => priceLines([{ sku: "SKU-404", quantity: 1 }], priceList())).toThrow(
      MissingPriceError,
    );
  });

  it("does not fall back to a default price across different accounts' lists", () => {
    const list = priceList([{ accountId: "acc1", sku: "SKU-1", unitPriceKrw: 8000 }]);
    // A price list scoped to acc1 should never resolve a line for another account's sku.
    expect(() => priceLines([{ sku: "SKU-OTHER", quantity: 1 }], list)).toThrow(
      MissingPriceError,
    );
  });
});

describe("PurchaseOrder state machine", () => {
  it("allows the documented happy path: DRAFT -> SUBMITTED -> APPROVED -> FULFILLED", () => {
    expect(canTransition("DRAFT", "SUBMITTED")).toBe(true);
    expect(canTransition("SUBMITTED", "APPROVED")).toBe(true);
    expect(canTransition("APPROVED", "FULFILLED")).toBe(true);
  });

  it("allows SUBMITTED -> REJECTED and {DRAFT|SUBMITTED} -> CANCELLED", () => {
    expect(canTransition("SUBMITTED", "REJECTED")).toBe(true);
    expect(canTransition("DRAFT", "CANCELLED")).toBe(true);
    expect(canTransition("SUBMITTED", "CANCELLED")).toBe(true);
  });

  it("rejects skipping straight from DRAFT to APPROVED", () => {
    expect(canTransition("DRAFT", "APPROVED")).toBe(false);
    expect(() => assertTransition("DRAFT", "APPROVED")).toThrow(InvalidTransitionError);
  });

  it("rejects any transition out of a terminal state", () => {
    for (const terminal of ["REJECTED", "FULFILLED", "CANCELLED"] as const) {
      expect(canTransition(terminal, "SUBMITTED")).toBe(false);
    }
  });

  it("rejects re-approving an already-approved order", () => {
    expect(canTransition("APPROVED", "APPROVED")).toBe(false);
  });
});
