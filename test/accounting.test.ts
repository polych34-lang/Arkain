import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  AccountingInvariantError,
  CORE_LEDGER_ACCOUNTS,
  assertBalanced,
  buildSalesJournalLines,
  postSalesJournalEntry,
  seedCoreLedgerAccounts,
  splitSupplyAndVat,
} from "../src/domain/accounting.js";

/**
 * Fake Prisma client covering just the `ledgerAccount`/`accPartner`/
 * `journalEntry` operations `src/domain/accounting.ts` issues — same pattern
 * as `test/repository.test.ts`'s `fakePrisma` (ARK-10): an in-memory table
 * keyed the same way Postgres is, wrapped through `$extends` the same way
 * `forTenant` wraps the real client, so this tests the application-level
 * idempotency/tenant-scoping logic, not real Postgres/RLS.
 */
function fakePrisma() {
  type Row = Record<string, unknown>;
  const ledgerAccounts: Row[] = [];
  const accPartners: Row[] = [];
  const journalEntries: Row[] = [];
  const journalLines: Row[] = [];
  let nextId = 0;

  function flattenConnect(input: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value && typeof value === "object" && "connect" in (value as Record<string, unknown>)) {
        out[`${key}Id`] = (value as { connect: { id: string } }).connect.id;
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  const ledgerAccountDelegate = {
    async upsert({ where, create, update }: { where: { tenantId_code: { tenantId: string; code: string } }; create: Record<string, unknown>; update: Record<string, unknown> }) {
      const idx = ledgerAccounts.findIndex(
        (a) => a.tenantId === where.tenantId_code.tenantId && a.code === where.tenantId_code.code,
      );
      if (idx === -1) {
        const row = { id: `ledger-${++nextId}`, ...flattenConnect(create) };
        ledgerAccounts.push(row);
        return row;
      }
      ledgerAccounts[idx] = { ...ledgerAccounts[idx], ...flattenConnect(update) };
      return ledgerAccounts[idx]!;
    },
    async findMany({ where }: { where?: { tenantId?: string; code?: { in: string[] } } } = {}) {
      return ledgerAccounts.filter((a) => {
        if (where?.tenantId !== undefined && a.tenantId !== where.tenantId) return false;
        if (where?.code !== undefined && !where.code.in.includes(a.code as string)) return false;
        return true;
      });
    },
  };

  const accPartnerDelegate = {
    async upsert({ where, create, update }: { where: { tenantId_type_name: { tenantId: string; type: string; name: string } }; create: Record<string, unknown>; update: Record<string, unknown> }) {
      const key = where.tenantId_type_name;
      const idx = accPartners.findIndex(
        (p) => p.tenantId === key.tenantId && p.type === key.type && p.name === key.name,
      );
      if (idx === -1) {
        const row = { id: `partner-${++nextId}`, ...flattenConnect(create) };
        accPartners.push(row);
        return row;
      }
      accPartners[idx] = { ...accPartners[idx], ...flattenConnect(update) };
      return accPartners[idx]!;
    },
  };

  const journalEntryDelegate = {
    async findFirst({ where }: { where: { tenantId: string; sourceType: string; sourceId?: string } }) {
      return (
        journalEntries.find(
          (e) =>
            e.tenantId === where.tenantId &&
            e.sourceType === where.sourceType &&
            e.sourceId === where.sourceId,
        ) ?? null
      );
    },
    async create({ data }: { data: Record<string, unknown> }) {
      const { lines, ...scalars } = data as { lines?: { create: Record<string, unknown>[] }; [key: string]: unknown };
      const entry = { id: `entry-${++nextId}`, ...flattenConnect(scalars) };
      journalEntries.push(entry);
      for (const line of lines?.create ?? []) {
        journalLines.push({ id: `line-${++nextId}`, journalEntryId: entry.id, ...flattenConnect(line) });
      }
      return entry;
    },
  };

  function wrapAllOperations<T extends Record<string, (...args: never[]) => unknown>>(
    delegate: T,
    allOperations: (params: { args: unknown; query: (args: unknown) => unknown }) => unknown,
  ): T {
    const wrapped: Record<string, unknown> = {};
    for (const key of Object.keys(delegate)) {
      wrapped[key] = (args: unknown) =>
        allOperations({ args, query: (a) => (delegate as Record<string, (a: unknown) => unknown>)[key]!(a) });
    }
    return wrapped as T;
  }

  const client = {
    ledgerAccount: ledgerAccountDelegate,
    accPartner: accPartnerDelegate,
    journalEntry: journalEntryDelegate,
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(client);
    },
    async $executeRaw() {
      return 0;
    },
    $extends(config: { query: { $allOperations: (params: { args: unknown; query: (args: unknown) => unknown }) => unknown } }) {
      return {
        ...client,
        ledgerAccount: wrapAllOperations(ledgerAccountDelegate, config.query.$allOperations),
        accPartner: wrapAllOperations(accPartnerDelegate, config.query.$allOperations),
        journalEntry: wrapAllOperations(journalEntryDelegate, config.query.$allOperations),
      };
    },
  };

  return { client: client as unknown as PrismaClient, ledgerAccounts, accPartners, journalEntries, journalLines };
}

