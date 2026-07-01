import type { PurchaseOrderStatus } from "./types.js";

/**
 * DRAFT -> SUBMITTED -> {APPROVED|REJECTED}; APPROVED -> FULFILLED;
 * {DRAFT|SUBMITTED} -> CANCELLED. See ADR-0003 §4. Kept as a pure lookup so
 * the repository and any future API validation share one source of truth for
 * "is this transition legal."
 */
const ALLOWED_TRANSITIONS: Record<PurchaseOrderStatus, PurchaseOrderStatus[]> = {
  DRAFT: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["FULFILLED"],
  REJECTED: [],
  FULFILLED: [],
  CANCELLED: [],
};

export function canTransition(
  from: PurchaseOrderStatus,
  to: PurchaseOrderStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(from: PurchaseOrderStatus, to: PurchaseOrderStatus) {
    super(`cannot transition purchase order from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
  }
}

/** Throws InvalidTransitionError if the move isn't legal; otherwise a no-op
 * check the caller uses before writing the new status. */
export function assertTransition(
  from: PurchaseOrderStatus,
  to: PurchaseOrderStatus,
): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
