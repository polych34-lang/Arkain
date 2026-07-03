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

**ARK-37 update:** `Inquiry`/`ChannelMessage`/`InquiryOrderLink` are new
entities — see "CS channel unification (ARK-37)" below. `Order` gained an
`inquiryLinks` back-relation, `Product` gained an `inquiries` back-relation,
and `customer_activity` gained its planned Inquiry `UNION ALL` arm.

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

## CS channel unification (ARK-37)

Per `feature-audit` §2.3/§4 (ARK-32): the reference OMS unifies its 4 CS
channels (상품문의/고객문의/톡톡/카카오) into one `naver_inquiries` table, with TalkTalk
messages held in an append-only `channel_messages` table that a trigger rolls
up into the parent row — the verified fix for the reference's v455 image-loss
bug (§4's bug-pattern table): the old flow read the current content
client-side, appended a message, and wrote it back, so two concurrent
messages landing in that window could silently drop one image/message
(read-modify-write race). This adopts that exact design.

- **`Inquiry`** — one row per CS inquiry across all 4 channels. `channel`
  (`PRODUCT_QNA`/`CUSTOMER_QNA`/`TALK`/`KAKAO`) replaces the reference's
  inquiry-number-prefix convention with an explicit enum. The idempotent
  upsert key is `(tenantId, channel, externalInquiryNo)` — **not**
  `marketplace`, even though `Order`'s equivalent key uses it: `KAKAO` isn't
  one of the `Marketplace` enum's storefronts (it's a messaging channel), so
  `marketplace` is nullable and descriptive-only here. Postgres treats NULLs
  as distinct in a unique index, so a NOT-NULL-`marketplace` key would have let
  two `KAKAO` rows silently coexist under the same tenant/externalInquiryNo — a
  latent gap this design avoids by keying on `channel` instead.
  `customerId`/`productId` are nullable FKs (`Customer`/`Product`) for the same
  reason as `Order.customerId`: no matching service exists yet, and
  `customerName`/`customerPhone` are populated directly from the channel
  payload at ingestion so the inquiry is usable before any match runs (same
  reasoning as `Order.buyerName` next to its nullable `customerId`).
- **`ChannelMessage`** — TALK/KAKAO conversation turns, **append-only**:
  the migration grants `arkain_app` `SELECT, INSERT` only, no `UPDATE`/
  `DELETE` — the actual fix for the v455 race, not just the trigger below. No
  `tenantId` of its own, same reasoning as `OrderItem` (ADR-0002 §2b): only
  ever reached via its parent `Inquiry` (already RLS'd). `attachments` (jsonb)
  holds the image/file rehosting design the issue asked for: each entry is
  `{originalUrl, rehostedUrl, rehostStatus, rehostedAt}`, matching the
  reference's 6s-timeout-then-fallback-to-`originalUrl` behavior (CDN URLs
  expire) — no rehosting worker exists yet (needs live Talk/Kakao credentials,
  gated on ARK-22), this is the storage shape one would write to.
- **`fn_channel_message_rollup`** (trigger, `AFTER INSERT ON "ChannelMessage"`)
  — atomically appends `NEW.content` into the parent `Inquiry.content` in the
  same transaction as the INSERT, so there is no read-then-write step for a
  second concurrent insert to race. Only `PRODUCT_QNA`/`CUSTOMER_QNA` inquiries
  set `content` directly at creation (single message, not conversational) —
  those channels never get `ChannelMessage` children, so the trigger simply
  never fires for them.
- **`InquiryOrderLink`** — 문의↔주문 연결, composite PK (`inquiryId`, `orderId`)
  supporting 1:N in both directions, per the issue's explicit ask (the
  reference auto-matches `CUSTOMER_QNA` 1:1 via order context but needs a
  manual link UI for `PRODUCT_QNA`/`TALK`, which can span multiple orders).
  Mutable (`linkType` "auto"/"manual", full CRUD grant) unlike
  `ChannelMessage` — a link can be corrected or removed.
- **`customer_activity` VIEW** — gained the Inquiry `UNION ALL` arm the ARK-35
  migration's comment said it was written for, with no other arm touched.

| File | Role |
| --- | --- |
| `prisma/schema.prisma` | `Inquiry`/`ChannelMessage`/`InquiryOrderLink` models + `InquiryChannel`/`InquiryStatus`/`MessageDirection` enums |
| `prisma/migrations/20260703020000_cs_channel_unification/` | Tables, FKs, RLS policy, append-only grants, `fn_channel_message_rollup` trigger, `customer_activity` VIEW's Inquiry arm |

**Verified:** migration applied cleanly against `@electric-sql/pglite` (same
method as ARK-10/ARK-35 — see "Sandbox verification" in
`docs/multi-tenancy.md`), plus functional checks confirming: the
`(tenantId, channel, externalInquiryNo)` unique constraint rejects a
duplicate but allows the same `externalInquiryNo` across different channels;
`customerId`/`productId`/`orderId` FKs reject bogus ids; the
`fn_channel_message_rollup` trigger correctly appends two sequential
`ChannelMessage` inserts into `Inquiry.content` in order; the
`InquiryOrderLink` composite PK rejects a duplicate `(inquiryId, orderId)`
pair; and `customer_activity` returns both Order and Inquiry rows for the same
customer. RLS/role-grant *enforcement* (the append-only `GRANT` in
particular) has the same unverified status as ARK-10/ARK-35 — pglite's
role/session model doesn't reliably honor non-superuser role switching (see
"Sandbox verification"); confirmed instead by static inspection that the
migration's `GRANT` statement for `ChannelMessage` omits `UPDATE`/`DELETE`.

### Deliberately not done here

- **No rehosting worker.** `ChannelMessage.attachments` defines the storage
  shape; nothing in this repo yet fetches a Naver CDN URL and re-uploads it
  (would need live Talk/Kakao credentials, blocked on ARK-22).
- **No customer/order matching for inquiries.** `Inquiry.customerId` and
  `InquiryOrderLink` rows are never written by app code yet — same posture as
  `Order.customerId` (ARK-35): schema/FK only, per this issue's stated scope.
- **No CS inbox UI.** Schema only, per the issue title.
