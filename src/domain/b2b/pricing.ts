import type {
  AccountPriceListEntry,
  PurchaseOrderItem,
  PurchaseOrderLineRequest,
} from "./types.js";

/** No price list entry for one of the requested SKUs — the account has no
 * negotiated price for it yet, so we refuse to guess (correctness over
 * speculative fallback, per ARCHITECTURE.md §6). */
export class MissingPriceError extends Error {
  constructor(public readonly sku: string) {
    super(`no price list entry for sku "${sku}" on this account`);
    this.name = "MissingPriceError";
  }
}

/**
 * Resolve each requested line against the account's price list and compute
 * line/total amounts. Pure — no I/O, no tenant/account lookup — so the
 * pricing rule itself is unit-testable independent of persistence.
 *
 * Throws MissingPriceError rather than falling back to some default price:
 * there is no "regular" price for a wholesale-only SKU to fall back to (see
 * ADR-0003 §2) — an account without a price list entry needs one entered
 * first, not a silently wrong number on an order.
 */
export function priceLines(
  lines: PurchaseOrderLineRequest[],
  priceList: AccountPriceListEntry[],
): { items: PurchaseOrderItem[]; totalAmountKrw: number } {
  const bySku = new Map(priceList.map((entry) => [entry.sku, entry]));

  const items: PurchaseOrderItem[] = lines.map((line) => {
    const entry = bySku.get(line.sku);
    if (!entry) throw new MissingPriceError(line.sku);
    return {
      sku: line.sku,
      productName: entry.productName,
      quantity: line.quantity,
      unitPriceKrw: entry.unitPriceKrw,
      lineTotalKrw: entry.unitPriceKrw * line.quantity,
    };
  });

  const totalAmountKrw = items.reduce((sum, item) => sum + item.lineTotalKrw, 0);
  return { items, totalAmountKrw };
}
