# Unified domain model (ARK-4)

**Status:** schema + Naver mapping implemented and unit-tested. Not yet
exercised against a live database (no `DATABASE_URL` provisioned in this
environment) or live Naver data (ARK-3's credential blocker) — both are
mechanical next steps, not open design questions.

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

## Deliberately not done here

- **No live DB exercise.** `prisma validate` and `prisma generate` pass; an
  actual `prisma migrate dev` run against Postgres is straightforward but
  needs a running database, which is ARK-5's concern when it wires up the
  sync engine end-to-end.
- **The ARK-3 CLI (`naver-pull.ts`) is untouched** — it still writes to
  `./data/naver/*.json`. It's a spike/debug tool, not the sync engine;
  `PrismaDomainStore` is what ARK-5's order-sync engine will use.
- **No settlement mapper** — see Settlement above.
