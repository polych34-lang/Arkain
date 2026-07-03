import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * ARK-57: minimal seller session — an HMAC-signed cookie holding the
 * `Seller.id`, no server-side session store. Deliberately no new dependency
 * (`@fastify/cookie` etc.) for this MVP-sized surface: reading/writing one
 * cookie is a handful of pure functions, matching the "no premature
 * abstraction" posture the rest of this codebase (ordersDashboard.ts et al.)
 * already takes with its own thin, dependency-free interim UI layer.
 */
export const SESSION_COOKIE_NAME = "arkain_sid";

function sign(sellerId: string, secret: string): string {
  return createHmac("sha256", secret).update(sellerId).digest("hex");
}

export function signSessionValue(sellerId: string, secret: string): string {
  return `${sellerId}.${sign(sellerId, secret)}`;
}

/** Returns the sellerId if the cookie value is well-formed and its signature
 * matches, otherwise null (never throws on malformed/tampered input). */
export function verifySessionValue(value: string | undefined, secret: string): string | null {
  if (!value) return null;
  const sepIndex = value.lastIndexOf(".");
  if (sepIndex <= 0) return null;
  const sellerId = value.slice(0, sepIndex);
  const providedSig = value.slice(sepIndex + 1);
  const expectedSig = sign(sellerId, secret);
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return sellerId;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const sep = part.indexOf("=");
    if (sep < 0) continue;
    out[part.slice(0, sep).trim()] = decodeURIComponent(part.slice(sep + 1).trim());
  }
  return out;
}

/** Reads and verifies the session cookie off a Fastify-shaped request. */
export function getSessionSellerId(
  req: { headers: { cookie?: string } },
  secret: string,
): string | null {
  const cookies = parseCookies(req.headers.cookie);
  return verifySessionValue(cookies[SESSION_COOKIE_NAME], secret);
}

export function sessionSetCookieHeader(
  sellerId: string,
  secret: string,
  opts: { secure: boolean },
): string {
  const value = signSessionValue(sellerId, secret);
  const attrs = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${60 * 60 * 24 * 30}`, // 30 days
  ];
  if (opts.secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function sessionClearCookieHeader(opts: { secure: boolean }): string {
  const attrs = [`${SESSION_COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (opts.secure) attrs.push("Secure");
  return attrs.join("; ");
}
