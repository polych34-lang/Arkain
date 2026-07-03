import type { PrismaClient } from "@prisma/client";
import type { MarketplaceId } from "../integrations/marketplace.js";
import { forTenant } from "../tenancy/tenantContext.js";

/**
 * Accounting module (ARK-40, design: ARK-39). Standard chart-of-accounts
 * (더존/KcLep 코드) + double-entry journal + the revenue auto-posting logic.
 * See prisma/schema.prisma's "Accounting module" section for the tables this
 * operates on and docs/accounting-module.md for the design writeup.
 */

export class AccountingInvariantError extends Error {}

type LedgerAccountCategory = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";

interface CoreLedgerAccountSeed {
  code: string;
  name: string;
  category: LedgerAccountCategory;
}

/**
 * Hybrid strategy's tenant-common-fixed core (ARK-39 §1/§2.1): every tenant
 * gets exactly these 6, `isSystemLocked: true` — expense sub-accounts are
 * added freely per tenant (`isSystemLocked: false`, no fixed list here, see
 * ARK-39 §2.1 "추측성 설계 방지"). Tax-filing logic must always reference
 * `code`, never `name` (name is tenant-editable even when locked).
 */
export const CORE_LEDGER_ACCOUNTS: readonly CoreLedgerAccountSeed[] = [
  { code: "103", name: "보통예금", category: "ASSET" },
  { code: "108", name: "외상매출금", category: "ASSET" },
  { code: "251", name: "외상매입금", category: "LIABILITY" },
  { code: "253", name: "미지급금", category: "LIABILITY" },
  { code: "255", name: "부가세예수금", category: "LIABILITY" },
  { code: "404", name: "제품매출", category: "REVENUE" },
];

/** Exported so other modules (e.g. src/domain/northStar.ts) reference the same codes, never duplicate the magic strings. */
export const LEDGER_CODE = {
  ACCOUNTS_RECEIVABLE: "108",
  SALES_REVENUE: "404",
  VAT_PAYABLE: "255",
} as const;

/**
 * Idempotent upsert of the 6 core accounts for one tenant. The design (ARK-39
 * §2.1) calls this from "the ARK-10 Seller-creation hook" — no such hook
 * exists yet (no seller-onboarding flow writes `Seller` rows in this
 * codebase today; see the ARK-40 status comment). Calling this lazily,
 * on-demand, from `postSalesJournalEntry` is the pragmatic stand-in until
 * that hook exists — `upsert` on `(tenantId, code)` makes repeat calls safe.
 */
export async function seedCoreLedgerAccounts(
  prisma: PrismaClient,
  tenantId: string,
): Promise<void> {
  const tenantPrisma = forTenant(prisma, tenantId);
  for (const seed of CORE_LEDGER_ACCOUNTS) {
    await tenantPrisma.ledgerAccount.upsert({
      where: { tenantId_code: { tenantId, code: seed.code } },
      create: {
        tenant: { connect: { id: tenantId } },
        code: seed.code,
        name: seed.name,
        category: seed.category,
        isSystemLocked: true,
      },
      // Locked core accounts are server-owned once seeded — a repeat call is
      // a no-op, not a reset of any tenant customization of `name` (app-level
      // guard per ARK-39 §2.1; there is no admin UI to edit these yet either).
      update: {},
    });
  }
}

/**
 * 마켓 정산주체 AccPartner (ARK-39 §2.3/§4-3): B2C 주문의 외상매출금(108) 채무자는 최종
 * 소비자가 아니라 정산을 대행하는 마켓플레이스 자체. §4-3이 "시드 vs lazy 생성" 결정을
 * 후속 구현에 위임했는데, 여기서는 lazy 생성을 택함 — 시드하려면 없는 Seller-생성 훅이
 * 필요하지만(seedCoreLedgerAccounts와 동일 사정) lazy upsert는 그 훅 없이도 바로 동작한다.
 */
const MARKET_SETTLEMENT_PARTNER_NAME: Record<MarketplaceId, string> = {
  naver_smartstore: "네이버 스마트스토어",
  coupang: "쿠팡",
  eleven_st: "11번가",
  esm_2_0: "ESM 2.0",
  gsshop: "GS샵",
};

export async function getOrCreateMarketSettlementPartner(
  prisma: PrismaClient,
  tenantId: string,
  marketplace: MarketplaceId,
): Promise<{ id: string; name: string }> {
  const tenantPrisma = forTenant(prisma, tenantId);
  const name = MARKET_SETTLEMENT_PARTNER_NAME[marketplace];
  const partner = await tenantPrisma.accPartner.upsert({
    where: { tenantId_type_name: { tenantId, type: "GENERAL", name } },
    create: { tenant: { connect: { id: tenantId } }, type: "GENERAL", name },
    update: {},
  });
  return { id: partner.id, name: partner.name };
}

/**
 * 공급가/세액 역산(ARK-39 §2.7): `round(total/1.1)`, 나머지는 세액이 흡수 — 두 값의 합이
 * 항상 total과 정확히 일치해 JournalEntry 불변식(assertBalanced)을 보장한다.
 */
export function splitSupplyAndVat(
  totalAmountKrw: number,
): { supplyAmountKrw: number; vatAmountKrw: number } {
  if (!Number.isInteger(totalAmountKrw) || totalAmountKrw < 0) {
    throw new AccountingInvariantError(
      `totalAmountKrw must be a non-negative integer, got ${totalAmountKrw}`,
    );
  }
  const supplyAmountKrw = Math.round(totalAmountKrw / 1.1);
  const vatAmountKrw = totalAmountKrw - supplyAmountKrw;
  return { supplyAmountKrw, vatAmountKrw };
}

