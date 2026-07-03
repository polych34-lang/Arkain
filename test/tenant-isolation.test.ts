import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * ARK-55: real-Postgres tenant isolation / penetration test for every RLS'd
 * table in the schema (ARK-10, ARK-34, ARK-35, ARK-37, ARK-40 — Order/
 * Product/Settlement/Customer/Inquiry/accounting module). PriceSegment/
 * PricingRule/ModelSegDiscount/ColorTaxonomy/ColorSurcharge/Quote are already
 * covered by test/pricing-schema.test.ts (ARK-42) and are not repeated here.
 *
 * Same in-process PGlite pattern as test/pricing-schema.test.ts: boot a real
 * Postgres-compatible engine, apply every migration.sql verbatim, then
 * exercise RLS as the actual non-superuser `arkain_app` role (`SET LOCAL
 * ROLE`) with the actual `app.tenant_id` session variable `forTenant` sets
 * (src/tenancy/tenantContext.ts) — see docs/multi-tenancy.md "Correction
 * (ARK-42): RLS enforcement can be verified via PGlite" for why this
 * in-process approach is the one that actually exercises the policies,
 * unlike routing Prisma's CLI through PGlite's socket bridge.
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

async function asTenant<T>(tenantId: string, fn: (tx: PGlite) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec(`SET LOCAL ROLE arkain_app`);
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    return fn(tx as unknown as PGlite);
  });
}

/** As the app role, but with no `app.tenant_id` ever set — simulates a
 * middleware bug that forgets to scope the connection. RLS must fail closed
 * (zero rows), not fail open (all tenants' rows). */
async function asUnscopedAppRole<T>(fn: (tx: PGlite) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec(`SET LOCAL ROLE arkain_app`);
    return fn(tx as unknown as PGlite);
  });
}

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

/** One representative row per RLS'd table, keyed by model name, so the same
 * config drives seeding and the INSERT/UPDATE/DELETE probes below without
 * hand-repeating near-identical SQL per table. */
