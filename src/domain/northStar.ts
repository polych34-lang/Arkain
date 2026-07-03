import type { PrismaClient } from "@prisma/client";
import { forTenant } from "../tenancy/tenantContext.js";
import { LEDGER_CODE } from "./accounting.js";

/**
 * North Star metrics engine (ARK-38, design: ARK-32 feature-audit doc §2.5/§4).
 * Single service producing CCR(현금전환율)·미수에이징(4버킷)·90일+미수비중·
 * 견적전환율·거래처별미수·건강점수 — replacing the reference OMS's pattern of
 * computing these ad hoc per screen (that duplication was itself the v459 bug).
 * See docs/north-star-metrics.md for the formulas and the v458/459/460/466
 * lessons this design encodes.
 */

export class NorthStarInvariantError extends Error {}

// --- Aging ------------------------------------------------------------------

/** 4 buckets from 3 boundaries: 0-30 / 31-60 / 61-90 / 90+ (§2.5's "4버킷"). */
const DEFAULT_AGING_BUCKETS_DAYS = [30, 60, 90] as const;

export interface AgingBucket {
  label: string;
  amountKrw: number;
}

export interface PartnerReceivable {
  partnerId: string;
  partnerName: string;
  totalOpenKrw: number;
  buckets: AgingBucket[];
}

export interface AgingResult {
  totalOpenKrw: number;
  buckets: AgingBucket[];
  byPartner: PartnerReceivable[];
  /** null when there is no open AR at all (not 0 — avoids a fake "0% risk" reading). */
  over90DaysShareOfOpen: number | null;
}

export interface ArLedgerLine {
  side: "DEBIT" | "CREDIT";
  amountKrw: number;
  partnerId: string | null;
  partnerName: string | null;
  entryDate: Date;
}

function agingBucketLabels(boundariesDays: readonly number[]): string[] {
  const labels: string[] = [];
  for (let i = 0; i < boundariesDays.length; i++) {
    const upper = boundariesDays[i]!;
    const lower = i === 0 ? 0 : boundariesDays[i - 1]! + 1;
    labels.push(i === 0 ? `0-${upper}` : `${lower}-${upper}`);
  }
  labels.push(`${boundariesDays[boundariesDays.length - 1]}+`);
  return labels;
}

function bucketLabelForAgeDays(ageDays: number, boundariesDays: readonly number[]): string {
  const labels = agingBucketLabels(boundariesDays);
  for (let i = 0; i < boundariesDays.length; i++) {
    if (ageDays <= boundariesDays[i]!) return labels[i]!;
  }
  return labels[labels.length - 1]!;
}

/**
 * Open (unpaid) AR per partner, FIFO: each partner's DEBIT lines (invoices,
 * oldest first) are consumed by that partner's pooled CREDIT lines
 * (collections) before any remainder is aged. This is a deliberate
 * simplification — there is no per-invoice payment-matching in the schema
 * yet (see docs/north-star-metrics.md "Known gaps"), so a payment cannot be
 * tied to the specific invoice it settles. FIFO (oldest debt paid first) is
 * the standard AR-aging fallback when that link is missing.
 *
 * `asOf` and `boundariesDays` are both injected, not hardcoded (v466 lesson:
 * the reference's CCR bug came from a hardcoded date-key format).
 */
