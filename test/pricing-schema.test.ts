import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * ARK-42: real Postgres RLS isolation test for the ARK-36 pricing/quote
 * schema (PriceSegment/PricingRule/ModelSegDiscount/ColorTaxonomy/
 * ColorSurcharge/Quote/QuoteItem).
 *
 * Unlike test/repository.test.ts (a fake-Prisma-client test of the app-level
 * `forTenant` query wiring), this boots a real Postgres-compatible engine
 * (`@electric-sql/pglite`, in-process — no network/socket, so it's safe to
 * run in CI without a live Postgres) and applies every migration.sql in
 * prisma/migrations/ verbatim. It then connects as the actual `arkain_app`
 * role (via `SET LOCAL ROLE`, reset per-transaction) with the actual
 * `app.tenant_id` session variable `forTenant` sets — the same mechanism
 * docs/multi-tenancy.md documents for exercising RLS locally — so what's
 * being tested is the RLS policies themselves, not just query construction.
 *
 * No domain/repository layer exists yet for Quote/PriceSegment (ARK-36's
 * design doc §5 scopes the calc/service layer to a follow-up issue), so
 * these tests talk to the tables directly via SQL, mirroring how a future
 * repository would run its queries `forTenant`-scoped.
 */

const migrationsDir = path.join(process.cwd(), "prisma", "migrations");

let db: PGlite;

async function applyMigrations(target: PGlite) {
  const dirs = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const dir of dirs) {
    const sql = readFileSync(path.join(migrationsDir, dir, "migration.sql"), "utf8");
    await target.exec(sql);
  }
}

/** Mirrors src/tenancy/tenantContext.ts's `forTenant`: run inside a
 * transaction, set the RLS session var (`SET LOCAL` semantics via
 * `set_config(..., true)`), and connect as the actual non-superuser
 * `arkain_app` role (`SET LOCAL ROLE`, so it resets at commit/rollback). */
async function asTenant<T>(tenantId: string, fn: (tx: PGlite) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec(`SET LOCAL ROLE arkain_app`);
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    return fn(tx as unknown as PGlite);
  });
}

beforeAll(async () => {
  db = new PGlite();
  await applyMigrations(db);
  await db.query(
    `INSERT INTO "Seller" (id, "displayName", email, "passwordHash") VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)`,
    [
      "tenant-a",
      "Tenant A",
      "tenant-a@test.local",
      "test-hash-a",
      "tenant-b",
      "Tenant B",
      "tenant-b@test.local",
      "test-hash-b",
    ],
  );
  await db.query(
    `INSERT INTO "PriceSegment" (id, "tenantId", code, name, "updatedAt") VALUES
     ($1,$2,$3,$4, now()), ($5,$6,$7,$8, now())`,
    ["seg-a", "tenant-a", "aquarium", "아쿠아리움", "seg-b", "tenant-b", "vivarium", "비바리움"],
  );
  await db.query(
    `INSERT INTO "Quote" (id, "tenantId", status, "updatedAt") VALUES
     ($1,$2,'DRAFT', now()), ($3,$4,'DRAFT', now())`,
    ["quote-a", "tenant-a", "quote-b", "tenant-b"],
  );
}, 30_000);

afterAll(async () => {
  await db.close();
});