const MODELS: Array<{
  label: string;
  table: string;
  /** Column + poison value (type-matched) used to assert an UPDATE-by-id from
   * the wrong tenant is a no-op. */
  probeColumn: string;
  probeValue: unknown;
  insert: (id: string, tenantId: string) => { sql: string; params: unknown[] };
}> = [
  {
    label: "Order",
    table: `"Order"`,
    probeColumn: "buyerName",
    probeValue: "renamed-by-attacker",
    insert: (id, tenantId) => ({
      sql: `INSERT INTO "Order" (id, "tenantId", marketplace, "marketplaceOrderId", status, "rawStatus", "orderedAt", "buyerName", "totalAmountKrw", raw, "updatedAt")
            VALUES ($1,$2,'naver_smartstore',$3,'PENDING','pending', now(), 'original', 10000, '{}'::jsonb, now())`,
      params: [id, tenantId, `mp-${id}`],
    }),
  },
  {
    label: "Product",
    table: `"Product"`,
    probeColumn: "name",
    probeValue: "renamed-by-attacker",
    insert: (id, tenantId) => ({
      sql: `INSERT INTO "Product" (id, "tenantId", marketplace, "marketplaceProductId", name, "salePriceKrw", "stockQuantity", status, "rawStatus", raw, "updatedAt")
            VALUES ($1,$2,'naver_smartstore',$3,'original', 1000, 5, 'ON_SALE', 'on_sale', '{}'::jsonb, now())`,
      params: [id, tenantId, `mp-${id}`],
    }),
  },
  {
    label: "Settlement",
    table: `"Settlement"`,
    probeColumn: "payoutAmountKrw",
    probeValue: 999999999,
    insert: (id, tenantId) => ({
      sql: `INSERT INTO "Settlement" (id, "tenantId", marketplace, "payoutAmountKrw", "feeAmountKrw", "updatedAt")
            VALUES ($1,$2,'naver_smartstore', 900, 100, now())`,
      params: [id, tenantId],
    }),
  },
  {
    label: "Customer",
    table: `"Customer"`,
    probeColumn: "name",
    probeValue: "renamed-by-attacker",
    insert: (id, tenantId) => ({
      sql: `INSERT INTO "Customer" (id, "tenantId", "primaryPhone", name, "updatedAt")
            VALUES ($1,$2,$3,'original', now())`,
      params: [id, tenantId, `010-${id}`],
    }),
  },
  {
    label: "Inquiry",
    table: `"Inquiry"`,
    probeColumn: "content",
    probeValue: "renamed-by-attacker",
    insert: (id, tenantId) => ({
      sql: `INSERT INTO "Inquiry" (id, "tenantId", channel, "externalInquiryNo", content, "updatedAt")
            VALUES ($1,$2,'PRODUCT_QNA',$3,'original', now())`,
      params: [id, tenantId, `ext-${id}`],
    }),
  },
  {
    label: "LedgerAccount",
    table: `"LedgerAccount"`,
    probeColumn: "name",
    probeValue: "renamed-by-attacker",
    insert: (id, tenantId) => ({
      sql: `INSERT INTO "LedgerAccount" (id, "tenantId", code, name, category, "updatedAt")
            VALUES ($1,$2,$3,'original','ASSET', now())`,
      params: [id, tenantId, `code-${id}`],
    }),
  },
  {
    label: "AccPartner",
    table: `"AccPartner"`,
    probeColumn: "name",
    probeValue: "renamed-by-attacker",
    insert: (id, tenantId) => ({
      sql: `INSERT INTO "AccPartner" (id, "tenantId", type, name, "updatedAt")
            VALUES ($1,$2,'GENERAL',$3, now())`,
      params: [id, tenantId, `partner-${id}`],
    }),
  },
  {
    label: "JournalEntry",
    table: `"JournalEntry"`,
    probeColumn: "description",
    probeValue: "renamed-by-attacker",
    insert: (id, tenantId) => ({
      sql: `INSERT INTO "JournalEntry" (id, "tenantId", "entryDate", description, "sourceType", "updatedAt")
            VALUES ($1,$2, now(), 'original', 'MANUAL', now())`,
      params: [id, tenantId],
    }),
  },
  {
    label: "BankTransaction",
    table: `"BankTransaction"`,
    probeColumn: "rawDescription",
    probeValue: "renamed-by-attacker",
    insert: (id, tenantId) => ({
      sql: `INSERT INTO "BankTransaction" (id, "tenantId", "transactionDate", "rawDescription", "amountKrw", direction)
            VALUES ($1,$2, now(), 'original', 500, 'DEPOSIT')`,
      params: [id, tenantId],
    }),
  },
  {
    label: "CcTransaction",
    table: `"CcTransaction"`,
    probeColumn: "merchantName",
    probeValue: "renamed-by-attacker",
    insert: (id, tenantId) => ({
      sql: `INSERT INTO "CcTransaction" (id, "tenantId", "transactionDate", "merchantName", "amountKrw", "sourceHash")
            VALUES ($1,$2, now(), 'original', 200, $3)`,
      params: [id, tenantId, `hash-${id}`],
    }),
  },
];

/** BankRule/CcMerchantMap need an existing LedgerAccount per tenant (required
 * FK), so they're seeded after the LedgerAccount rows exist rather than
 * folded into MODELS above. */
const LEDGER_FOR_RULES: Record<string, string> = {
  [TENANT_A]: "ledger-rule-a",
  [TENANT_B]: "ledger-rule-b",
};

beforeAll(async () => {
  db = new PGlite();
  await applyMigrations(db);
  await db.query(`INSERT INTO "Seller" (id, "displayName") VALUES ($1, $2), ($3, $4)`, [
    TENANT_A,
    "Tenant A",
    TENANT_B,
    "Tenant B",
  ]);

  for (const model of MODELS) {
    for (const tenantId of [TENANT_A, TENANT_B]) {
      const id = `${model.label.toLowerCase()}-${tenantId}`;
      const { sql, params } = model.insert(id, tenantId);
      await db.query(sql, params);
    }
  }

  // BankRule / CcMerchantMap: seed the LedgerAccount FK each references first.
  for (const tenantId of [TENANT_A, TENANT_B]) {
    await db.query(
      `INSERT INTO "LedgerAccount" (id, "tenantId", code, name, category, "updatedAt")
       VALUES ($1,$2,$3,'ledger-for-rules','ASSET', now())`,
      [LEDGER_FOR_RULES[tenantId], tenantId, `rule-code-${tenantId}`],
    );
    await db.query(
      `INSERT INTO "BankRule" (id, "tenantId", "matchPattern", "accountId", "updatedAt")
       VALUES ($1,$2,'original',$3, now())`,
      [`bankrule-${tenantId}`, tenantId, LEDGER_FOR_RULES[tenantId]],
    );
    await db.query(
      `INSERT INTO "CcMerchantMap" (id, "tenantId", "merchantNamePattern", "accountId", "updatedAt")
       VALUES ($1,$2,'original',$3, now())`,
      [`ccmap-${tenantId}`, tenantId, LEDGER_FOR_RULES[tenantId]],
    );
  }
}, 30_000);

