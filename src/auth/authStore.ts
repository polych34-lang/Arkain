import { randomInt } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

/** ARK-57: seller login identity. Never includes the plaintext password. */
export interface SellerAuthRecord {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
  /** ARK-72: 회사코드 — required alongside email/password at login. */
  companyCode: string;
  /** ARK-86: SHA-256 hash of the active password-reset token, or null/undefined
   * when no reset is pending. Never the raw token — see resetToken.ts. */
  passwordResetTokenHash?: string | null;
  /** ARK-86: expiry for `passwordResetTokenHash`. Both are cleared together
   * once the reset is consumed (or superseded by a new request). */
  passwordResetExpiresAt?: Date | null;
}

// ARK-72: excludes 0/O/1/I so a seller reading the code off-screen never
// has to guess which character they're looking at.
const COMPANY_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const COMPANY_CODE_LENGTH = 6;

function generateCompanyCode(): string {
  let code = "";
  for (let i = 0; i < COMPANY_CODE_LENGTH; i++) {
    code += COMPANY_CODE_ALPHABET[randomInt(COMPANY_CODE_ALPHABET.length)];
  }
  return code;
}

/** Prisma's unique-constraint violation (P2002) — duck-typed instead of
 * importing `Prisma.PrismaClientKnownRequestError` to keep this file's only
 * import the plain `PrismaClient` type. */
function isCompanyCodeCollision(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "P2002" &&
    ((err as { meta?: { target?: string[] } }).meta?.target ?? []).includes("companyCode")
  );
}

function toRecord(row: {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
  companyCode: string;
  passwordResetTokenHash?: string | null;
  passwordResetExpiresAt?: Date | null;
}): SellerAuthRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.passwordHash,
    displayName: row.displayName,
    companyCode: row.companyCode,
    passwordResetTokenHash: row.passwordResetTokenHash,
    passwordResetExpiresAt: row.passwordResetExpiresAt,
  };
}

/**
 * ARK-57 seller sign-up/login. Sign-up creates the `Seller` row itself —
 * "create an account" and "create a workspace" are the same action for this
 * MVP (see the doc comment on `Seller.email` in schema.prisma).
 */
export class AuthStore {
  constructor(private readonly prisma: PrismaClient) {}

  async createSeller(input: {
    email: string;
    passwordHash: string;
    displayName: string;
  }): Promise<SellerAuthRecord> {
    // ARK-72: retry on the (astronomically unlikely) companyCode collision.
    // Generate-then-insert rather than check-then-insert since a check has
    // the same race anyway — the DB's unique index is the real guard.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const row = await this.prisma.seller.create({
          data: { ...input, companyCode: generateCompanyCode() },
        });
        return toRecord(row);
      } catch (err) {
        if (isCompanyCodeCollision(err) && attempt < 4) continue;
        throw err;
      }
    }
    /* istanbul ignore next -- unreachable: loop always returns or throws */
    throw new Error("unreachable");
  }

  async findSellerByEmail(email: string): Promise<SellerAuthRecord | null> {
    const row = await this.prisma.seller.findUnique({ where: { email } });
    return row ? toRecord(row) : null;
  }

  /** ARK-72: powers the logged-in topbar's workspace name (`/api/auth/me`). */
  async findSellerById(id: string): Promise<SellerAuthRecord | null> {
    const row = await this.prisma.seller.findUnique({ where: { id } });
    return row ? toRecord(row) : null;
  }

  /** ARK-86: issues (or replaces) the seller's password-reset token. Storing
   * only the hash means a DB read alone never yields a usable token. */
  async setPasswordResetToken(
    sellerId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.prisma.seller.update({
      where: { id: sellerId },
      data: { passwordResetTokenHash: tokenHash, passwordResetExpiresAt: expiresAt },
    });
  }

  /** ARK-86: looks up the seller currently holding this reset-token hash.
   * Caller is responsible for checking `passwordResetExpiresAt` — kept here
   * as a plain lookup, matching `findSellerByEmail`'s shape. */
  async findSellerByResetTokenHash(tokenHash: string): Promise<SellerAuthRecord | null> {
    const row = await this.prisma.seller.findFirst({ where: { passwordResetTokenHash: tokenHash } });
    return row ? toRecord(row) : null;
  }

  /** ARK-86: consumes the pending reset — sets the new password hash and
   * clears the token so it can't be replayed. */
  async resetPassword(sellerId: string, passwordHash: string): Promise<void> {
    await this.prisma.seller.update({
      where: { id: sellerId },
      data: { passwordHash, passwordResetTokenHash: null, passwordResetExpiresAt: null },
    });
  }
}
