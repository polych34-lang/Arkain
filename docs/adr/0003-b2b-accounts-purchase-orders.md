# ADR-0003 — B2B module: 거래처(Account) 관리 + 대량발주(PurchaseOrder), separate from the marketplace `Order` model

**Status:** Accepted (design + basic implementation) · **Owner:** Founding Engineer ·
**Date:** 2026-07-01 · **Issue:** ARK-16 · **Board decision source:** 2026-07-01
(플레이오토 EMP/GLOBAL, 사방넷 거래처 발주 자동화 벤치마킹) · **Builds on:** ADR-0002
(`0002-multi-tenancy-b2b-b2c.md`, ARK-13)

---

## 1. Context — this is not the same "B2B" ADR-0002 already designed

ADR-0002 §3 already added a lightweight `dealType` (B2C/B2B) flag to the
existing `Order` model, for one narrow case: a **marketplace-sourced** order
where the buyer happens to be a business (tax invoice requested). That design
still stands and needs no changes.

ARK-16 is a different, larger requirement, matching the 사방넷/플레이오토
benchmarking the board called out:

1. **거래처(Account) entity** with its own per-account unit price / discount
   scheme, independent of a seller's regular consumer sale price — reference
   point: ARKAIN OMS's "모델 할인율 유형별(도매/소비자/이벤트) 분리"
   (discount rate split by type: wholesale / consumer / event).
2. **A direct 대량발주 (bulk purchase order) flow**: a seller's staff enters an
   order **for** a 거래처 directly — draft → submit → approve/reject → fulfill
   — with no marketplace adapter in the loop at all. This has nothing to do
   with `MarketplaceAdapter.fetchOrders` (ARCHITECTURE.md §5); it's an
   internally-authored transaction from day one.

This ADR makes the engineering call ARK-16 asks for explicitly: **does a B2B
purchase order reuse the `Order`/`OrderItem` tables (extending ADR-0002's
`dealType` idea), or does it get its own model?**

## 2. Decision: separate tables — `Account`, `AccountPriceListEntry`,
`PurchaseOrder`, `PurchaseOrderItem` — not a reuse of `Order`/`OrderItem`

### Why not extend `Order`

