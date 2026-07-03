import type { PrismaClient } from "@prisma/client";

/** ARK-57: seller login identity. Never includes the plaintext password. */
export interface SellerAuthRecord {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
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
    const row = await this.prisma.seller.create({ data: input });
    return {
      id: row.id,
      email: row.email,
      passwordHash: row.passwordHash,
      displayName: row.displayName,
    };
  }

  async findSellerByEmail(email: string): Promise<SellerAuthRecord | null> {
    const row = await this.prisma.seller.findUnique({ where: { email } });
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      passwordHash: row.passwordHash,
      displayName: row.displayName,
    };
  }
}