afterAll(async () => {
  await db.close();
});

describe("tenant isolation: SELECT never crosses tenants (ARK-55)", () => {
  for (const model of MODELS) {
    it(`${model.label}: tenant A never sees tenant B's rows, and vice versa`, async () => {
      // Scoped by this model's own id prefix so extra fixture rows seeded for
      // other models' FK requirements (e.g. BankRule/CcMerchantMap's
      // LedgerAccount) don't interfere with the isolation assertion.
      const likePattern = `${model.label.toLowerCase()}-%`;
      const asA = await asTenant(TENANT_A, (tx) =>
        tx.query<{ id: string }>(`SELECT id FROM ${model.table} WHERE id LIKE $1`, [likePattern]),
      );
      const asB = await asTenant(TENANT_B, (tx) =>
        tx.query<{ id: string }>(`SELECT id FROM ${model.table} WHERE id LIKE $1`, [likePattern]),
      );
      expect(asA.rows.map((r) => r.id)).toEqual([`${model.label.toLowerCase()}-${TENANT_A}`]);
      expect(asB.rows.map((r) => r.id)).toEqual([`${model.label.toLowerCase()}-${TENANT_B}`]);
    });
  }

  it("BankRule: tenant A never sees tenant B's rows", async () => {
    const asA = await asTenant(TENANT_A, (tx) => tx.query<{ id: string }>(`SELECT id FROM "BankRule"`));
    const asB = await asTenant(TENANT_B, (tx) => tx.query<{ id: string }>(`SELECT id FROM "BankRule"`));
    expect(asA.rows.map((r) => r.id)).toEqual([`bankrule-${TENANT_A}`]);
    expect(asB.rows.map((r) => r.id)).toEqual([`bankrule-${TENANT_B}`]);
  });

  it("CcMerchantMap: tenant A never sees tenant B's rows", async () => {
    const asA = await asTenant(TENANT_A, (tx) => tx.query<{ id: string }>(`SELECT id FROM "CcMerchantMap"`));
    const asB = await asTenant(TENANT_B, (tx) => tx.query<{ id: string }>(`SELECT id FROM "CcMerchantMap"`));
    expect(asA.rows.map((r) => r.id)).toEqual([`ccmap-${TENANT_A}`]);
    expect(asB.rows.map((r) => r.id)).toEqual([`ccmap-${TENANT_B}`]);
  });
});

describe("tenant isolation: INSERT tagged with another tenant's id is rejected (WITH CHECK)", () => {
  for (const model of MODELS) {
    it(`${model.label}: rejects a row tagged with tenant B's id while authenticated as tenant A`, async () => {
      const evilId = `${model.label.toLowerCase()}-evil`;
      const { sql, params } = model.insert(evilId, TENANT_B);
      await expect(asTenant(TENANT_A, (tx) => tx.query(sql, params))).rejects.toThrow(
        /row-level security/i,
      );
    });
  }
});

describe("tenant isolation: cross-tenant UPDATE/DELETE by id affects zero rows (USING clause)", () => {
  for (const model of MODELS) {
    it(`${model.label}: an UPDATE targeting another tenant's row by id is a no-op`, async () => {
      const bId = `${model.label.toLowerCase()}-${TENANT_B}`;
      await asTenant(TENANT_A, (tx) =>
        tx.query(`UPDATE ${model.table} SET "${model.probeColumn}" = $1 WHERE id = $2`, [
          model.probeValue,
          bId,
        ]),
      );
      const stillOriginal = await asTenant(TENANT_B, (tx) =>
        tx.query<Record<string, unknown>>(`SELECT "${model.probeColumn}" AS val FROM ${model.table} WHERE id = $1`, [
          bId,
        ]),
      );
      expect(stillOriginal.rows[0]?.val).not.toEqual(model.probeValue);
    });

    it(`${model.label}: a DELETE targeting another tenant's row by id is a no-op`, async () => {
      const bId = `${model.label.toLowerCase()}-${TENANT_B}`;
      await asTenant(TENANT_A, (tx) => tx.query(`DELETE FROM ${model.table} WHERE id = $1`, [bId]));
      const stillThere = await asTenant(TENANT_B, (tx) =>
        tx.query<{ id: string }>(`SELECT id FROM ${model.table} WHERE id = $1`, [bId]),
      );
      expect(stillThere.rows).toHaveLength(1);
    });
  }
});

