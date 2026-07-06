-- ARK-86: 비밀번호 재설정 토큰. Both columns are nullable from the start (no
-- backfill needed, unlike companyCode) since "no pending reset" is every
-- existing Seller row's correct starting state.
ALTER TABLE "Seller" ADD COLUMN "passwordResetTokenHash" TEXT;
ALTER TABLE "Seller" ADD COLUMN "passwordResetExpiresAt" TIMESTAMP(3);