export interface SalesJournalLineInput {
  accountCode: string;
  side: "DEBIT" | "CREDIT";
  amountKrw: number;
  partnerId?: string;
  partnerName?: string;
}

/** 복식부기 핵심 불변식(ARK-39 §2.4): SUM(DEBIT amountKrw) == SUM(CREDIT amountKrw). */
export function assertBalanced(
  lines: readonly { side: "DEBIT" | "CREDIT"; amountKrw: number }[],
): void {
  const debit = lines.filter((l) => l.side === "DEBIT").reduce((sum, l) => sum + l.amountKrw, 0);
  const credit = lines.filter((l) => l.side === "CREDIT").reduce((sum, l) => sum + l.amountKrw, 0);
  if (debit !== credit) {
    throw new AccountingInvariantError(`JournalEntry unbalanced: debit=${debit} credit=${credit}`);
  }
}

/**
 * 매출 자동분개 라인 계산 (ARK-39 §2.7): 차)108=총액 / 대)404=공급가 + 255=세액. 순수 함수 —
 * I/O 없음, `postSalesJournalEntry`에서 실제 저장과 분리해 단위 테스트 가능.
 */
export function buildSalesJournalLines(
  totalAmountKrw: number,
  partner: { id: string; name: string },
): SalesJournalLineInput[] {
  const { supplyAmountKrw, vatAmountKrw } = splitSupplyAndVat(totalAmountKrw);
  const lines: SalesJournalLineInput[] = [
    {
      accountCode: LEDGER_CODE.ACCOUNTS_RECEIVABLE,
      side: "DEBIT",
      amountKrw: totalAmountKrw,
      partnerId: partner.id,
      partnerName: partner.name,
    },
    { accountCode: LEDGER_CODE.SALES_REVENUE, side: "CREDIT", amountKrw: supplyAmountKrw },
    { accountCode: LEDGER_CODE.VAT_PAYABLE, side: "CREDIT", amountKrw: vatAmountKrw },
  ];
  assertBalanced(lines);
  return lines;
}

export interface SalesOrderForJournal {
  id: string;
  tenantId: string;
  marketplace: MarketplaceId;
  totalAmountKrw: number;
  orderedAt: Date;
}

/**
 * 매출 자동분개 (ARK-39 §2.7). **트리거 시점 결정**(이슈 스코프): Order 확정 시점. ARK-7(매출·
 * 정산 롤업)이 여전히 `blocked`(ARK-22, 사람 전용 네이버 크리덴셜 대기)라 "Settlement 확정"
 * 이벤트가 코드상 존재하지 않으므로 §2.7이 제시한 대안 트리거는 아직 선택지가 아니다 — Order
 * 확정이 유일하게 실재하는 시점이라 그대로 채택. 실제 주문 상태-전이 감지를 동기화 파이프라인
 * (upsertOrders)에 연결하는 배선(wiring)은 이 함수 밖의 별도 작업 — upsertOrders는 매 폴링마다
 * 상태를 덮어쓸 뿐 "방금 CONFIRMED로 바뀌었다"를 판별하는 이전-상태 비교 로직이 없어, 그걸
 * 새로 만드는 건 이 스키마+로직 이슈의 범위를 넘는다(후속 이슈로 분리 — ARK-40 코멘트 참고).
 *
 * 이 함수 자체는 언제 호출되든 멱등: 같은 order에 대해 두 번 불러도 `(tenantId, sourceType,
 * sourceId)`로 기존 전표를 찾아 재사용하고 중복 생성하지 않는다.
 */
export async function postSalesJournalEntry(
  prisma: PrismaClient,
  order: SalesOrderForJournal,
): Promise<string> {
  const tenantPrisma = forTenant(prisma, order.tenantId);

  const existing = await tenantPrisma.journalEntry.findFirst({
    where: { tenantId: order.tenantId, sourceType: "ORDER_SALE", sourceId: order.id },
  });
  if (existing) return existing.id;

  await seedCoreLedgerAccounts(prisma, order.tenantId);
  const partner = await getOrCreateMarketSettlementPartner(prisma, order.tenantId, order.marketplace);
  const lines = buildSalesJournalLines(order.totalAmountKrw, partner);

  const accounts = await tenantPrisma.ledgerAccount.findMany({
    where: { tenantId: order.tenantId, code: { in: lines.map((l) => l.accountCode) } },
  });
  const accountIdByCode = new Map(accounts.map((a) => [a.code, a.id]));

  const entry = await tenantPrisma.journalEntry.create({
    data: {
      tenant: { connect: { id: order.tenantId } },
      entryDate: order.orderedAt,
      status: "POSTED",
      sourceType: "ORDER_SALE",
      sourceId: order.id,
      description: `매출 자동분개 — ${order.marketplace} 주문 ${order.id}`,
      lines: {
        create: lines.map((line) => {
          const accountId = accountIdByCode.get(line.accountCode);
          if (!accountId) {
            throw new AccountingInvariantError(
              `LedgerAccount code ${line.accountCode} not seeded for tenant ${order.tenantId}`,
            );
          }
          return {
            account: { connect: { id: accountId } },
            side: line.side,
            amountKrw: line.amountKrw,
            ...(line.partnerId
              ? { partner: { connect: { id: line.partnerId } }, partnerName: line.partnerName }
              : {}),
          };
        }),
      },
    },
  });

  return entry.id;
}