export function computeAgingFifo(
  lines: readonly ArLedgerLine[],
  asOf: Date,
  boundariesDays: readonly number[] = DEFAULT_AGING_BUCKETS_DAYS,
): AgingResult {
  const labels = agingBucketLabels(boundariesDays);
  const byPartnerLines = new Map<string, ArLedgerLine[]>();
  for (const line of lines) {
    const key = line.partnerId ?? "__unassigned__";
    const arr = byPartnerLines.get(key) ?? [];
    arr.push(line);
    byPartnerLines.set(key, arr);
  }

  const tenantBuckets = new Map<string, number>(labels.map((l) => [l, 0]));
  const byPartner: PartnerReceivable[] = [];
  let totalOpenKrw = 0;

  for (const [key, partnerLines] of byPartnerLines) {
    const invoices = partnerLines
      .filter((l) => l.side === "DEBIT")
      .slice()
      .sort((a, b) => a.entryDate.getTime() - b.entryDate.getTime())
      .map((l) => ({ entryDate: l.entryDate, remainingKrw: l.amountKrw }));
    let creditsPool = partnerLines
      .filter((l) => l.side === "CREDIT")
      .reduce((sum, l) => sum + l.amountKrw, 0);

    for (const invoice of invoices) {
      if (creditsPool <= 0) break;
      const consumed = Math.min(invoice.remainingKrw, creditsPool);
      invoice.remainingKrw -= consumed;
      creditsPool -= consumed;
    }

    const partnerBuckets = new Map<string, number>(labels.map((l) => [l, 0]));
    let partnerOpenKrw = 0;
    for (const invoice of invoices) {
      if (invoice.remainingKrw <= 0) continue;
      const ageDays = Math.max(0, Math.floor((asOf.getTime() - invoice.entryDate.getTime()) / 86_400_000));
      const label = bucketLabelForAgeDays(ageDays, boundariesDays);
      partnerBuckets.set(label, (partnerBuckets.get(label) ?? 0) + invoice.remainingKrw);
      tenantBuckets.set(label, (tenantBuckets.get(label) ?? 0) + invoice.remainingKrw);
      partnerOpenKrw += invoice.remainingKrw;
      totalOpenKrw += invoice.remainingKrw;
    }

    if (partnerOpenKrw > 0) {
      const first = partnerLines[0]!;
      byPartner.push({
        partnerId: key,
        partnerName: first.partnerName ?? "미분류",
        totalOpenKrw: partnerOpenKrw,
        buckets: labels.map((label) => ({ label, amountKrw: partnerBuckets.get(label) ?? 0 })),
      });
    }
  }

  const over90Label = labels[labels.length - 1]!;
  const over90DaysShareOfOpen =
    totalOpenKrw === 0 ? null : (tenantBuckets.get(over90Label) ?? 0) / totalOpenKrw;

  return {
    totalOpenKrw,
    buckets: labels.map((label) => ({ label, amountKrw: tenantBuckets.get(label) ?? 0 })),
    byPartner: byPartner.sort((a, b) => b.totalOpenKrw - a.totalOpenKrw),
    over90DaysShareOfOpen,
  };
}

// --- CCR (현금전환율) ---------------------------------------------------------

export interface MonthlyAmountLine {
  amountKrw: number;
  date: Date;
}

export interface CcrMonth {
  monthKey: string;
  revenueKrw: number;
  cashCollectedKrw: number;
  /** null when revenueKrw is 0 for the month (v466: a bad format bug made this read 0% instead of "no data"). */
  ccr: number | null;
}

/** v466 fix: `YYYY-MM`, injected as a function rather than hardcoded so a caller can swap it per-screen without touching this engine. */
export function defaultMonthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * CCR(월) = 그 달 입금된 현금 / 그 달 인식된 매출. `cashCollectedLines` is a
 * proxy (tenant DEPOSIT bank transactions in the month) rather than
 * invoice-matched collections — see docs/north-star-metrics.md "Known gaps":
 * bank-transaction-to-invoice matching isn't wired yet.
 */
export function computeCcrByMonth(
  revenueLines: readonly MonthlyAmountLine[],
  cashCollectedLines: readonly MonthlyAmountLine[],
  monthKeyFn: (d: Date) => string = defaultMonthKey,
): CcrMonth[] {
  const revenueByMonth = new Map<string, number>();
  for (const line of revenueLines) {
    const key = monthKeyFn(line.date);
    revenueByMonth.set(key, (revenueByMonth.get(key) ?? 0) + line.amountKrw);
  }
  const cashByMonth = new Map<string, number>();
  for (const line of cashCollectedLines) {
    const key = monthKeyFn(line.date);
    cashByMonth.set(key, (cashByMonth.get(key) ?? 0) + line.amountKrw);
  }

  const monthKeys = new Set([...revenueByMonth.keys(), ...cashByMonth.keys()]);
  return [...monthKeys].sort().map((monthKey) => {
    const revenueKrw = revenueByMonth.get(monthKey) ?? 0;
    const cashCollectedKrw = cashByMonth.get(monthKey) ?? 0;
    return { monthKey, revenueKrw, cashCollectedKrw, ccr: revenueKrw === 0 ? null : cashCollectedKrw / revenueKrw };
  });
}