describe("pricing/quote schema tenant isolation (ARK-42, real Postgres RLS)", () => {
  it("PriceSegment: tenant A never sees tenant B's rows", async () => {
    const asA = await asTenant("tenant-a", (tx) => tx.query<{ id: string }>(`SELECT id FROM "PriceSegment"`));
    const asB = await asTenant("tenant-b", (tx) => tx.query<{ id: string }>(`SELECT id FROM "PriceSegment"`));

    expect(asA.rows.map((r) => r.id)).toEqual(["seg-a"]);
    expect(asB.rows.map((r) => r.id)).toEqual(["seg-b"]);
  });

  it("Quote: tenant A never sees tenant B's rows", async () => {
    const asA = await asTenant("tenant-a", (tx) => tx.query<{ id: string }>(`SELECT id FROM "Quote"`));
    const asB = await asTenant("tenant-b", (tx) => tx.query<{ id: string }>(`SELECT id FROM "Quote"`));

    expect(asA.rows.map((r) => r.id)).toEqual(["quote-a"]);
    expect(asB.rows.map((r) => r.id)).toEqual(["quote-b"]);
  });

  it("rejects inserting a row tagged with another tenant's id (WITH CHECK)", async () => {
    await expect(
      asTenant("tenant-a", (tx) =>
        tx.query(
          `INSERT INTO "PriceSegment" (id, "tenantId", code, name, "updatedAt") VALUES ($1,$2,$3,$4, now())`,
          ["seg-evil", "tenant-b", "hack", "hack"],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("an update targeting another tenant's row by id affects zero rows (USING clause)", async () => {
    await asTenant("tenant-a", (tx) => tx.query(`UPDATE "PriceSegment" SET name = 'renamed' WHERE id = 'seg-b'`));

    const stillOriginal = await asTenant("tenant-b", (tx) =>
      tx.query<{ name: string }>(`SELECT name FROM "PriceSegment" WHERE id = 'seg-b'`),
    );
    expect(stillOriginal.rows[0]?.name).toBe("비바리움");
  });

  it("QuoteItem has no RLS of its own (reached only through its parent Quote, per OrderItem precedent)", async () => {
    const result = await db.query<{ rowsecurity: boolean }>(
      `SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'QuoteItem'`,
    );
    expect(result.rows[0]?.rowsecurity).toBe(false);
  });
});

describe("QuoteItem unit_price snapshot (ARK-42, ARK-36 design doc §2.7)", () => {
  it("stores the calculation result as-is and returns it unchanged after the pricing inputs it snapshotted change", async () => {
    await asTenant("tenant-a", (tx) =>
      tx.query(
        `INSERT INTO "QuoteItem"
           (id, "quoteId", "productName", "modelName", color, quantity,
            "segmentId", "segmentCodeSnapshot", "priceType", "basePriceKrw",
            "discountRateSnapshot", "colorSurchargeKrw", "roundUnitSnapshot",
            "unitPriceKrw", "lineTotalKrw")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          "item-1",
          "quote-a",
          "테스트 상품",
          "model-x",
          "화이트",
          3,
          "seg-a",
          "aquarium",
          "WHOLESALE",
          10000,
          "0.3000",
          500,
          100,
          7350, // the snapshotted computed unit price
          22050, // 7350 * 3
        ],
      ),
    );

    // Simulate the pricing inputs changing after the quote was written —
    // this must never retroactively change the stored snapshot.
    await db.query(`UPDATE "PriceSegment" SET name = 'renamed after quote' WHERE id = 'seg-a'`);

    const before = await asTenant("tenant-a", (tx) =>
      tx.query<{ unitPriceKrw: number; lineTotalKrw: number }>(
        `SELECT "unitPriceKrw", "lineTotalKrw" FROM "QuoteItem" WHERE id = 'item-1'`,
      ),
    );
    expect(before.rows[0]).toEqual({ unitPriceKrw: 7350, lineTotalKrw: 22050 });

    // Re-fetch again (a second, independent read) — still the untouched snapshot.
    const again = await asTenant("tenant-a", (tx) =>
      tx.query<{ unitPriceKrw: number; lineTotalKrw: number }>(
        `SELECT "unitPriceKrw", "lineTotalKrw" FROM "QuoteItem" WHERE id = 'item-1'`,
      ),
    );
    expect(again.rows[0]).toEqual({ unitPriceKrw: 7350, lineTotalKrw: 22050 });
  });

  it("QuoteItem is only reachable through its parent Quote's tenant scope, not a tenantId column of its own", async () => {
    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'QuoteItem' AND column_name = 'tenantId'`,
    );
    expect(columns.rows).toHaveLength(0);

    // Deleting the parent Quote cascades — QuoteItem has no independent lifecycle.
    await db.query(
      `INSERT INTO "Quote" (id, "tenantId", status, "updatedAt") VALUES ('quote-cascade', 'tenant-a', 'DRAFT', now())`,
    );
    await db.query(
      `INSERT INTO "QuoteItem"
         (id, "quoteId", "productName", "modelName", color, quantity, "priceType",
          "basePriceKrw", "discountRateSnapshot", "roundUnitSnapshot", "unitPriceKrw", "lineTotalKrw")
       VALUES ('item-cascade', 'quote-cascade', 'p', 'm', 'c', 1, 'RETAIL', 1000, '0', 100, 1000, 1000)`,
    );
    await db.query(`DELETE FROM "Quote" WHERE id = 'quote-cascade'`);

    const remaining = await db.query(`SELECT id FROM "QuoteItem" WHERE id = 'item-cascade'`);
    expect(remaining.rows).toHaveLength(0);
  });
});
