import { describe, expect, it } from "vitest";
import { buildApp, type AuthDeps } from "../src/app.js";
import type { SellerAuthRecord } from "../src/auth/authStore.js";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import { getSessionSellerId } from "../src/auth/session.js";
import type { AlertEvent, AlertNotifier } from "../src/alerting/notifier.js";

const SESSION_SECRET = "test-session-secret";

function fakeAuthDeps(
  seed: SellerAuthRecord[] = [],
  opts: { alerter?: AlertNotifier } = {},
): AuthDeps {
  const sellers = [...seed];
  let nextId = sellers.length + 1;
  return {
    sessionSecret: SESSION_SECRET,
    cookieSecure: false,
    alerter: opts.alerter,
    store: {
      async createSeller(input) {
        const id = `seller-${nextId++}`;
        const row: SellerAuthRecord = { id, companyCode: `CODE${id}`, ...input };
        sellers.push(row);
        return row;
      },
      async findSellerByEmail(email) {
        return sellers.find((s) => s.email === email) ?? null;
      },
      async findSellerById(id) {
        return sellers.find((s) => s.id === id) ?? null;
      },
      async setPasswordResetToken(sellerId, tokenHash, expiresAt) {
        const seller = sellers.find((s) => s.id === sellerId);
        if (seller) {
          seller.passwordResetTokenHash = tokenHash;
          seller.passwordResetExpiresAt = expiresAt;
        }
      },
      async findSellerByResetTokenHash(tokenHash) {
        return sellers.find((s) => s.passwordResetTokenHash === tokenHash) ?? null;
      },
      async resetPassword(sellerId, passwordHash) {
        const seller = sellers.find((s) => s.id === sellerId);
        if (seller) {
          seller.passwordHash = passwordHash;
          seller.passwordResetTokenHash = null;
          seller.passwordResetExpiresAt = null;
        }
      },
    },
  };
}

/** Records every alert instead of sending anywhere — lets tests assert a
 * password-reset request fired (or didn't) without a real webhook. */
function fakeAlerter(): AlertNotifier & { events: AlertEvent[] } {
  const events: AlertEvent[] = [];
  return {
    events,
    async send(event) {
      events.push(event);
    },
  };
}

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value).split(";")[0];
}

