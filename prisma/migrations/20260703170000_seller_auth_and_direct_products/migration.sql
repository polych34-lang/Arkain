-- ARK-57: seller login (email + bcrypt password hash on `Seller`, the
-- existing tenant/workspace row — sign-up creates both in one step) and a
-- `direct` Marketplace value for the MVP's manual "상품등록" screen (products
-- entered by the seller directly, no marketplace sync).
--
-- DEFAULT '' on the new NOT NULL columns is a migration-safety step for any
-- pre-existing Seller rows (e.g. the `demo-seller` seed), immediately dropped
-- after backfill so new rows can't silently get a blank email/password.
ALTER TABLE "Seller" ADD COLUMN "email" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Seller" ADD COLUMN "passwordHash" TEXT NOT NULL DEFAULT '';

UPDATE "Seller" SET "email" = 'seller-' || "id" || '@placeholder.arkain.local'
WHERE "email" = '';

ALTER TABLE "Seller" ALTER COLUMN "email" DROP DEFAULT;
ALTER TABLE "Seller" ALTER COLUMN "passwordHash" DROP DEFAULT;

CREATE UNIQUE INDEX "Seller_email_key" ON "Seller"("email");

ALTER TYPE "Marketplace" ADD VALUE 'direct';
