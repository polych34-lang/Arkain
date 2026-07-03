# Unified domain model (ARK-4)

**Status:** schema + Naver mapping implemented and unit-tested. Not yet
exercised against a live database (no `DATABASE_URL` provisioned in this
environment) or live Naver data (ARK-3's credential blocker) — both are
mechanical next steps, not open design questions.

**ARK-10 update:** `Order`, `Product`, `Settlement` now carry a required
`tenantId` (Postgres RLS + application-level scoping) — see
`docs/multi-tenancy.md`. The idempotent keys below are unchanged in shape
but now scoped per tenant first.

**ARK-35 update:** `Customer` is a new entity — see "Customer identity
(ARK-35)" below. `Order` gained a nullable `customerId` FK to it.

## What this is

The second half of the pipeline that starts with the ARK-3 adapter:

```
marketplace raw JSON --(adapter mapper, e.g. naver.mapper.ts)--> Normalized*
                                                                      |
                                                                      v
Normalized* --(src/domain/mappers.ts, this issue)--> unified Prisma rows
```

Adapters and the domain model never talk directly — they meet at the
`Normalized*` types in `src/integrations/marketplace.ts`. Adding 쿠팡 means one
new adapter + one new status-mapping table (`src/domain/status.ts`); nothing
here changes.

| File | Role |
| --- | --- |
| `prisma/schema.prisma` | `Order`, `OrderItem`, `Product`, `Settlement` models + `OrderStatus`/`ProductStatus` enums |
| `src/domain/status.ts` | Marketplace raw status string -> unified status, one lookup table per marketplace |
| `src/domain/mappers.ts` | Pure functions: `Normalized*` -> Prisma create/upsert input |
| `src/domain/repository.ts` | `PrismaDomainStore` — idempotent `upsertOrders`/`upsertProducts`, same shape as the ARK-3 `JsonFileStore` |
| `test/domain.test.ts` | Unit tests for status mapping + mappers (no DB required) |

## Entities

- **Order** — one row per marketplace order (Naver `orderId`), not per line
  item. Idempotent key: `(marketplace, marketplaceOrderId)`, matching the
  ARK-3 spike's JSON-store key so a second sync of the same order never
  double-counts.
- **OrderItem** — one row per line item (Naver `productOrderId`), owned by an
  Order, replaced wholesale (`deleteMany` + `create`) on re-sync since Prisma
  has no nested "replace" op.
- **Product** — one row per channel listing. Idempotent key: `(marketplace,
  marketplaceProductId)`.
- **Settlement** — **foundation slice only.** No marketplace adapter produces
  settlement/payout data yet (that lands with ARK-7), so this table has the
  correctness conventions (integer KRW, raw JSON preserved) but no mapper. It
  exists now so ARK-7 has no schema migration debt to pay down.

## Status mapping — provisional, flagged for live verification

`src/domain/status.ts` maps Naver's raw status strings to a unified
`OrderStatus`/`ProductStatus`. The Naver status values (`PAYED`, `DELIVERING`,
`PURCHASE_DECIDED`, `SALE`, `OUTOFSTOCK`, etc.) are per the Naver Commerce API
docs, but **have not been checked against a live response** — that requires
the credentials blocked on ARK-3. Every row keeps `rawStatus` verbatim
alongside the mapped `status`, so if a bucket turns out wrong once live data
arrives, it is a data-fix (re-derive `status` from stored `rawStatus`), not a
re-pull. An unmapped raw status maps to `UNKNOWN` rather than throwing, so an
unexpected value degrades gracefully instead of breaking a sync.

`MIXED` (`OrderStatus`) is not a Naver value — it is synthesized by the ARK-3
mapper (`naver.mapper.ts`) when an order's line items have diverged statuses,
and is preserved unchanged into the unified status.

## Correctness conventions applied (ARCHITECTURE.md §6)

- Money is integer KRW everywhere (`totalAmountKrw`, `unitPriceKrw`,
  `salePriceKrw`) — no floats.
- Idempotent upserts on the same keys as the ARK-3 local store.
- Raw payload preserved (`raw: Json`) on every Order/Product row for audit
  when a number looks wrong.

## Customer identity (ARK-35)

Per `feature-audit` §2.3/§5 (ARK-32): the reference OMS has no `customers`
table — customer identity is two free-text phone columns
(`naver_inquiries.customer_name/phone`, `orders.customer_name/phone`)
compared as strings, so repurchase/LTV/a 360-degree customer view is
structurally impossible there. This adds `Customer` before any feature writes
to it, so nothing downstream retrofits a merge key later.

- **`Customer`** — one row per (tenant, normalized phone number). Reuses the
  ARK-10 tenant boundary (`Seller`) and its exact RLS pattern (`ENABLE`/
  `FORCE ROW LEVEL SECURITY` + `tenant_isolation` policy keyed on
  `current_setting('app.tenant_id', true)`) — see `docs/multi-tenancy.md`.
  `primaryPhone` is meant to be digits-only (hyphens/whitespace stripped)
  before insert; there is no writer yet to enforce that in code (see below).
  `channelIds` (jsonb) holds per-channel identifiers (e.g. `{"naver":
  ["Q123", "T_xxx"]}`) so a future CS view can resolve a channel inquiry id
  back to this row.
- **`Order.customerId`** — nullable FK to `Customer`. Nullable because no
  phone-matching service exists yet; every existing and newly-synced order
  starts unlinked.
- **`customer_activity` VIEW** (in the migration, not in Prisma — Prisma has
  no first-class view support) — unifies 문의(inquiry) + 주문(order) +
  견적(quote) into one timeline per customer, per the issue's explicit ask.
  Only `Order` exists today; `Inquiry`/`Quote` don't exist as tables yet (no
  CS/quote feature has been built), so the view has one `UNION ALL` arm and
  is written so each future entity adds one more arm without touching this
  one. Not consumed by any app code yet — the first CS/quote issue that needs
  a timeline is the intended consumer.

| File | Role |
| --- | --- |
| `prisma/schema.prisma` | `Customer` model + `Order.customerId` |
| `prisma/migrations/20260703000000_customers_activity_view/` | Table, FK, RLS policy, `customer_activity` VIEW |

**Verified:** migration applied cleanly against `@electric-sql/pglite`
(same method as ARK-10 — see "Sandbox verification" in
`docs/multi-tenancy.md`), plus a functional check confirming: the
`(tenantId, primaryPhone)` unique constraint rejects a duplicate, the
`Order.customerId` FK rejects a bogus id, an `Order` with no `customerId`
still inserts (the common unmatched case), and `customer_activity` returns
the expected joined row. RLS *enforcement* itself has the same unverified
status as ARK-10 (needs a live Postgres, non-superuser role — see
`docs/multi-tenancy.md`).

## Deliberately not done here

- **No live DB exercise.** `prisma validate` and `prisma generate` pass; an
  actual `prisma migrate dev` run against Postgres is straightforward but
  needs a running database, which is ARK-5's concern when it wires up the
  sync engine end-to-end.
- **The ARK-3 CLI (`naver-pull.ts`) is untouched** — it still writes to
  `./data/naver/*.json`. It's a spike/debug tool, not the sync engine;
  `PrismaDomainStore` is what ARK-5's order-sync engine will use.
- **No settlement mapper** — see Settlement above.
- **No customer-matching service** — nothing normalizes a raw phone number or
  upserts/links a `Customer` yet (ARK-35 is schema + FK only, per its stated
  scope). That lands with whichever CS/견적 issue first needs to write to
  `Customer`/`Order.customerId`.