describe("POST /api/auth/signup", () => {
  it("returns 503 when auth isn't configured", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { workspaceName: "가게", email: "a@test.com", password: "password1" },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("creates a seller (workspace), issues a companyCode, and sets a session cookie", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      auth: fakeAuthDeps(),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { workspaceName: "아카인 상회", email: "seller@test.com", password: "password1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sellerId).toBeTruthy();
    expect(res.json().companyCode).toBeTruthy();
    const cookie = cookieFrom(res);
    expect(cookie).toContain("arkain_sid=");
    const sellerId = getSessionSellerId({ headers: { cookie } }, SESSION_SECRET);
    expect(sellerId).toBe(res.json().sellerId);
    await app.close();
  });

  it("rejects a duplicate email", async () => {
    const existing: SellerAuthRecord = {
      id: "seller-1",
      email: "dup@test.com",
      passwordHash: "x",
      displayName: "기존 가게",
      companyCode: "CODE1",
    };
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      auth: fakeAuthDeps([existing]),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { workspaceName: "새 가게", email: "dup@test.com", password: "password1" },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("rejects a short password", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      auth: fakeAuthDeps(),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { workspaceName: "가게", email: "a@test.com", password: "short" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("POST /api/auth/login", () => {
  it("logs in with correct companyCode/email/password and sets a session cookie", async () => {
    const passwordHash = await hashPassword("correct-password");
    const seller: SellerAuthRecord = {
      id: "seller-1",
      email: "seller@test.com",
      passwordHash,
      displayName: "가게",
      companyCode: "ABC123",
    };
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      auth: fakeAuthDeps([seller]),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { companyCode: "ABC123", email: "seller@test.com", password: "correct-password" },
    });
    expect(res.statusCode).toBe(200);
    expect(cookieFrom(res)).toContain("arkain_sid=");
    await app.close();
  });

  it("accepts a lowercase companyCode (case-insensitive)", async () => {
    const passwordHash = await hashPassword("correct-password");
    const seller: SellerAuthRecord = {
      id: "seller-1",
      email: "seller@test.com",
      passwordHash,
      displayName: "가게",
      companyCode: "ABC123",
    };
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      auth: fakeAuthDeps([seller]),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { companyCode: "abc123", email: "seller@test.com", password: "correct-password" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects the wrong password", async () => {
    const passwordHash = await hashPassword("correct-password");
    const seller: SellerAuthRecord = {
      id: "seller-1",
      email: "seller@test.com",
      passwordHash,
      displayName: "가게",
      companyCode: "ABC123",
    };
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      auth: fakeAuthDeps([seller]),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { companyCode: "ABC123", email: "seller@test.com", password: "wrong-password" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a mismatched companyCode even with the correct email/password", async () => {
    const passwordHash = await hashPassword("correct-password");
    const seller: SellerAuthRecord = {
      id: "seller-1",
      email: "seller@test.com",
      passwordHash,
      displayName: "가게",
      companyCode: "ABC123",
    };
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      auth: fakeAuthDeps([seller]),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { companyCode: "WRONG1", email: "seller@test.com", password: "correct-password" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects an unknown email", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      auth: fakeAuthDeps(),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { companyCode: "ABC123", email: "nobody@test.com", password: "whatever1" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a missing companyCode", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      auth: fakeAuthDeps(),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "nobody@test.com", password: "whatever1" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("GET /api/auth/me", () => {
  it("returns displayName and companyCode for a valid session", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      auth: fakeAuthDeps(),
    });
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { workspaceName: "아카인 상회", email: "seller@test.com", password: "password1" },
    });
    const cookie = cookieFrom(signup);
    const res = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(res.json()).toMatchObject({
      authenticated: true,
      displayName: "아카인 상회",
      companyCode: signup.json().companyCode,
    });
    await app.close();
  });
});

describe("GET /signup, /login, /sales/calendar, /account-recovery/*", () => {
  it("serve HTML shells", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    for (const url of [
      "/signup",
      "/login",
      "/sales/calendar",
      "/account-recovery",
      "/account-recovery/company-code",
      "/account-recovery/password",
      "/account-recovery/reset",
    ]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
    }
    await app.close();
  });
});

describe("POST /api/auth/find-company-code", () => {
  it("returns 503 when auth isn't configured", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/find-company-code",
      payload: { email: "seller@test.com" },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("returns the companyCode for a registered email", async () => {
    const seller: SellerAuthRecord = {
      id: "seller-1",
      email: "seller@test.com",
      passwordHash: "x",
      displayName: "가게",
      companyCode: "ABC123",
    };
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      auth: fakeAuthDeps([seller]),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/find-company-code",
      payload: { email: "seller@test.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().companyCode).toBe("ABC123");
    await app.close();
  });

  it("404s for an unregistered email", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      auth: fakeAuthDeps(),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/find-company-code",
      payload: { email: "nobody@test.com" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("rate-limits repeated lookups for the same email", async () => {
    const seller: SellerAuthRecord = {
      id: "seller-1",
      email: "seller@test.com",
      passwordHash: "x",
      displayName: "가게",
      companyCode: "ABC123",
    };
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      auth: fakeAuthDeps([seller]),
    });
    let lastStatus = 0;
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/find-company-code",
        payload: { email: "seller@test.com" },
      });
      lastStatus = res.statusCode;
    }
    expect(lastStatus).toBe(429);
    await app.close();
  });
});

describe("POST /api/auth/forgot-password/request", () => {
  it("stores a hashed reset token and alerts ops on a valid companyCode+email match", async () => {
    const seller: SellerAuthRecord = {
      id: "seller-1",
      email: "seller@test.com",
      passwordHash: "x",
      displayName: "가게",
      companyCode: "ABC123",
    };
    const alerter = fakeAlerter();
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      auth: fakeAuthDeps([seller], { alerter }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/forgot-password/request",
      payload: { companyCode: "ABC123", email: "seller@test.com" },
    });
    expect(res.statusCode).toBe(200);
    // The token itself is never in the HTTP response — only in the ops alert.
    expect(res.json()).not.toHaveProperty("token");
    expect(res.json()).not.toHaveProperty("resetToken");
    expect(alerter.events).toHaveLength(1);
    expect(alerter.events[0].category).toBe("password_reset");
    expect(seller.passwordResetTokenHash).toBeTruthy();
    await app.close();
  });

  it("gives the exact same response for a non-matching companyCode/email, and fires no alert", async () => {
    const seller: SellerAuthRecord = {
      id: "seller-1",
      email: "seller@test.com",
      passwordHash: "x",
      displayName: "가게",
      companyCode: "ABC123",
    };
    const alerter = fakeAlerter();
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      auth: fakeAuthDeps([seller], { alerter }),
    });
    const matched = await app.inject({
      method: "POST",
      url: "/api/auth/forgot-password/request",
      payload: { companyCode: "ABC123", email: "seller@test.com" },
    });
    const unmatched = await app.inject({
      method: "POST",
      url: "/api/auth/forgot-password/request",
      payload: { companyCode: "WRONG1", email: "nobody@test.com" },
    });
    expect(unmatched.statusCode).toBe(matched.statusCode);
    expect(unmatched.json()).toEqual(matched.json());
    expect(alerter.events).toHaveLength(1);
    await app.close();
  });

  it("rate-limits repeated requests for the same companyCode+email pair", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      auth: fakeAuthDeps(),
    });
    let lastStatus = 0;
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/forgot-password/request",
        payload: { companyCode: "ABC123", email: "seller@test.com" },
      });
      lastStatus = res.statusCode;
    }
    expect(lastStatus).toBe(429);
    await app.close();
  });
});

