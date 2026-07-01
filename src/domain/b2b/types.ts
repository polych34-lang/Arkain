/**
 * B2B module types (ARK-16). See docs/adr/0003-b2b-accounts-purchase-orders.md
 * for why these are separate from Order/OrderItem rather than an extension.
 */

export type AccountPriceTier = "WHOLESALE" | "CONSUMER" | "EVENT";

export type PurchaseOrderStatus =
  | "DRAFT"
  | "SUBMITTED"
  | "APPROVED"
  | "REJECTED"
  | "FULFILLED"
  | "CANCELLED";

export interface Account {
  id: string;
  tenantId: string;
  name: string;
  businessRegistrationNo: string | null;
  priceTier: AccountPriceTier;
  contactName: string | null;
  contactPhone: string | null;
  memo: string | null;
}

export interface CreateAccountInput {
  tenantId: string;
  name: string;
  businessRegistrationNo?: string | null;
  priceTier?: AccountPriceTier;
  contactName?: string | null;
  contactPhone?: string | null;
  memo?: string | null;
}

export interface AccountPriceListEntry {
  accountId: string;
  sku: string;
  productName: string;
  unitPriceKrw: number;
}

/** One requested line on a draft purchase order, before pricing is resolved. */
export interface PurchaseOrderLineRequest {
  sku: string;
  quantity: number;
}

/** A priced line item, ready to persist. Integer KRW throughout — no floats. */
export interface PurchaseOrderItem {
  sku: string;
  productName: string;
  quantity: number;
  unitPriceKrw: number;
  lineTotalKrw: number;
}

export interface PurchaseOrder {
  id: string;
  tenantId: string;
  accountId: string;
  status: PurchaseOrderStatus;
  totalAmountKrw: number;
  memo: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  items: PurchaseOrderItem[];
}

export interface CreatePurchaseOrderInput {
  tenantId: string;
  accountId: string;
  lines: PurchaseOrderLineRequest[];
  memo?: string | null;
}

export interface PurchaseOrderListFilter {
  tenantId: string;
  accountId?: string;
  status?: PurchaseOrderStatus;
}
