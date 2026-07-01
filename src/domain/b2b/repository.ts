import type { PrismaClient } from "@prisma/client";
import { priceLines } from "./pricing.js";
import { assertTransition } from "./purchaseOrderStateMachine.js";
import type {
  Account,
  AccountPriceListEntry,
  CreateAccountInput,
  CreatePurchaseOrderInput,
  PurchaseOrder,
  PurchaseOrderListFilter,
  PurchaseOrderStatus,
} from "./types.js";

/**
 * Prisma-backed B2B store. Tenant scoping is explicit `where: { tenantId }`
 * on every query today (no Postgres RLS yet — see ADR-0003 §5); once ARK-10's
 * `withTenant()` wrapper lands, wrap these calls the same way
 * `PrismaDomainStore` does.
 */
export class B2BStore {
  constructor(private readonly prisma: PrismaClient) {}

  async createAccount(input: CreateAccountInput): Promise<Account> {
    const row = await this.prisma.account.create({
      data: {
        tenantId: input.tenantId,
        name: input.name,
        businessRegistrationNo: input.businessRegistrationNo ?? null,
        priceTier: input.priceTier ?? "WHOLESALE",
        contactName: input.contactName ?? null,
        contactPhone: input.contactPhone ?? null,
        memo: input.memo ?? null,
      },
    });
    return toAccount(row);
  }

  async listAccounts(tenantId: string): Promise<Account[]> {
    const rows = await this.prisma.account.findMany({ where: { tenantId } });
    return rows.map(toAccount);
  }

  /** Upsert one price list entry by (accountId, sku) — same idempotent-upsert
   * convention as Order/Product (ARCHITECTURE.md §6). */
  async upsertPriceListEntry(
    tenantId: string,
    entry: AccountPriceListEntry,
  ): Promise<void> {
    await this.prisma.accountPriceListEntry.upsert({
      where: { accountId_sku: { accountId: entry.accountId, sku: entry.sku } },
      create: { tenantId, ...entry },
      update: {
        productName: entry.productName,
        unitPriceKrw: entry.unitPriceKrw,
      },
    });
  }

  async listPriceListEntries(accountId: string): Promise<AccountPriceListEntry[]> {
    const rows = await this.prisma.accountPriceListEntry.findMany({
      where: { accountId },
    });
    return rows.map((r) => ({
      accountId: r.accountId,
      sku: r.sku,
      productName: r.productName,
      unitPriceKrw: r.unitPriceKrw,
    }));
  }

  /** Create a DRAFT purchase order, pricing each line against the account's
   * price list (throws MissingPriceError — see pricing.ts — if a requested
   * sku has no entry). */
  async createPurchaseOrder(input: CreatePurchaseOrderInput): Promise<PurchaseOrder> {
    const priceList = await this.listPriceListEntries(input.accountId);
    const { items, totalAmountKrw } = priceLines(input.lines, priceList);

    const row = await this.prisma.purchaseOrder.create({
      data: {
        tenantId: input.tenantId,
        accountId: input.accountId,
        status: "DRAFT",
        totalAmountKrw,
        memo: input.memo ?? null,
        items: { create: items },
      },
      include: { items: true },
    });
    return toPurchaseOrder(row);
  }

  async listPurchaseOrders(filter: PurchaseOrderListFilter): Promise<PurchaseOrder[]> {
    const rows = await this.prisma.purchaseOrder.findMany({
      where: {
        tenantId: filter.tenantId,
        accountId: filter.accountId,
        status: filter.status,
      },
      orderBy: { createdAt: "desc" },
      include: { items: true },
    });
    return rows.map(toPurchaseOrder);
  }

  async getPurchaseOrder(
    tenantId: string,
    id: string,
  ): Promise<PurchaseOrder | null> {
    const row = await this.prisma.purchaseOrder.findFirst({
      where: { id, tenantId },
      include: { items: true },
    });
    return row ? toPurchaseOrder(row) : null;
  }

  async submitPurchaseOrder(tenantId: string, id: string): Promise<PurchaseOrder> {
    return this.transition(tenantId, id, "SUBMITTED", { submittedAt: new Date() });
  }

  async approvePurchaseOrder(tenantId: string, id: string): Promise<PurchaseOrder> {
    return this.transition(tenantId, id, "APPROVED", { approvedAt: new Date() });
  }

  async rejectPurchaseOrder(
    tenantId: string,
    id: string,
    reason: string,
  ): Promise<PurchaseOrder> {
    return this.transition(tenantId, id, "REJECTED", {
      rejectedAt: new Date(),
      rejectionReason: reason,
    });
  }

  async fulfillPurchaseOrder(tenantId: string, id: string): Promise<PurchaseOrder> {
    return this.transition(tenantId, id, "FULFILLED", {});
  }

  async cancelPurchaseOrder(tenantId: string, id: string): Promise<PurchaseOrder> {
    return this.transition(tenantId, id, "CANCELLED", {});
  }

  private async transition(
    tenantId: string,
    id: string,
    to: PurchaseOrderStatus,
    extra: Record<string, unknown>,
  ): Promise<PurchaseOrder> {
    const current = await this.prisma.purchaseOrder.findFirst({
      where: { id, tenantId },
    });
    if (!current) throw new Error(`purchase order ${id} not found for tenant`);
    assertTransition(current.status as PurchaseOrderStatus, to);

    const row = await this.prisma.purchaseOrder.update({
      where: { id },
      data: { status: to, ...extra },
      include: { items: true },
    });
    return toPurchaseOrder(row);
  }
}

interface AccountRow {
  id: string;
  tenantId: string;
  name: string;
  businessRegistrationNo: string | null;
  priceTier: string;
  contactName: string | null;
  contactPhone: string | null;
  memo: string | null;
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    businessRegistrationNo: row.businessRegistrationNo,
    priceTier: row.priceTier as Account["priceTier"],
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    memo: row.memo,
  };
}

interface PurchaseOrderRow {
  id: string;
  tenantId: string;
  accountId: string;
  status: string;
  totalAmountKrw: number;
  memo: string | null;
  submittedAt: Date | null;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  items: Array<{
    sku: string;
    productName: string;
    quantity: number;
    unitPriceKrw: number;
    lineTotalKrw: number;
  }>;
}

function toPurchaseOrder(row: PurchaseOrderRow): PurchaseOrder {
  return {
    id: row.id,
    tenantId: row.tenantId,
    accountId: row.accountId,
    status: row.status as PurchaseOrderStatus,
    totalAmountKrw: row.totalAmountKrw,
    memo: row.memo,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    rejectionReason: row.rejectionReason,
    items: row.items.map((i) => ({
      sku: i.sku,
      productName: i.productName,
      quantity: i.quantity,
      unitPriceKrw: i.unitPriceKrw,
      lineTotalKrw: i.lineTotalKrw,
    })),
  };
}