// --- 견적전환율 ---------------------------------------------------------------

export interface QuoteConversion {
  sentCount: number;
  acceptedCount: number;
  conversionRate: number | null;
}

/**
 * v458 규칙, enforced at runtime, not just by convention: the denominator
 * (quotes actually sent out — SENT|ACCEPTED|EXPIRED) must never be defined
 * as a subset of the numerator (ACCEPTED). The reference's bug was exactly
 * that inversion (분모⊂분자 → always 100%); this throws instead of silently
 * producing a nonsense rate if a caller ever miscounts.
 */
export function computeQuoteConversion(sentCount: number, acceptedCount: number): QuoteConversion {
  if (acceptedCount > sentCount) {
    throw new NorthStarInvariantError(
      `acceptedCount (${acceptedCount}) exceeds sentCount (${sentCount}) — denominator must be a superset of the numerator (v458 lesson)`,
    );
  }
  return { sentCount, acceptedCount, conversionRate: sentCount === 0 ? null : acceptedCount / sentCount };
}

// --- 건강점수 (5축 가중평균) ---------------------------------------------------

export interface HealthScoreInputs {
  cashScore: number | null;
  receivablesScore: number | null;
  conversionScore: number | null;
  /** Caller-supplied — no cost/원가 field exists on Order/Product yet, see docs/north-star-metrics.md. */
  marginScore: number | null;
  /** Caller-supplied — no fulfillment-stage timestamps exist on Order yet, see docs/north-star-metrics.md. */
  speedScore: number | null;
}

export interface HealthScore extends HealthScoreInputs {
  /** Weighted average renormalized over whichever axes are non-null (never a fake number for a missing axis). */
  weighted: number | null;
}

const HEALTH_SCORE_WEIGHTS: Record<keyof HealthScoreInputs, number> = {
  cashScore: 0.3,
  receivablesScore: 0.2,
  conversionScore: 0.2,
  marginScore: 0.2,
  speedScore: 0.1,
};

function clampScore(x: number): number {
  return Math.max(0, Math.min(100, x));
}

export function computeHealthScore(inputs: HealthScoreInputs): HealthScore {
  let weightedSum = 0;
  let weightTotal = 0;
  for (const key of Object.keys(HEALTH_SCORE_WEIGHTS) as (keyof HealthScoreInputs)[]) {
    const score = inputs[key];
    if (score === null) continue;
    weightedSum += score * HEALTH_SCORE_WEIGHTS[key];
    weightTotal += HEALTH_SCORE_WEIGHTS[key];
  }
  return { ...inputs, weighted: weightTotal === 0 ? null : weightedSum / weightTotal };
}

export function cashScoreFromCcr(ccrByMonth: readonly CcrMonth[], lookbackMonths = 3): number | null {
  const recent = ccrByMonth.slice(-lookbackMonths).filter((m): m is CcrMonth & { ccr: number } => m.ccr !== null);
  if (recent.length === 0) return null;
  const avg = recent.reduce((sum, m) => sum + m.ccr, 0) / recent.length;
  return clampScore(avg * 100);
}

export function receivablesScoreFromAging(over90DaysShareOfOpen: number | null): number | null {
  if (over90DaysShareOfOpen === null) return 100;
  return clampScore((1 - over90DaysShareOfOpen) * 100);
}

export function conversionScoreFromRate(conversionRate: number | null): number | null {
  if (conversionRate === null) return null;
  return clampScore(conversionRate * 100);
}

// --- Orchestration (I/O) -----------------------------------------------------

export interface NorthStarOptions {
  /** "now", injected for testability (v460 lesson: unverified new code crashed the whole app). */
  asOf?: Date;
  monthKeyFn?: (d: Date) => string;
  agingBucketsDays?: readonly number[];
  cashScoreLookbackMonths?: number;
  marginScore?: number | null;
  speedScore?: number | null;
}

