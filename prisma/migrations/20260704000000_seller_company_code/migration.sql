-- ARK-72: 회사코드 (companyCode) on `Seller` — the third field (alongside
-- 계정/비밀번호) on the login screen, letting the same site host per-tenant
-- logins. Auto-generated, never user-chosen.
--
-- DEFAULT '' on the new NOT NULL column is a migration-safety step for any
-- pre-existing Seller rows (e.g. the `demo-seller` seed), immediately dropped
-- after backfill so new rows can't silently get a blank code — same pattern
-- as the 20260703170000 email/passwordHash migration.
ALTER TABLE "Seller" ADD COLUMN "companyCode" TEXT NOT NULL DEFAULT '';

UPDATE "Seller" SET "companyCode" = upper(substr(md5("id"), 1, 6))
WHERE "companyCode" = '';

ALTER TABLE "Seller" ALTER COLUMN "companyCode" DROP DEFAULT;

CREATE UNIQUE INDEX "Seller_companyCode_key" ON "Seller"("companyCode");
