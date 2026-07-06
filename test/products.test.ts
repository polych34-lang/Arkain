import { describe, expect, it } from "vitest";
import { buildApp, type AuthDeps, type ProductsDeps } from "../src/app.js";
import type { ProductListItem } from "../src/domain/repository.js";

const SESSION_SECRET = "test-session-secret";

function fakeAuthDeps(): AuthDeps {
  return {
    sessionSecret: SESSION_SECRET,
    cookieSecure: false,
    store: {
      async createSeller(input) {
        return { id: "seller-1", companyCode: "CODE1", ...input };
      },
      async findSellerByEmail() {
        return null;
      },
      async findSellerById() {
        return null;
      },
      async setPasswordResetToken() {},
      async findSellerByResetTokenHash() {
        return null;
      },
      async resetPassword() {},
    },
  };
}

function fakeProductsDeps(seed: Record<string, ProductListItem[]> = {}): ProductsDeps {
  const byTenant = new Map(Object.entries(seed));
  let nextId = 1;
  return {
    store: {
      async createManualProduct(tenantId, input) {
        const product: ProductListItem = {
          id: `product-${nextId++}`,
          name: input.name,
          salePriceKrw: input.salePriceKrw,
          stockQuantity: input.stockQuantity,
          status: input.stockQuantity > 0 ? "ON_SALE" : "OUT_OF_STOCK",
          createdAt: "2026-07-03T00:00:00.000Z",
        };
        byTenant.set(tenantId, [...(byTenant.get(tenantId) ?? []), product]);
        return product;
      },
      async listProducts(tenantId) {
        return byTenant.get(tenantId) ?? [];
      },
    },
  };
}

async function signupAndGetCookie(app: ReturnType<typeof buildApp>["app"]): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { workspaceName: "가게", email: "seller@test.com", password: "password1" },
  });
  const raw = res.headers["set-cookie"];
  return String(Array.isArray(raw) ? raw[0] : raw).split(";")[0];
}

describe("GET /products", () => {
  it("serves the dashboard HTML shell", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    const res = await app.inject({ method: "GET", url: "/products" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("/api/products");
    await app.close();
  });
});

describe("GET /api/products", () => {
  it("reports configured: false when auth/products aren't wired", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    const res = await app.inject({ method: "GET", url: "/api/products" });
    expect(res.json()).toEqual({ configured: false, products: [] });
    await app.close();
  });

  it("requires a session", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      auth: fakeAuthDeps(),
      products: fakeProductsDeps(),
    });
    const res = await app.inject({ method: "GET", url: "/api/products" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("POST /api/products", () => {
  it("registers a product for the logged-in seller and lists it back", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      auth: fakeAuthDeps(),
      products: fakeProductsDeps(),
    });
    const cookie = await signupAndGetCookie(app);

    const create = await app.inject({
      method: "POST",
      url: "/api/products",
      headers: { cookie },
      payload: { name: "유기농 현미 2kg", salePriceKrw: 19000, stockQuantity: 50 },
    });
    expect(create.statusCode).toBe(200);
    expect(create.json().product.name).toBe("유기농 현미 2kg");

    const list = await app.inject({ method: "GET", url: "/api/products", headers: { cookie } });
    expect(list.json().configured).toBe(true);
    expect(list.json().products).toHaveLength(1);
    await app.close();
  });

  it("requires a session", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      auth: fakeAuthDeps(),
      products: fakeProductsDeps(),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/products",
      payload: { name: "상품", salePriceKrw: 1000, stockQuantity: 1 },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a missing name", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      auth: fakeAuthDeps(),
      products: fakeProductsDeps(),
    });
    const cookie = await signupAndGetCookie(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/products",
      headers: { cookie },
      payload: { salePriceKrw: 1000, stockQuantity: 1 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a negative price", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      auth: fakeAuthDeps(),
      products: fakeProductsDeps(),
    });
    const cookie = await signupAndGetCookie(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/products",
      headers: { cookie },
      payload: { name: "상품", salePriceKrw: -1, stockQuantity: 1 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
