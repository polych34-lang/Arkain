import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  NorthStarInvariantError,
  cashScoreFromCcr,
  computeAgingFifo,
  computeCcrByMonth,
  computeHealthScore,
  computeNorthStar,
  computeQuoteConversion,
  conversionScoreFromRate,
  defaultMonthKey,
  receivablesScoreFromAging,
  type ArLedgerLine,
} from "../src/domain/northStar.js";

describe("computeAgingFifo (ARK-38 §2.5 미수에이징, 4버킷)", () => {
  const asOf = new Date("2026-07-03T00:00:00.000Z");

  function line(overrides: Partial<ArLedgerLine> = {}): ArLedgerLine {
    return {
      side: "DEBIT",
      amountKrw: 100_000,
      partnerId: "partner-1",
      partnerName: "네이버 스마트스토어",
      entryDate: asOf,
      ...overrides,
    };
  }

  it("buckets a single unpaid invoice by its age at asOf", () => {
    const result = computeAgingFifo(
      [line({ entryDate: new Date("2026-06-20T00:00:00.000Z"), amountKrw: 50_000 })],
      asOf,
    );
    // 2026-06-20 -> 2026-07-03 = 13 days -> "0-30" bucket
    expect(result.totalOpenKrw).toBe(50_000);
    expect(result.buckets).toEqual([
      { label: "0-30", amountKrw: 50_000 },
      { label: "31-60", amountKrw: 0 },
      { label: "61-90", amountKrw: 0 },
      { label: "90+", amountKrw: 0 },
    ]);
  });

  it("places invoices older than the last boundary in the 90+ bucket", () => {
    const result = computeAgingFifo(
      [line({ entryDate: new Date("2026-01-01T00:00:00.000Z"), amountKrw: 70_000 })],
      asOf,
    );
    expect(result.buckets.find((b) => b.label === "90+")?.amountKrw).toBe(70_000);
    expect(result.over90DaysShareOfOpen).toBe(1);
  });

  it("consumes credits FIFO against a partner's oldest invoices first", () => {
    const lines: ArLedgerLine[] = [
      line({ entryDate: new Date("2026-01-01T00:00:00.000Z"), amountKrw: 30_000 }), // oldest
      line({ entryDate: new Date("2026-06-25T00:00:00.000Z"), amountKrw: 40_000 }), // newest
      line({ side: "CREDIT", entryDate: new Date("2026-06-30T00:00:00.000Z"), amountKrw: 30_000 }),
    ];
    const result = computeAgingFifo(lines, asOf);

    // The 30_000 credit fully pays off the oldest (2026-01-01) invoice, leaving
    // only the 40_000 newer invoice open.
    expect(result.totalOpenKrw).toBe(40_000);
    expect(result.buckets.find((b) => b.label === "90+")?.amountKrw).toBe(0);
    expect(result.buckets.find((b) => b.label === "0-30")?.amountKrw).toBe(40_000);
  });

  it("groups open receivables by partner (거래처별 미수), sorted largest first", () => {
    const lines: ArLedgerLine[] = [
      line({ partnerId: "p-small", partnerName: "소형거래처", amountKrw: 10_000, entryDate: asOf }),
      line({ partnerId: "p-big", partnerName: "대형거래처", amountKrw: 90_000, entryDate: asOf }),
    ];
    const result = computeAgingFifo(lines, asOf);

    expect(result.byPartner.map((p) => p.partnerId)).toEqual(["p-big", "p-small"]);
    expect(result.byPartner[0]).toMatchObject({ partnerName: "대형거래처", totalOpenKrw: 90_000 });
  });

  it("returns over90DaysShareOfOpen = null (not 0) when there is no open AR", () => {
    const result = computeAgingFifo([], asOf);
    expect(result.totalOpenKrw).toBe(0);
    expect(result.over90DaysShareOfOpen).toBeNull();
  });

  it("respects injected bucket boundaries instead of the hardcoded default", () => {
    const result = computeAgingFifo(
      [line({ entryDate: new Date("2026-06-28T00:00:00.000Z"), amountKrw: 10_000 })], // 5 days old
      asOf,
      [3, 10],
    );
    expect(result.buckets.map((b) => b.label)).toEqual(["0-3", "4-10", "10+"]);
    expect(result.buckets.find((b) => b.label === "4-10")?.amountKrw).toBe(10_000);
  });
});