describe("tenant isolation: fails closed, not open (ARK-55 penetration scenario)", () => {
  it("a connection as arkain_app with no app.tenant_id ever set sees zero rows, not every tenant's rows", async () => {
    for (const model of MODELS) {
      const result = await asUnscopedAppRole((tx) => tx.query(`SELECT id FROM ${model.table}`));
      expect(result.rows, `${model.label} leaked rows to an unscoped connection`).toHaveLength(0);
    }
  });

  it("the table owner / superuser connection (no SET LOCAL ROLE) bypasses RLS entirely — documented operational risk", async () => {
    // This mirrors docs/multi-tenancy.md's warning verbatim: local dev's
    // docker-compose Postgres user is a superuser, so RLS is inert unless the
    // app actually connects as the non-superuser `arkain_app` role. This test
    // exists so that warning is a checked fact, not just a comment — if this
    // ever starts returning 1 row instead of 2, something about PGlite's
    // default connection role changed and the risk note above is stale.
    const asSuperuser = await db.query<{ id: string }>(`SELECT id FROM "Order"`);
    expect(asSuperuser.rows).toHaveLength(2);
  });
});

describe("tenant isolation: documented no-own-tenantId tables are unaffected (residual-gap precedent)", () => {
  const NO_OWN_RLS_TABLES = ["OrderItem", "ChannelMessage", "InquiryOrderLink", "JournalLine"];

  for (const table of NO_OWN_RLS_TABLES) {
    it(`${table} has no RLS of its own (reached only through its already-RLS'd parent)`, async () => {
      const result = await db.query<{ rowsecurity: boolean }>(
        `SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = $1`,
        [table],
      );
      expect(result.rows[0]?.rowsecurity).toBe(false);

      const hasTenantId = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'tenantId'`,
        [table],
      );
      expect(hasTenantId.rows).toHaveLength(0);
    });
  }
});

describe("tenant isolation: RLS coverage audit — every tenantId-bearing table must be RLS-protected or explicitly allowlisted", () => {
  /**
   * ARK-55 finding: `Account`/`AccountPriceListEntry`/`PurchaseOrder` (B2B
   * module, ARK-16) each have their own `tenantId` column — unlike
   * OrderItem/ChannelMessage/InquiryOrderLine/JournalLine/QuoteItem above,
   * which deliberately have none — but carry no RLS policy. This is a
   * documented, deliberate interim state (schema.prisma's B2B module header
   * comment + docs/adr/0003-b2b-accounts-purchase-orders.md §5: "tenantId is
   * enforced at the application layer today ... no RLS yet, same interim
   * posture ADR-0002 §2d describes for Order pre-ARK-10"), not a silent gap
   * this suite is inventing. It is allowlisted here so this audit stays
   * green today while still catching the case that actually matters for
   * regression prevention: any *future* table that adds its own `tenantId`
   * column without RLS and without being deliberately added to this list.
   *
   * Filed as a follow-up hardening item — see the ARK-55 issue thread.
   */
  const KNOWN_GAP_NO_RLS_YET = ["Account", "AccountPriceListEntry", "PurchaseOrder"];

  it("every table with its own tenantId column has ENABLE+FORCE ROW LEVEL SECURITY, or is an explicitly listed known gap", async () => {
    const tenantTables = await db.query<{ table_name: string }>(
      `SELECT DISTINCT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'tenantId'
       ORDER BY table_name`,
    );

    const rlsStatus = await db.query<{ tablename: string; rowsecurity: boolean }>(
      `SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public'`,
    );
    const rlsByTable = new Map(rlsStatus.rows.map((r) => [r.tablename, r.rowsecurity]));

    const unprotectedAndUnlisted = tenantTables.rows
      .map((r) => r.table_name)
      .filter((name) => !rlsByTable.get(name) && !KNOWN_GAP_NO_RLS_YET.includes(name));

    expect(unprotectedAndUnlisted, "found a tenantId-bearing table with no RLS and no accepted-gap entry").toEqual([]);

    // Sanity check the allowlist itself isn't stale (e.g. a table renamed or
    // an entry that no longer exists) and confirm the gap is still real —
    // if any of these ever gain RLS, shrink this list rather than leaving a
    // stale allowance in place.
    for (const name of KNOWN_GAP_NO_RLS_YET) {
      expect(tenantTables.rows.map((r) => r.table_name)).toContain(name);
      expect(rlsByTable.get(name)).toBe(false);
    }
  });
});
