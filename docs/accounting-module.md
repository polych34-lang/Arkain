# Accounting module: 표준계정과목/전표/매출 자동분개 (ARK-40)

**Status:** schema + core posting logic implemented and unit-tested. Design
rationale (naming-collision resolution, hybrid deployment strategy, why each
table looks the way it does) is
[ARK-39](/ARK/issues/ARK-39#document-accounting-schema); this doc is the
implementation summary + the decisions made while turning that design into
code.

## What this is

A 더존/KcLep-standard double-entry ledger, hung off the existing tenant
(`Seller`) boundary (ARK-10), plus the first auto-posting rule: every
marketplace sale generates a balanced journal entry without a human touching
a debit/credit form.

```
LedgerAccount (표준계정과목, tenant-scoped, 6 core codes locked)
   ^                                  ^
   |                                  |
JournalLine ---(N per entry)--- JournalEntry (sourceType: ORDER_SALE | BANK_TRANSACTION | CC_TRANSACTION | MANUAL)
   |
   v (optional)
AccPartner (거래처/카드사/은행, GENERAL|CARD|BANK)
   ^
   |  optional bridge
Account (ARK-16 B2B 거래처 — separate entity, doesn't reference LedgerAccount)

BankTransaction --matchedOrder--> Order
BankTransaction --journalEntry--> JournalEntry     (BankRule: 적요 -> LedgerAccount, learned)
CcTransaction   --merchantMap--> CcMerchantMap --> LedgerAccount   (source_hash dedup)
```

매출 자동분개 (`src/domain/accounting.ts#postSalesJournalEntry`):

```
차) 108 외상매출금  order.totalAmountKrw     partner = 마켓 정산주체 AccPartner
대) 404 제품매출     round(totalAmountKrw / 1.1)
대) 255 부가세예수금  totalAmountKrw - 공급가   (뺄셈으로 나머지 흡수 — 항상 차변=대변)
```

| File | Role |
| --- | --- |
| `prisma/schema.prisma` | `LedgerAccount`, `AccPartner`, `JournalEntry`, `JournalLine`, `BankTransaction`, `BankRule`, `CcTransaction`, `CcMerchantMap` + 7 enums. `Order.partnerId`/`partnerName` added alongside the existing `Order.customerId` (ARK-35) — different purpose, no field conflict (see "Decisions" below). |
| `prisma/migrations/20260703010000_accounting_module/migration.sql` | DDL generated via `prisma migrate diff` against a live (PGlite-backed) copy of the prior 4 migrations, then hand-appended with the ARK-10 GRANT/RLS block for the 7 tenant-scoped tables (not `JournalLine` — same "reached only via its parent" reasoning as `OrderItem`). |
| `src/domain/accounting.ts` | `CORE_LEDGER_ACCOUNTS` (the 6 locked codes), `seedCoreLedgerAccounts()`, `getOrCreateMarketSettlementPartner()`, `splitSupplyAndVat()`, `assertBalanced()`, `buildSalesJournalLines()` (pure), `postSalesJournalEntry()` (idempotent on `(tenantId, sourceType, sourceId)`). |
| `test/accounting.test.ts` | VAT/supply-split rounding edges, the debit=credit invariant (balanced + intentionally-unbalanced), core-account seeding idempotency + tenant scoping, and `postSalesJournalEntry` idempotency — via an in-memory fake Prisma client, same pattern as `test/repository.test.ts` (ARK-10). No DB required. |

## Decisions made while implementing (ARK-39 §4's 4 open items)

1. **`Order.partnerId`/`customerId` field-add ordering.** Not actually a
   conflict by the time this landed — ARK-34/35 (`customerId`) already merged
   to `master` before this issue started. Added `partnerId`/`partnerName`
   alongside it with no coordination needed.
2. **`Account` (B2B) ↔ `AccPartner` back-relation.** Added
   (`Account.accPartners AccPartner[]`) — additive, no migration risk, as
   ARK-39 predicted.
3. **마켓 정산주체 `AccPartner`: seed vs. lazy-create.** Chose **lazy-create**
   (`getOrCreateMarketSettlementPartner`, idempotent `upsert` on
   `(tenantId, type, name)`). The alternative — seeding at Seller-creation
   time — needs a Seller-creation hook that doesn't exist yet in this
   codebase (no seller-onboarding flow writes `Seller` rows anywhere today;
   `seed-demo-orders.ts` uses `seller.upsert` directly). Lazy-create needs no
   such hook and is exercised by the same code path that seeds the 6 core
   `LedgerAccount`s for the same reason.
4. **Auto-post trigger: Order 확정 vs. Settlement 확정.** **Order 확정**
   (`postSalesJournalEntry` takes an already-confirmed order). ARK-7
   (매출·정산 롤업) is still `blocked` (ARK-22, human Naver credential) — no
   "Settlement confirmed" event exists in code, so that alternative isn't
   actually available yet. **Not done in this issue:** wiring
   `postSalesJournalEntry` into the live order-sync pipeline
   (`PrismaDomainStore.upsertOrders`) — that pipeline currently has no
   previous-status comparison, so it can't tell "just became CONFIRMED" from
   "re-synced, still CONFIRMED". Building that transition-detection is scope
   creep for a schema+logic issue; tracked as a follow-up child issue instead.
   `postSalesJournalEntry` itself is safe to call on every re-sync regardless
   (idempotent on `sourceId`), so the follow-up is pure wiring, not more
   accounting logic.

## Sandbox verification

Same constraint as `docs/multi-tenancy.md`/`docs/domain-model.md`: no
reachable real Postgres in this environment.

- **Migration SQL correctness**: verified by actually running
  `prisma migrate deploy` — all 5 migrations (the 4 pre-existing ones plus
  this one) — against `@electric-sql/pglite` (WASM Postgres) via its
  socket-server wire-protocol bridge, from a cold/empty database. Applied
  cleanly: enums, all 8 tables, composite unique keys
  (`(tenantId, code)`, `(tenantId, type, name)`, `(tenantId, sourceHash)`),
  every FK (including the polymorphic-ish `JournalEntry.sourceId`, which is
  deliberately a plain string, not a FK — Prisma has no polymorphic FK
  support, same call ADR-0002 made elsewhere), `ENABLE/FORCE ROW LEVEL
  SECURITY`, and `CREATE POLICY` all parsed and executed as valid Postgres.
- **RLS enforcement itself** could not be verified here — same PGlite
  single-connection/role limitation `docs/multi-tenancy.md` already documents
  for ARK-10. Must be re-verified against a real Postgres before relying on
  it as a production boundary.
- **Accounting logic** (VAT/supply split, the debit=credit invariant, core
  account + settlement-partner idempotency, journal-entry idempotency) is
  covered by real unit tests against an in-memory fake Prisma client
  (`test/accounting.test.ts`) — this logic doesn't depend on Postgres being
  reachable at all.
- `@electric-sql/pglite`/`@electric-sql/pglite-socket` were installed with
  `--no-save` for this one-off verification and are not a project dependency
  (not in `package.json`/`package-lock.json`).

## Known gaps (tracked, not blocking)

- **No wiring into the live order-confirmation event** — see decision #4
  above. Follow-up child issue tracks this.
- **`매출 자동분개` only.** BankTransaction/BankRule (은행 대사) and
  CcTransaction/CcMerchantMap (법인카드) tables exist per the ARK-39 schema
  but have no posting/matching logic yet — out of this issue's stated scope
  (매출 자동분개 only; the tables are schema-complete so a later issue doesn't
  pay migration debt).
- **No admin UI** to view/edit `LedgerAccount`s, post manual `JournalEntry`s,
  or manage `BankRule`/`CcMerchantMap`. Schema-and-logic-first, same posture
  as every other module in this repo before its issue.
- **`isSystemLocked` guard is app-level only** (`seedCoreLedgerAccounts`'s
  `update: {}` no-op) — there's no admin write path yet for it to actually
  guard against.
- **Homtax 연동, 인사급여 회계** — explicitly out of scope per ARK-39 §5.