describe("computeCcrByMonth (ARK-38 §2.5 CCR, v466 월키 포맷 회귀 방지)", () => {
  it("groups revenue and cash by injected month key, avoiding divide-by-zero", () => {
    const result = computeCcrByMonth(
      [{ amountKrw: 100_000, date: new Date("2026-06-15T00:00:00.000Z") }],
      [{ amountKrw: 80_000, date: new Date("2026-06-20T00:00:00.000Z") }],
    );
    expect(result).toEqual([{ monthKey: "2026-06", revenueKrw: 100_000, cashCollectedKrw: 80_000, ccr: 0.8 }]);
  });

  it("returns ccr = null (not 0%) for a month with cash but no recognized revenue", () => {
    const result = computeCcrByMonth([], [{ amountKrw: 50_000, date: new Date("2026-06-01T00:00:00.000Z") }]);
    expect(result).toEqual([{ monthKey: "2026-06", revenueKrw: 0, cashCollectedKrw: 50_000, ccr: null }]);
  });

  it("uses YYYY-MM by default — the v466 fix (reference mixed YY-MM and YYYY-MM)", () => {
    expect(defaultMonthKey(new Date("2026-01-05T00:00:00.000Z"))).toBe("2026-01");
  });

  it("accepts an injected monthKeyFn instead of a hardcoded format", () => {
    const result = computeCcrByMonth(
      [{ amountKrw: 10_000, date: new Date("2026-06-15T00:00:00.000Z") }],
      [],
      (d) => `${String(d.getUTCFullYear()).slice(2)}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
    );
    expect(result[0]?.monthKey).toBe("26-06");
  });
});

describe("computeQuoteConversion (ARK-38 §2.5 견적전환율, v458 회귀 방지)", () => {
  it("computes ACCEPTED / (SENT|ACCEPTED|EXPIRED)", () => {
    expect(computeQuoteConversion(10, 4)).toEqual({ sentCount: 10, acceptedCount: 4, conversionRate: 0.4 });
  });

  it("returns null (not 0%) when nothing has been sent yet", () => {
    expect(computeQuoteConversion(0, 0).conversionRate).toBeNull();
  });

  it("throws instead of silently returning 100% when accepted > sent (the exact v458 shape)", () => {
    expect(() => computeQuoteConversion(5, 6)).toThrow(NorthStarInvariantError);
  });
});

describe("health score sub-scores + weighted average (ARK-38 건강점수 5축)", () => {
  it("cashScoreFromCcr averages the most recent N months' raw ratios, then clamps the result to [0,100]", () => {
    const months = [
      { monthKey: "2026-04", revenueKrw: 100, cashCollectedKrw: 100, ccr: 1.0 },
      { monthKey: "2026-05", revenueKrw: 100, cashCollectedKrw: 150, ccr: 1.5 }, // one month > 100% is fine pre-average
      { monthKey: "2026-06", revenueKrw: 100, cashCollectedKrw: 50, ccr: 0.5 },
    ];
    // avg ccr = (1.0 + 1.5 + 0.5) / 3 = 1.0 -> 100, still within [0,100] so unaffected by clamping.
    expect(cashScoreFromCcr(months, 3)).toBeCloseTo(100, 5);
  });

  it("clamps the averaged score when it exceeds 100", () => {
    const months = [
      { monthKey: "2026-05", revenueKrw: 100, cashCollectedKrw: 200, ccr: 2.0 },
      { monthKey: "2026-06", revenueKrw: 100, cashCollectedKrw: 200, ccr: 2.0 },
    ];
    expect(cashScoreFromCcr(months, 2)).toBe(100);
  });

  it("receivablesScoreFromAging treats no open AR as a perfect score, not null", () => {
    expect(receivablesScoreFromAging(null)).toBe(100);
    expect(receivablesScoreFromAging(0.25)).toBe(75);
  });

  it("conversionScoreFromRate maps the 0-1 rate onto 0-100", () => {
    expect(conversionScoreFromRate(0.4)).toBe(40);
    expect(conversionScoreFromRate(null)).toBeNull();
  });

  it("renormalizes the weighted average over only the non-null axes (현금30/채권20/전환20/마진20/속도10)", () => {
    const full = computeHealthScore({
      cashScore: 100,
      receivablesScore: 100,
      conversionScore: 100,
      marginScore: 100,
      speedScore: 100,
    });
    expect(full.weighted).toBeCloseTo(100, 9);

    // margin/speed unavailable (no cost/fulfillment-timestamp data yet) — must
    // renormalize over the remaining 70% weight, not silently average in a 0.
    const partial = computeHealthScore({
      cashScore: 100,
      receivablesScore: 100,
      conversionScore: 100,
      marginScore: null,
      speedScore: null,
    });
    expect(partial.weighted).toBe(100);
  });

  it("returns weighted = null when every axis is unavailable", () => {
    const result = computeHealthScore({
      cashScore: null,
      receivablesScore: null,
      conversionScore: null,
      marginScore: null,
      speedScore: null,
    });
    expect(result.weighted).toBeNull();
  });
});

/**
 * In-memory fake covering exactly what computeNorthStar's I/O layer issues:
 * journalLine/bankTransaction findMany with nested relation filters, and
 * quote.count. Same pattern as test/accounting.test.ts's fakePrisma — tests
 * the query wiring and forTenant's $extends wrapping actually runs
 * end-to-end (v460 lesson: syntax-checking a new function is not enough).
 */
function fakePrisma() {
  const ledgerAccounts: { id: string; tenantId: string; code: string }[] = [];
  const journalEntries: { id: string; tenantId: string; status: string; entryDate: Date }[] = [];
  const journalLines: {
    id: string;
    journalEntryId: string;
    accountId: string;
    side: "DEBIT" | "CREDIT";
    amountKrw: number;
    partnerId: string | null;
    partnerName: string | null;
  }[] = [];
  const bankTransactions: {
    id: string;
    tenantId: string;
    direction: "DEPOSIT" | "WITHDRAWAL";
    amountKrw: number;
    transactionDate: Date;
  }[] = [];
  const quotes: { id: string; tenantId: string; status: string }[] = [];

  const journalLineDelegate = {
    async findMany({ where }: { where: { account: { code: string }; side?: "CREDIT"; journalEntry: { tenantId: string; status: string } } }) {
      const matchingEntryIds = new Set(
        journalEntries
          .filter((e) => e.tenantId === where.journalEntry.tenantId && e.status === where.journalEntry.status)
          .map((e) => e.id),
      );
      const matchingAccountIds = new Set(
        ledgerAccounts.filter((a) => a.code === where.account.code).map((a) => a.id),
      );
      return journalLines
        .filter(
          (l) =>
            matchingEntryIds.has(l.journalEntryId) &&
            matchingAccountIds.has(l.accountId) &&
            (where.side === undefined || l.side === where.side),
        )
        .map((l) => ({
          side: l.side,
          amountKrw: l.amountKrw,
          partnerId: l.partnerId,
          partnerName: l.partnerName,
          journalEntry: { entryDate: journalEntries.find((e) => e.id === l.journalEntryId)!.entryDate },
        }));
    },
  };

  const bankTransactionDelegate = {
    async findMany({ where }: { where: { tenantId: string; direction: "DEPOSIT" } }) {
      return bankTransactions
        .filter((t) => t.tenantId === where.tenantId && t.direction === where.direction)
        .map((t) => ({ amountKrw: t.amountKrw, transactionDate: t.transactionDate }));
    },
  };

  const quoteDelegate = {
    async count({ where }: { where: { tenantId: string; status: string | { in: string[] } } }) {
      return quotes.filter((q) => {
        if (q.tenantId !== where.tenantId) return false;
        return typeof where.status === "string" ? q.status === where.status : where.status.in.includes(q.status);
      }).length;
    },
  };

  const client = {
    journalLine: journalLineDelegate,
    bankTransaction: bankTransactionDelegate,
    quote: quoteDelegate,
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(client);
    },
    async $executeRaw() {
      return 0;
    },
    $extends(config: { query: { $allOperations: (params: { args: unknown; query: (args: unknown) => unknown }) => unknown } }) {
      const wrap = <T extends Record<string, (...args: never[]) => unknown>>(delegate: T): T => {
        const wrapped: Record<string, unknown> = {};
        for (const key of Object.keys(delegate)) {
          wrapped[key] = (args: unknown) =>
            config.query.$allOperations({
              args,
              query: (a) => (delegate as Record<string, (a: unknown) => unknown>)[key]!(a),
            });
        }
        return wrapped as T;
      };
      return {
        ...client,
        journalLine: wrap(journalLineDelegate),
        bankTransaction: wrap(bankTransactionDelegate),
        quote: wrap(quoteDelegate),
      };
    },
  };

  return { client: client as unknown as PrismaClient, ledgerAccounts, journalEntries, journalLines, bankTransactions, quotes };
}

describe("computeNorthStar (ARK-38 orchestration, end-to-end against a fake Prisma client)", () => {
  it("wires AR/revenue/bank/quote data through the pure engine to a full result", async () => {
    const { client, ledgerAccounts, journalEntries, journalLines, bankTransactions, quotes } = fakePrisma();
    const asOf = new Date("2026-07-03T00:00:00.000Z");

    ledgerAccounts.push(
      { id: "acct-108", tenantId: "tenant-a", code: "108" },
      { id: "acct-404", tenantId: "tenant-a", code: "404" },
    );
    journalEntries.push({
      id: "entry-1",
      tenantId: "tenant-a",
      status: "POSTED",
      entryDate: new Date("2026-06-15T00:00:00.000Z"),
    });
    journalLines.push(
      {
        id: "line-ar",
        journalEntryId: "entry-1",
        accountId: "acct-108",
        side: "DEBIT",
        amountKrw: 38_000,
        partnerId: "partner-1",
        partnerName: "네이버 스마트스토어",
      },
      {
        id: "line-rev",
        journalEntryId: "entry-1",
        accountId: "acct-404",
        side: "CREDIT",
        amountKrw: 34_545,
        partnerId: null,
        partnerName: null,
      },
    );
    bankTransactions.push({
      id: "bank-1",
      tenantId: "tenant-a",
      direction: "DEPOSIT",
      amountKrw: 20_000,
      transactionDate: new Date("2026-06-20T00:00:00.000Z"),
    });
    quotes.push(
      { id: "q-1", tenantId: "tenant-a", status: "ACCEPTED" },
      { id: "q-2", tenantId: "tenant-a", status: "SENT" },
      { id: "q-3", tenantId: "tenant-a", status: "DRAFT" }, // must be excluded from the denominator (v458)
    );

    const result = await computeNorthStar(client, "tenant-a", { asOf });

    expect(result.tenantId).toBe("tenant-a");
    expect(result.aging.totalOpenKrw).toBe(38_000);
    expect(result.ccrByMonth).toEqual([
      { monthKey: "2026-06", revenueKrw: 34_545, cashCollectedKrw: 20_000, ccr: 20_000 / 34_545 },
    ]);
    expect(result.quoteConversion).toEqual({ sentCount: 2, acceptedCount: 1, conversionRate: 0.5 });
    expect(result.healthScore.weighted).not.toBeNull();
    // margin/speed axes have no data source yet — must stay null, not fabricated.
    expect(result.healthScore.marginScore).toBeNull();
    expect(result.healthScore.speedScore).toBeNull();
  });
});