describe("splitSupplyAndVat (ARK-39 §2.7)", () => {
  it("splits a VAT-inclusive total so the two halves always sum back to the total", () => {
    for (const total of [0, 1, 10, 1000, 12_900, 38_000, 52_500, 99_999, 1_000_001]) {
      const { supplyAmountKrw, vatAmountKrw } = splitSupplyAndVat(total);
      expect(supplyAmountKrw + vatAmountKrw).toBe(total);
    }
  });

  it("uses round(total/1.1) for the supply amount, absorbing the remainder into VAT", () => {
    expect(splitSupplyAndVat(38_000)).toEqual({ supplyAmountKrw: 34_545, vatAmountKrw: 3_455 });
    expect(splitSupplyAndVat(11)).toEqual({ supplyAmountKrw: 10, vatAmountKrw: 1 });
  });

  it("rejects non-integer or negative totals (no floats, no impossible money — ARCHITECTURE.md §6)", () => {
    expect(() => splitSupplyAndVat(100.5)).toThrow(AccountingInvariantError);
    expect(() => splitSupplyAndVat(-1)).toThrow(AccountingInvariantError);
  });
});

describe("assertBalanced (ARK-39 §2.4 invariant)", () => {
  it("accepts a balanced set of lines", () => {
    expect(() =>
      assertBalanced([
        { side: "DEBIT", amountKrw: 1000 },
        { side: "CREDIT", amountKrw: 600 },
        { side: "CREDIT", amountKrw: 400 },
      ]),
    ).not.toThrow();
  });

  it("rejects an unbalanced set of lines", () => {
    expect(() =>
      assertBalanced([
        { side: "DEBIT", amountKrw: 1000 },
        { side: "CREDIT", amountKrw: 999 },
      ]),
    ).toThrow(AccountingInvariantError);
  });
});

describe("buildSalesJournalLines (ARK-39 §2.7)", () => {
  it("produces 차)108=총액 / 대)404=공급가 + 255=세액, always balanced", () => {
    const partner = { id: "partner-1", name: "네이버 스마트스토어" };
    const lines = buildSalesJournalLines(38_000, partner);

    expect(lines).toEqual([
      { accountCode: "108", side: "DEBIT", amountKrw: 38_000, partnerId: "partner-1", partnerName: "네이버 스마트스토어" },
      { accountCode: "404", side: "CREDIT", amountKrw: 34_545 },
      { accountCode: "255", side: "CREDIT", amountKrw: 3_455 },
    ]);
    expect(() => assertBalanced(lines)).not.toThrow();
  });

  it("stays balanced across a range of totals, including odd/rounding-edge amounts", () => {
    const partner = { id: "p", name: "쿠팡" };
    for (const total of [1, 999, 12_901, 100_000, 333_333]) {
      const lines = buildSalesJournalLines(total, partner);
      expect(() => assertBalanced(lines)).not.toThrow();
    }
  });
});

