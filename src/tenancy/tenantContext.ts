import type { PrismaClient } from "@prisma/client";

/**
 * ARK-10, per ADR-0002 §2c (docs/adr/0002-multi-tenancy-b2b-b2c.md): the
 * Prisma client extension that makes Postgres RLS see a tenant. Every
 * operation issued through the returned client runs inside a transaction that
 * first sets the session-local `app.tenant_id` the RLS policies key on (see
 * prisma/migrations/20260701000001_tenant_rls_policies) — the standard
 * Prisma pattern for RLS ("Row Level Security" client extension recipe).
 *
 * This is defense-in-depth alongside the explicit `tenantId` filters in
 * domain/repository.ts, not a replacement for them — RLS only actually blocks
 * anything when the app connects as the non-superuser, non-BYPASSRLS
 * `arkain_app` role (docs/multi-tenancy.md). `set_config(..., true)` is the
 * parameterized equivalent of `SET LOCAL`, scoped to the transaction only.
 *
 * Not behaviorally verified against a live Postgres in this environment (no
 * reachable DB — see docs/multi-tenancy.md); the migration SQL and this
 * wrapper are reviewed against Prisma's documented extension contract, not
 * exercised end-to-end.
 */
export function forTenant(prisma: PrismaClient, tenantId: string) {
  return prisma.$extends({
    query: {
      $allOperations({ args, query }) {
        return prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
          return query(args);
        });
      },
    },
  });
}
