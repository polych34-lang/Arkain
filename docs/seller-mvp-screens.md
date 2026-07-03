# Seller MVP screens: 로그인 → 워크스페이스 생성 → 상품등록 → 주문확인 (ARK-57)

**Status:** implemented and end-to-end verified against a live Postgres
(see "Verification" below). First seller-facing UI layer added on top of the
already-done backend (ARK-4/10/16/34) — before this issue there was no login,
no way to create a workspace, and no way to register a product by hand.

## What this is

A minimal login + workspace-creation + manual product-registration flow,
plumbed into the existing thin server-rendered-HTML UI layer
(`ordersDashboard.ts` et al., ARK-5/ARK-21) rather than a new frontend
framework — matches ARCHITECTURE.md §2's "thin React UI, later" note: still
"later", this MVP doesn't need it yet.

```
POST /api/auth/signup  (workspaceName, email, password)
  -> creates one Seller row (== the tenant/workspace) + the login credential
  -> sets the arkain_sid session cookie (HMAC-signed, src/auth/session.ts)
POST /api/auth/login    -> same cookie, for a returning seller
GET  /products          -> register a product (POST /api/products) + see the list
GET  /orders             -> ARK-5's dashboard, now session-scoped when auth is configured
```

| File | Role |
| --- | --- |
| `prisma/schema.prisma` | `Seller.email`/`Seller.passwordHash` (sign-up creates both the login and the workspace in one row — see the doc comment on `Seller.email`). `Marketplace.direct` for seller-entered products with no marketplace sync. Migration: `prisma/migrations/20260703170000_seller_auth_and_direct_products`. |
| `src/auth/password.ts` | bcrypt hash/verify (`bcryptjs`, already a dependency via the Naver adapter). |
| `src/auth/session.ts` | HMAC-signed session cookie, no new dependency (`@fastify/cookie` etc.) — a handful of pure functions, same "no premature abstraction" posture as the rest of this interim UI layer. |
| `src/auth/authStore.ts` | `AuthStore` — `createSeller`/`findSellerByEmail`. |
| `src/domain/repository.ts` | `PrismaDomainStore.createManualProduct`/`listProducts` — writes `marketplace: "direct"` with a synthetic `marketplaceProductId` so it reuses the existing product unique-key shape. |
| `src/web/{signup,login,productsDashboard}.ts` | New HTML pages. `ordersDashboard.ts` gained a nav bar + a redirect-to-`/login` on a 401. |
| `src/app.ts` | `GET /signup`, `/login`, `/products`; `POST /api/auth/{signup,login,logout}`, `GET /api/auth/me`; `GET/POST /api/products`. `GET /api/orders` now requires a session **and forces `filter.tenantId` to the session's sellerId** once `deps.auth` is configured — the client-supplied filter is never trusted for tenant scoping (repository.ts's `OrderListFilter.tenantId` doc comment: "every tenant-facing caller must set this once per-session auth exists"). Every route is optional on `deps.auth`/`deps.products` being wired, same pattern as every other route in this file — no `deps.auth` (e.g. every existing test) keeps the old pre-auth behavior byte-for-byte. |
| `src/main.ts` | Wires `AuthStore` + products when `SESSION_SECRET` is set, alongside the existing `DATABASE_URL`/`CREDENTIAL_ENC_KEY` gate. |
| `src/scripts/seed-demo-orders.ts` | Also (re-)sets a fixed demo login (`demo@arkain.dev` / `demo1234!`) on the `demo-seller` tenant so the full flow can be walked without signing up first. |
| `test/{auth,products,session}.test.ts` | Route tests against fake in-memory stores (no DB), same convention as `test/dashboard.test.ts`/`test/connections.test.ts`. `test/{tenant-isolation,pricing-schema}.test.ts` updated for the new `Seller` columns. |

## Verification

- `npm run typecheck` / `npm test` (231 tests, 20 files) / `npm run build` all clean.
- **Unlike every prior ARK-* issue's "no DB/Docker available" caveat, this one
  ran against a real, live local Postgres** (`embedded-postgres`, already
  running in this environment on `localhost:55432`, matching `.env`'s
  `DATABASE_URL`): `npm run db:deploy` applied all 10 migrations cleanly,
  `npm run seed:demo` seeded 5 demo orders + the demo login, and the full
  flow was walked for real — sign-up creating an isolated new tenant (empty
  product/order lists, confirmed separate from the demo tenant's data),
  login, product registration, and the order dashboard all exercised via
  `curl` and a headless-Chromium (Playwright) screenshot pass. Screenshots
  attached to the [ARK-57](/ARK/issues/ARK-57) status comment.

## Known gaps (tracked, not blocking)

- One login per workspace (no separate `User` model / multi-seat workspaces)
  — noted as a future door on `Seller.email` in schema.prisma, not needed for
  this MVP.
- No password-reset flow.
- `GET /orders`'s page shell itself isn't session-gated server-side (only its
  client-side `fetch` redirects to `/login` on a 401) — same interim posture
  the rest of this UI layer already has (no server-side page-redirect
  middleware exists yet anywhere in `app.ts`).
- Manually-registered products (`marketplace: "direct"`) are never
  reconciled against a later real marketplace listing of the same item —
  out of scope for this MVP screen.
- Staging deployment (CEO-visible URL) is the Integrations & Deployment
  Engineer's ARK-28 pipeline, not this issue's scope — coordinated via the
  [ARK-57](/ARK/issues/ARK-57) status comment.
