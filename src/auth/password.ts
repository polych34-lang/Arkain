import bcrypt from "bcryptjs";

/** ARK-57: seller login password hashing. Same `bcryptjs` dependency the
 * Naver adapter already uses (src/integrations/naver/naver.http.ts) for its
 * OAuth signing — no new dependency added for this. */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
