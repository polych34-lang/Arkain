import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { MissingPriceError, priceLines } from "../src/domain/b2b/pricing.js";
import { B2BStore } from "../src/domain/b2b/repository.js";
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

/**
 * ARK-63: `listPriceListEntries` used to run `findMany({ where: { accountId } })`
 * with no `tenantId` filter, so `createPurchaseOrder` (which calls it
 * internally) could resolve another tenant's negotiated prices for a
 * same-shaped `accountId`. This is the same fake-Prisma-delegate approach as
 * test/repository.test.ts's ARK-10 collision test: an in-memory table keyed
 * like Postgres would be, proving the application-level `tenantId` scoping
 * itself (this module has no RLS yet — see ADR-0003 §5 / test/tenant-isolation.test.ts's
 * `KNOWN_GAP_NO_RLS_YET` allowlist).
 */
function fakeB2BPrisma() {
  type PriceEntryRow = AccountPriceListEntry & { tenantId: string };
  const priceEntries: PriceEntryRow[] = [];
  const purchaseOrders: Array<Record<string, unknown>> = [];
  let nextId = 0;

  const client = {
    accountPriceListEntry: {
      async findMany({ where }: { where: { accountId: string; tenantId: string } }) {
        return priceEntries.filter(
          (e) => e.accountId === where.accountId && e.tenantId === where.tenantId,
        );
      },
    },
    purchaseOrder: {
      async create({ data, include }: { data: Record<string, unknown>; include?: unknown }) {
        void include;
        const { items, ...rest } = data as { items?: { create: unknown[] } };
        const row = { id: `po-${++nextId}`, ...rest, items: items?.create ?? [] };
        purchaseOrders.push(row);
        return row;
      },
    },
  };

  return {
    client: client as unknown as PrismaClient,
    seedPriceEntry: (tenantId: string, entry: AccountPriceListEntry) =>
      priceEntries.push({ ...entry, tenantId }),
    purchaseOrders,
  };
}

describe("B2BStore.listPriceListEntries tenant scoping (ARK-63)", () => {
  it("never returns another tenant's price list entries for the same accountId", async () => {
    const { client, seedPriceEntry } = fakeB2BPrisma();
    seedPriceEntry("tenant-a", { accountId: "acc-shared", sku: "SKU-1", productName: "상품A", unitPriceKrw: 8000 });
    seedPriceEntry("tenant-b", { accountId: "acc-shared", sku: "SKU-1", productName: "상품A (victim)", unitPriceKrw: 50000 });
    const store = new B2BStore(client);

    const asAttacker = await store.listPriceListEntries("tenant-a", "acc-shared");
    const asVictim = await store.listPriceListEntries("tenant-b", "acc-shared");

    expect(asAttacker).toEqual([{ accountId: "acc-shared", sku: "SKU-1", productName: "상품A", unitPriceKrw: 8000 }]);
    expect(asVictim).toEqual([{ accountId: "acc-shared", sku: "SKU-1", productName: "상품A (victim)", unitPriceKrw: 50000 }]);
  });

  it("returns an empty list when accountId matches but tenantId does not", async () => {
    const { client, seedPriceEntry } = fakeB2BPrisma();
    seedPriceEntry("tenant-b", { accountId: "acc-victim-only", sku: "SKU-9", productName: "victim only", unitPriceKrw: 12345 });
    const store = new B2BStore(client);

    const asAttacker = await store.listPriceListEntries("tenant-a", "acc-victim-only");

    expect(asAttacker).toEqual([]);
  });

  it("createPurchaseOrder cannot price against another tenant's price list entries via a shared/guessed accountId", async () => {
    const { client, seedPriceEntry } = fakeB2BPrisma();
    // Only the victim tenant has priced this sku for this account.
    seedPriceEntry("tenant-b", { accountId: "acc-victim", sku: "SKU-1", productName: "victim price", unitPriceKrw: 99999 });
    const store = new B2BStore(client);

    await expect(
      store.createPurchaseOrder({
        tenantId: "tenant-a",
        accountId: "acc-victim",
        lines: [{ sku: "SKU-1", quantity: 1 }],
      }),
    ).rejects.toThrow(MissingPriceError);
  });
});
