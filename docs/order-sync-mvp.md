# Order-sync MVP: unified order dashboard (ARK-5)

**Status:** sync engine + dashboard implemented and unit-tested end to end.
**Live Naver data is still gated on the ARK-3 credential blocker** (CEO
sign-off pending) — everything up to that gate is wired against the real
`NaverSmartstoreAdapter`, not a mock, so the moment credentials land the same
code pulls real seller orders with zero changes.

## What this is

The proof point for the whole product: orders from a connected marketplace,
pulled on a schedule, shown in one dashboard.

```
MarketplaceConnection (encrypted cred)
        |
        v  (decrypted just-in-time, per cycle)
OrderSyncEngine.syncConnection()  --uses-->  MarketplaceAdapter.fetchOrders()
        |                                          (ARK-3, real adapter)
        v
PrismaDomainStore.upsertOrders()  --(ARK-4 mapper)-->  Order/OrderItem rows
        |
        v
GET /api/orders  -->  GET /orders (dashboard table)
```

| File | Role |
| --- | --- |
| `src/sync/orderSyncEngine.ts` | Marketplace-agnostic poll loop: page a connection until exhausted, upsert, record a `SyncRun`, resume from the last successful cursor next cycle. No retry logic here — that already lives in the adapter's HTTP client (`integrations/retry.ts`), shared across marketplaces. |
| `src/domain/repository.ts` | Added `listOrders` (dashboard read path), `listActiveConnections`, `getLastCursor`, `recordSyncStart`/`recordSyncFinish` (sync audit trail) alongside the ARK-4 `upsertOrders`/`upsertProducts`. |
| `src/web/ordersDashboard.ts` | Server-rendered HTML shell + vanilla JS against `/api/orders`. Deliberately not React/Next — ARCHITECTURE.md defers that framework decision until after this MVP is proven; this is the thin interim UI that proves it. |
| `src/app.ts` | `GET /api/orders` (JSON, filterable by `marketplace`/`status`), `GET /orders` (the dashboard page), `POST /api/sync/run` (manual trigger, for demos/ops). All three take an injected store/trigger so routes are unit-testable without a database (`test/dashboard.test.ts`). |
| `src/main.ts` | Real wiring: constructs `PrismaClient`, `EnvelopeCredentialStore`, the Naver adapter, and `OrderSyncEngine`, then starts the in-process scheduler (`ORDER_SYNC_INTERVAL_MS`, default 5 min). Only activates when both `DATABASE_URL` and `CREDENTIAL_ENC_KEY` are set — the skeleton still boots without a DB otherwise. |
| `src/scripts/seed-demo-orders.ts` | Seeds fabricated, Naver-shaped orders through the same `upsertOrders` path the engine uses, so the dashboard is demoable today despite the ARK-3 credential gate. Not real seller data; no marketplace call is made. |
| `test/sync.test.ts` | `OrderSyncEngine` against a fake in-memory store + fake adapter: pagination, cursor resume, failure recording, missing-adapter handling, the per-cycle page cap. No DB required. |
| `test/dashboard.test.ts` | `/api/orders`, `/orders`, `/api/sync/run` via `app.inject()` with an injected fake store — same pattern as `health.test.ts`. |

## Design decisions

- **Adapter-agnostic engine.** `OrderSyncEngine` only depends on `MarketplaceAdapter` + normalized types (ARCHITECTURE.md §5). Adding 쿠팡 means registering a second adapter in `main.ts`'s `adapters` map — the engine, scheduler, and dashboard need no changes.
- **Cursor resume, not full re-scan.** Each connection's next cycle starts from its last *successful* `SyncRun.cursor`, falling back to the `NAVER_PULL_SINCE_DAYS` lookback only on a connection's first sync. Idempotent upserts (`(marketplace, marketplaceOrderId)`) mean an interrupted cycle is safe to simply re-run.
- **In-process scheduler, no queue.** One `setInterval` loop, non-overlapping ticks, sequential per-connection sync. Matches ARCHITECTURE.md §2/§4 — a queue is premature before there's sync volume to justify it.
- **Just-in-time credential decryption.** `main.ts` decrypts each connection's credential fresh every tick and lets it fall out of scope after — no standing plaintext between cycles (ARCHITECTURE.md §7).
- **Every number traceable.** Each cycle writes a `SyncRun` row (`running` → `success`/`failed`, `ordersPulled`, `cursor`, `error`) per connection, so a wrong-looking order count is traceable to the exact run that produced it.
- **Dependency-injected routes, not a live-DB test suite.** `buildApp` takes an optional `{ store, runSync }`; tests supply in-memory fakes. This sandbox has no Postgres available to exercise `PrismaDomainStore`/`prisma migrate dev` against a live database — that step is mechanical (`docker compose up -d && npm run db:migrate`) and identical to the gap already flagged in `docs/domain-model.md`.

## Running the demo

```
docker compose up -d          # local Postgres
npm run db:migrate            # applies the ARK-4 schema
npm run seed:demo             # fabricated orders, no live Naver call
npm run dev                    # http://localhost:3000/orders
```

With `NAVER_COMMERCE_CLIENT_ID`/`SECRET` + a `MarketplaceConnection` row for a
real seller, the same dashboard shows live orders — no code path changes
between demo and live data, only which rows are in the table.

## Deliberately not done here

- **No live Naver pull exercised** — blocked on [ARK-3](/ARK/issues/ARK-3)'s
  credential gate (CEO sign-off), same as ARK-4.
- **No connection-management UI** (creating/editing a `MarketplaceConnection`
  is not part of this MVP; connections are provisioned directly for now).
- **No products/settlement dashboard** — those are ARK-6/ARK-7's scope.