describe("POST /api/auth/forgot-password/reset", () => {
  async function requestReset(
    app: ReturnType<typeof buildApp>["app"],
    alerter: ReturnType<typeof fakeAlerter>,
  ): Promise<string> {
    await app.inject({
      method: "POST",
      url: "/api/auth/forgot-password/request",
      payload: { companyCode: "ABC123", email: "seller@test.com" },
    });
    const context = alerter.events.at(-1)?.context as { resetToken: string };
    return context.resetToken;
  }

  it("resets the password with a valid token and lets the seller log in with it", async () => {
    const passwordHash = await hashPassword("old-password");
    const seller: SellerAuthRecord = {
      id: "seller-1",
      email: "seller@test.com",
      passwordHash,
      displayName: "가게",
      companyCode: "ABC123",
    };
    const alerter = fakeAlerter();
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      auth: fakeAuthDeps([seller], { alerter }),
    });
    const token = await requestReset(app, alerter);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/forgot-password/reset",
      payload: { token, password: "new-password1" },
    });
    expect(res.statusCode).toBe(200);
    expect(await verifyPassword("new-password1", seller.passwordHash)).toBe(true);
    expect(seller.passwordResetTokenHash).toBeFalsy();

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { companyCode: "ABC123", email: "seller@test.com", password: "new-password1" },
    });
    expect(login.statusCode).toBe(200);
    await app.close();
  });

  it("rejects an invalid token", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      auth: fakeAuthDeps(),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/forgot-password/reset",
      payload: { token: "not-a-real-token", password: "new-password1" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects reusing a token a second time", async () => {
    const passwordHash = await hashPassword("old-password");
    const seller: SellerAuthRecord = {
      id: "seller-1",
      email: "seller@test.com",
      passwordHash,
      displayName: "가게",
      companyCode: "ABC123",
    };
    const alerter = fakeAlerter();
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      auth: fakeAuthDeps([seller], { alerter }),
    });
    const token = await requestReset(app, alerter);

    const first = await app.inject({
      method: "POST",
      url: "/api/auth/forgot-password/reset",
      payload: { token, password: "new-password1" },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/api/auth/forgot-password/reset",
      payload: { token, password: "another-password1" },
    });
    expect(second.statusCode).toBe(401);
    await app.close();
  });

  it("rejects an expired token", async () => {
    const passwordHash = await hashPassword("old-password");
    const seller: SellerAuthRecord = {
      id: "seller-1",
      email: "seller@test.com",
      passwordHash,
      displayName: "가게",
      companyCode: "ABC123",
    };
    const alerter = fakeAlerter();
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      auth: fakeAuthDeps([seller], { alerter }),
    });
    const token = await requestReset(app, alerter);
    // Simulate expiry without depending on real wall-clock time.
    seller.passwordResetExpiresAt = new Date(Date.now() - 1000);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/forgot-password/reset",
      payload: { token, password: "new-password1" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("GET /api/orders with auth configured", () => {
  it("requires a session", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      store: { async listOrders() { return []; } },
      auth: fakeAuthDeps(),
    });
    const res = await app.inject({ method: "GET", url: "/api/orders" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("scopes orders to the session's sellerId, ignoring any other filter", async () => {
    const seenFilters: Array<{ tenantId?: string }> = [];
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      store: {
        async listOrders(filter = {}) {
          seenFilters.push(filter);
          return [];
        },
      },
      auth: fakeAuthDeps(),
    });
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { workspaceName: "가게", email: "seller@test.com", password: "password1" },
    });
    const cookie = cookieFrom(signup);
    const sellerId = signup.json().sellerId;

    const res = await app.inject({
      method: "GET",
      url: "/api/orders?tenantId=someone-elses-id",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(seenFilters[0].tenantId).toBe(sellerId);
    await app.close();
  });
});