- **Identity/upsert key mismatch.** `Order`'s idempotent upsert key is
  `(tenantId, marketplace, marketplaceOrderId)` (ADR-0002 §2b) — the entire
  correctness guarantee behind "a re-run sync never double-counts"
  (ARCHITECTURE.md §6) depends on every `Order` row having a real marketplace
  origin. A directly-entered purchase order has neither. Making
  `marketplace`/`marketplaceOrderId` nullable-with-a-sentinel to fit B2B rows
  in would weaken that key for every marketplace-synced row too — the
  correctness-critical path (priority #2 of the mandate) is not the place to
  absorb a differently-shaped concept.
- **Status semantics mismatch.** `OrderStatus` (`PENDING/PAID/DISPATCHED/
  DELIVERED/CONFIRMED/CANCELLED/RETURNED/EXCHANGED/MIXED/UNKNOWN`) models
  **marketplace fulfillment state**, mapped from each marketplace's own status
  strings (`status.ts`). A 대량발주's lifecycle is an **internal approval
  workflow** — `DRAFT → SUBMITTED → APPROVED/REJECTED → FULFILLED` — a
  different state machine with different transition rules (e.g. "only a
  `SUBMITTED` order can be approved"). Bolting approval states onto
  `OrderStatus` would force every place that switches on `OrderStatus`
  (dashboard, sync engine, future settlement mapping) to also handle states
  that can never occur on a marketplace-synced row.
- **No natural home for per-account pricing.** `AccountPriceListEntry` (§3)
  has no equivalent concept on `Order`/`Product` at all — `Product` is a
  marketplace listing (`(marketplace, marketplaceProductId)`), and a
  wholesale-only SKU sold to one 거래처 may never be listed on any marketplace.
  Forcing B2B pricing to hang off `Product` would require every wholesale SKU
  to first exist as a fake marketplace listing — backwards.
- **Blast radius.** The mandate's priority #2 is "a wrong number permanently
  erodes trust," specifically about marketplace order/settlement correctness.
  Sharing tables means a bug in the new, less-tested B2B approval flow can
  corrupt the `Order` table that the live order-sync MVP proof point depends
  on. Separate tables keep that blast radius contained — consistent with how
  `SyncRun` is its own audit trail rather than a status column bolted onto
  `Order` (ARCHITECTURE.md §6).

### Why not a fully separate schema/database

A separate Postgres **schema** or **database** was considered and rejected —
that's the kind of premature infrastructure split the mandate's boundaries
explicitly warn against ("no microservices ... no premature abstractions
before the MVP is real"). Separate **tables in the same database**, same
Prisma client, same tenant boundary (`Seller`) gets the correctness isolation
above without adding an operational seam. This mirrors how ARCHITECTURE.md §5
already treats the `MarketplaceAdapter` contract as the actual isolation
boundary, not a service split.

### What's shared

- **Tenant boundary.** `Account`, `PurchaseOrder` scope to `tenantId` (→
  `Seller.id`), the same tenant concept ADR-0002 defines. Once ARK-10's
  Postgres RLS + `withTenant()` wrapper lands, these tables are added to that
  policy set the same way `Order`/`Product` are — tracked as follow-up (§5),
  not blocking this ADR's basic implementation, which enforces tenant
  scoping at the application/repository layer today (explicit `where:
  { tenantId }` on every query, same interim posture ADR-0002 §2d describes
  for the pre-RLS window).
- **Money convention.** Integer KRW, no floats — same as `Order`/`Product`.
- **Audit convention.** `raw`/traceability isn't needed here (no external
  payload — every field is first-party input), but every state transition is
  timestamped (`submittedAt`/`approvedAt`/`rejectedAt`) so "why is this
  purchase order in this state" is always answerable without a separate log
  table, matching the spirit of `SyncRun`.

## 3. Schema

```prisma
enum AccountPriceTier {
  WHOLESALE // 도매
  CONSUMER  // 소비자
  EVENT     // 이벤트
}

/// 거래처: a direct wholesale/business buyer, distinct from a marketplace
/// consumer. One row per tenant per business relationship.
model Account {
  id                     String                  @id @default(uuid())
  tenant                 Seller                  @relation(fields: [tenantId], references: [id])
  tenantId               String
  name                   String
  businessRegistrationNo String?                 // 사업자등록번호
  priceTier              AccountPriceTier        @default(WHOLESALE)
  contactName            String?
  contactPhone           String?
  memo                   String?
  createdAt              DateTime                @default(now())
  updatedAt              DateTime                @updatedAt
  priceListEntries       AccountPriceListEntry[]
  purchaseOrders         PurchaseOrder[]

  @@index([tenantId])
}

/// One account's negotiated unit price for one SKU. `sku` is a freeform
/// internal product code — deliberately NOT a foreign key to `Product`
/// (marketplace listing), since a wholesale-only SKU need not be listed on
/// any marketplace (see §2).
model AccountPriceListEntry {
  id           String   @id @default(uuid())
  tenant       Seller   @relation(fields: [tenantId], references: [id])
  tenantId     String
  account      Account  @relation(fields: [accountId], references: [id], onDelete: Cascade)
  accountId    String
  sku          String
  productName  String
  unitPriceKrw Int
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@unique([accountId, sku])
}

enum PurchaseOrderStatus {
  DRAFT
  SUBMITTED
  APPROVED
  REJECTED
  FULFILLED
  CANCELLED
}

/// A 거래처 대량발주: entered directly (no MarketplaceAdapter involved),
/// approved internally. Idempotency doesn't apply the way it does to
/// marketplace sync (there's no upstream system to re-poll) — uniqueness
/// here is just the primary key.
model PurchaseOrder {
  id              String              @id @default(uuid())
  tenant          Seller              @relation(fields: [tenantId], references: [id])
  tenantId        String
  account         Account             @relation(fields: [accountId], references: [id])
  accountId       String
  status          PurchaseOrderStatus @default(DRAFT)
  totalAmountKrw  Int
  memo            String?
  submittedAt     DateTime?
  approvedAt      DateTime?
  rejectedAt      DateTime?
  rejectionReason String?
  items           PurchaseOrderItem[]
  createdAt       DateTime            @default(now())
  updatedAt       DateTime            @updatedAt

  @@index([tenantId, status])
}

model PurchaseOrderItem {
  id              String        @id @default(uuid())
  purchaseOrder   PurchaseOrder @relation(fields: [purchaseOrderId], references: [id], onDelete: Cascade)
  purchaseOrderId String
  sku             String
  productName     String
  quantity        Int
  unitPriceKrw    Int
  lineTotalKrw    Int
}
```

`Seller` gains `accounts Account[]` and `purchaseOrders PurchaseOrder[]` back-relations.

## 4. Approval state machine

```
DRAFT --submit--> SUBMITTED --approve--> APPROVED --fulfill--> FULFILLED
  |                   |
  cancel            reject
  |                   |
  v                   v
CANCELLED          REJECTED
```

Only `DRAFT -> SUBMITTED -> {APPROVED|REJECTED}`, `APPROVED -> FULFILLED`, and
`{DRAFT|SUBMITTED} -> CANCELLED` are valid transitions — enforced by a pure
function (`purchaseOrderStateMachine.ts`) so the rule is unit-testable without
a database and reusable from both the repository and (later) any API
validation layer.

## 5. What this ADR does NOT do (deliberately out of scope for ARK-16)

- **No marketplace adapter for wholesale.** The whole point (§1) is that this
  flow has no adapter — nothing to add to `MarketplaceAdapter`.
- **No RLS policies yet.** Tenant scoping is enforced at the application layer
  (explicit `tenantId` filters) today, same interim state ADR-0002 §2d
  describes for `Order` pre-ARK-10. Follow-up: once ARK-10's `withTenant()` /
  RLS policy set lands, add `Account`/`AccountPriceListEntry`/`PurchaseOrder`
  to it — small, additive, no reshaping needed (every table already carries
  `tenantId`).
- **No unified 매출관리 rollup across B2B + B2C.** ARK-7 (settlement MVP) will
  need to decide whether the sales dashboard reads `Order` and `PurchaseOrder`
  through a shared read-side view/union, or shows them as separate tabs
  (mirroring ADR-0002 §3c's B2B/B2C tab pattern for `Order.dealType`). Left
  for ARK-7 to decide with real settlement data in front of it.
- **No pricing approval workflow** (e.g. a discount requiring a second
  sign-off) — `AccountPriceListEntry` is a flat price list an ops user edits
  directly, matching the mandate's "no speculative flexibility."

## 6. One-way vs two-way doors

All of this is additive and reversible: new tables, no changes to `Order`/
`Product`/`Settlement`. The one thing worth flagging is the **state machine
shape** (§4) — once purchase orders exist in the wild, changing valid
transitions is a data-migration question, not just a code change. Low-risk
today (no live sellers yet), but worth CEO awareness if the approval flow
needs a second approval stage later (e.g. amount-based routing) — that's an
additive change to the state machine, not a rewrite.
