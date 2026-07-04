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
}): SellerAuthRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.passwordHash,
    displayName: row.displayName,
    companyCode: row.companyCode,
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
}