export interface NorthStarResult {
  tenantId: string;
  computedAt: Date;
  ccrByMonth: CcrMonth[];
  aging: AgingResult;
  quoteConversion: QuoteConversion;
  healthScore: HealthScore;
}

/**
 * Single entry point (§2.5's `computeNorthStar()`, adopted verbatim as one
 * service instead of the reference's 4 duplicated per-screen calculations —
 * v459 lesson). Read-only: issues one batch of tenant-scoped queries, then
 * hands the raw rows to the pure functions above.
 */
export async function computeNorthStar(
  prisma: PrismaClient,
  tenantId: string,
  options: NorthStarOptions = {},
): Promise<NorthStarResult> {
  const asOf = options.asOf ?? new Date();
  const monthKeyFn = options.monthKeyFn ?? defaultMonthKey;
  const agingBucketsDays = options.agingBucketsDays ?? DEFAULT_AGING_BUCKETS_DAYS;
  const tenantPrisma = forTenant(prisma, tenantId);

  const [arLinesRaw, revenueLinesRaw, cashLinesRaw, sentCount, acceptedCount] = await Promise.all([
    tenantPrisma.journalLine.findMany({
      where: {
        account: { code: LEDGER_CODE.ACCOUNTS_RECEIVABLE },
        journalEntry: { tenantId, status: "POSTED" },
      },
      select: {
        side: true,
        amountKrw: true,
        partnerId: true,
        partnerName: true,
        journalEntry: { select: { entryDate: true } },
      },
    }),
    tenantPrisma.journalLine.findMany({
      where: {
        account: { code: LEDGER_CODE.SALES_REVENUE },
        side: "CREDIT",
        journalEntry: { tenantId, status: "POSTED" },
      },
      select: { amountKrw: true, journalEntry: { select: { entryDate: true } } },
    }),
    tenantPrisma.bankTransaction.findMany({
      where: { tenantId, direction: "DEPOSIT" },
      select: { amountKrw: true, transactionDate: true },
    }),
    tenantPrisma.quote.count({ where: { tenantId, status: { in: ["SENT", "ACCEPTED", "EXPIRED"] } } }),
    tenantPrisma.quote.count({ where: { tenantId, status: "ACCEPTED" } }),
  ]);

  const arLines: ArLedgerLine[] = arLinesRaw.map(
    (l: {
      side: "DEBIT" | "CREDIT";
      amountKrw: number;
      partnerId: string | null;
      partnerName: string | null;
      journalEntry: { entryDate: Date };
    }) => ({
      side: l.side,
      amountKrw: l.amountKrw,
      partnerId: l.partnerId,
      partnerName: l.partnerName,
      entryDate: l.journalEntry.entryDate,
    }),
  );
  const aging = computeAgingFifo(arLines, asOf, agingBucketsDays);

  const revenueLines: MonthlyAmountLine[] = revenueLinesRaw.map(
    (l: { amountKrw: number; journalEntry: { entryDate: Date } }) => ({
      amountKrw: l.amountKrw,
      date: l.journalEntry.entryDate,
    }),
  );
  const cashLines: MonthlyAmountLine[] = cashLinesRaw.map((l: { amountKrw: number; transactionDate: Date }) => ({
    amountKrw: l.amountKrw,
    date: l.transactionDate,
  }));
  const ccrByMonth = computeCcrByMonth(revenueLines, cashLines, monthKeyFn);

  const quoteConversion = computeQuoteConversion(sentCount, acceptedCount);

  const healthScore = computeHealthScore({
    cashScore: cashScoreFromCcr(ccrByMonth, options.cashScoreLookbackMonths ?? 3),
    receivablesScore: receivablesScoreFromAging(aging.over90DaysShareOfOpen),
    conversionScore: conversionScoreFromRate(quoteConversion.conversionRate),
    marginScore: options.marginScore ?? null,
    speedScore: options.speedScore ?? null,
  });

  return { tenantId, computedAt: asOf, ccrByMonth, aging, quoteConversion, healthScore };
}
