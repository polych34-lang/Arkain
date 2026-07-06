import { randomBytes, createHash } from "node:crypto";

/**
 * ARK-86: 비밀번호 재설정 토큰. Stored only as a SHA-256 hash (`Seller.
 * passwordResetTokenHash`), same "never persist the raw secret" posture as
 * `passwordHash` — a DB read alone can't be used to reset a seller's password.
 */
export const PASSWORD_RESET_TOKEN_TTL_MS = 15 * 60 * 1000;

export function generatePasswordResetToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashPasswordResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
