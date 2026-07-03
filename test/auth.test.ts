import { describe, expect, it } from "vitest";
import { buildApp, type AuthDeps } from "../src/app.js";
import type { SellerAuthRecord } from "../src/auth/authStore.js";
import { hashPassword } from "../src/auth/password.js";
import { getSessionSellerId } from "../src/auth/session.js";

const SESSION_SECRET = "test-session-secret";

function fakeAuthDeps(seed: SellerAuthRecord[] = []): AuthDeps {
  const sellers = [...seed];
  let nextId = sellers.length + 1;
  return {
    sessionSecret: SESSION_SECRET,
    cookieSecure: false,
    store: {
      async createSeller(input) {
        const row: SellerAuthRecord = { id: `seller-${nextId++}`, ...input };
        sellers.push(row);
        return row;
      },
      async findSellerByEmail(email) {
        return sellers.find((s) => s.email === email) ?? null;
      },
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

  it("creates a seller (workspace) and sets a session cookie", async () => {
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
  it("logs in with correct credentials and sets a session cookie", async () => {
    const passwordHash = await hashPassword("correct-password");
    const seller: SellerAuthRecord = {
      id: "seller-1",
      email: "seller@test.com",
      passwordHash,
      displayName: "가게",
    };
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      auth: fakeAuthDeps([seller]),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "seller@test.com", password: "correct-password" },
    });
    expect(res.statusCode).toBe(200);
    expect(cookieFrom(res)).toContain("arkain_sid=");
    await app.close();
  });

  it("rejects the wrong password", async () => {
    const passwordHash = await hashPassword("correct-password");
    const seller: SellerAuthRecord = {
      id: "seller-1",
      email: "seller@test.com",
      passwordHash,
      displayName: "가게",
    };
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      auth: fakeAuthDeps([seller]),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "seller@test.com", password: "wrong-password" },
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
      payload: { email: "nobody@test.com", password: "whatever1" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("GET /signup, /login", () => {
  it("serve HTML shells", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    for (const url of ["/signup", "/login"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
    }
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
