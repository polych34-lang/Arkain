# B2B module: 거래처(Account) + 대량발주(PurchaseOrder) (ARK-16)

**Status:** design + basic implementation. Design rationale (why separate
tables from `Order`) is [ADR-0003](adr/0003-b2b-accounts-purchase-orders.md);
this doc is the implementation summary.

## What this is

A direct wholesale/business ordering flow, separate from the marketplace
order-sync path (`Order`/`OrderItem`, ARK-4/ARK-5): a 거래처(Account) has its
own negotiated unit prices, and a purchase order for that account is entered
and approved internally — no `MarketplaceAdapter` involved.

```
Account (거래처, own price tier: 도매/소비자/이벤트)
   |
   v
AccountPriceListEntry (accountId, sku) -> unitPriceKrw
   |
   v
POST /api/b2b/purchase-orders  --priceLines()-->  PurchaseOrder + PurchaseOrderItem[]
   |
   v  (submit)          (approve)           (reject)
DRAFT --------> SUBMITTED --------> APPROVED --------> FULFILLED
   \-------------------\--------------------> CANCELLED / REJECTED
```

| File | Role |
| --- | --- |
| `prisma/schema.prisma` | `Account`, `AccountPriceListEntry`, `PurchaseOrder`, `PurchaseOrderItem` + `AccountPriceTier`/`PurchaseOrderStatus` enums. See ADR-0003 §3 for the full model and why it's separate from `Order`. |
| `src/domain/b2b/types.ts` | Plain TS types for the module — mirrors the existing `domain/status.ts`/`domain/repository.ts` convention of a typed boundary independent of the Prisma client. |
| `src/domain/b2b/pricing.ts` | `priceLines()` — pure function, resolves each requested `(sku, quantity)` line against the account's price list into priced `PurchaseOrderItem`s + an integer KRW total. Throws `MissingPriceError` rather than guessing a price for an unlisted SKU (ARCHITECTURE.md §6: don't corrupt a number, refuse it). |
| `src/domain/b2b/purchaseOrderStateMachine.ts` | `canTransition`/`assertTransition` — the DRAFT→SUBMITTED→APPROVED/REJECTED→FULFILLED rules (ADR-0003 §4) as a pure lookup table, shared by the repository and reusable by any future API validation. |
| `src/domain/b2b/repository.ts` | `B2BStore` — Prisma-backed CRUD + the approval-transition methods. Tenant-scoped via explicit `where: { tenantId }` (no RLS yet — see ADR-0003 §5). |
| `src/app.ts` | `POST/GET /api/b2b/accounts`, `POST /api/b2b/accounts/:id/prices`, `POST/GET /api/b2b/purchase-orders`, `POST /api/b2b/purchase-orders/:id/{submit,approve,reject}`. All optional on `deps.b2bStore`, same pattern as the existing order routes' `deps.store` — routes report a clear error rather than a crash when unconfigured. |
| `src/main.ts` | Wires `B2BStore` alongside `PrismaDomainStore` when `DATABASE_URL`/`CREDENTIAL_ENC_KEY` are set. |
| `test/b2b.test.ts` | Pure-function tests: price resolution (including the "no default fallback" refusal), the full state-machine transition table (happy path, illegal skip, terminal states, self-transition). No DB required — matches `test/domain.test.ts`'s pattern. |

## Known gaps (tracked, not blocking)

- **No auth/session layer** (same gap ADR-0002 §2d already flagged for the
  rest of the API): every B2B route takes `tenantId` as an explicit request
  field today rather than resolving it from a session.
- **No RLS yet.** Tenant isolation is enforced by the repository's explicit
  `where: { tenantId }` filters. Once ARK-10's `withTenant()` wrapper and RLS
  policy set land, add these four tables to it (additive — every row already
  carries `tenantId`).
- **No unified 매출관리 view across B2B + B2C.** Left to ARK-7 (settlement MVP)
  to decide with real settlement data in front of it (ADR-0003 §5).