describe("seedCoreLedgerAccounts (ARK-39 §2.1 hybrid strategy)", () => {
  it("seeds exactly the 6 core accounts, system-locked, matching the standard codes", async () => {
    const { client, ledgerAccounts } = fakePrisma();

    await seedCoreLedgerAccounts(client, "tenant-a");

    expect(ledgerAccounts).toHaveLength(CORE_LEDGER_ACCOUNTS.length);
    expect(ledgerAccounts.every((a) => a.isSystemLocked === true)).toBe(true);
    expect(new Set(ledgerAccounts.map((a) => a.code))).toEqual(
      new Set(CORE_LEDGER_ACCOUNTS.map((a) => a.code)),
    );
  });

  it("is idempotent — calling it twice for the same tenant never duplicates rows", async () => {
    const { client, ledgerAccounts } = fakePrisma();

    await seedCoreLedgerAccounts(client, "tenant-a");
    await seedCoreLedgerAccounts(client, "tenant-a");

    expect(ledgerAccounts).toHaveLength(CORE_LEDGER_ACCOUNTS.length);
  });

  it("scopes accounts per tenant — two tenants each get their own 6", async () => {
    const { client, ledgerAccounts } = fakePrisma();

    await seedCoreLedgerAccounts(client, "tenant-a");
    await seedCoreLedgerAccounts(client, "tenant-b");

    expect(ledgerAccounts).toHaveLength(CORE_LEDGER_ACCOUNTS.length * 2);
    expect(ledgerAccounts.filter((a) => a.tenantId === "tenant-a")).toHaveLength(CORE_LEDGER_ACCOUNTS.length);
    expect(ledgerAccounts.filter((a) => a.tenantId === "tenant-b")).toHaveLength(CORE_LEDGER_ACCOUNTS.length);
  });
});

describe("postSalesJournalEntry (ARK-40 trigger: Order 확정 시점)", () => {
  function order(overrides: Partial<Parameters<typeof postSalesJournalEntry>[1]> = {}) {
    return {
      id: "order-1",
      tenantId: "tenant-a",
      marketplace: "naver_smartstore" as const,
      totalAmountKrw: 38_000,
      orderedAt: new Date("2026-06-30T00:12:00.000Z"),
      ...overrides,
    };
  }

  it("posts a balanced JournalEntry with the 마켓 정산주체 AccPartner as the 108 debtor", async () => {
    const { client, journalEntries, journalLines, accPartners } = fakePrisma();

    const entryId = await postSalesJournalEntry(client, order());

    expect(journalEntries).toHaveLength(1);
    expect(journalEntries[0]?.id).toBe(entryId);
    expect(journalEntries[0]?.sourceType).toBe("ORDER_SALE");
    expect(journalEntries[0]?.sourceId).toBe("order-1");

    expect(journalLines).toHaveLength(3);
    const debit = journalLines.filter((l) => l.side === "DEBIT").reduce((s, l) => s + (l.amountKrw as number), 0);
    const credit = journalLines.filter((l) => l.side === "CREDIT").reduce((s, l) => s + (l.amountKrw as number), 0);
    expect(debit).toBe(credit);
    expect(debit).toBe(38_000);

    expect(accPartners).toHaveLength(1);
    expect(accPartners[0]?.name).toBe("네이버 스마트스토어");
  });

  it("is idempotent — posting the same order twice reuses the existing entry instead of duplicating it", async () => {
    const { client, journalEntries } = fakePrisma();

    const first = await postSalesJournalEntry(client, order());
    const second = await postSalesJournalEntry(client, order());

    expect(second).toBe(first);
    expect(journalEntries).toHaveLength(1);
  });

  it("reuses one lazily-created settlement AccPartner across multiple orders from the same marketplace", async () => {
    const { client, accPartners } = fakePrisma();

    await postSalesJournalEntry(client, order({ id: "order-1" }));
    await postSalesJournalEntry(client, order({ id: "order-2" }));

    expect(accPartners).toHaveLength(1);
  });
});
