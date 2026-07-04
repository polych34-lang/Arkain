import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { connectCoupangSeller } from "../src/connect/coupangSellerConnect.js";
import type { MarketplaceAdapter } from "../src/integrations/marketplace.js";
import type { CredentialStore, StoredCredential } from "../src/secrets/credentialStore.js";

function fakeAdapter(verifyResult: boolean | Error): MarketplaceAdapter {
  return {
    id: "coupang",
    async verifyCredential() {
      if (verifyResult instanceof Error) throw verifyResult;
      return verifyResult;
    },
    async fetchOrders() {
      return { orders: [] };
    },
  };
}

function fakeCredentialStore(): CredentialStore {
  return {
    async put(sellerId, marketplace, secret): Promise<StoredCredential> {
      return {
        sellerId,
        marketplace,
        keyVersion: 1,
        ciphertext: JSON.stringify(secret),
      };
    },
    async get(stored) {
      return JSON.parse(stored.ciphertext) as Record<string, string>;
    },
  };
}

const CREDENTIAL = { vendorId: "vendor-1", accessKey: "ak-1", secretKey: "sk-1" };

describe("connectCoupangSeller", () => {
  it("verifies then stores the encrypted vendorId/accessKey/secretKey credential", async () => {
    const stored: unknown[] = [];
    const result = await connectCoupangSeller(
      {
        adapter: fakeAdapter(true),
        credentialStore: fakeCredentialStore(),
        store: {
          async upsertConnection(tenantId, marketplace, s) {
            stored.push({ tenantId, marketplace, s });
            return { id: "conn-1" };
          },
        },
      },
      "seller-1",
      CREDENTIAL,
    );
    expect(result).toEqual({ ok: true, connectionId: "conn-1" });
    expect(stored).toHaveLength(1);
  });

  it("does not store anything when verification fails", async () => {
    const upsertConnection = vi.fn();
    const result = await connectCoupangSeller(
      { adapter: fakeAdapter(false), credentialStore: fakeCredentialStore(), store: { upsertConnection } },
      "seller-1",
      CREDENTIAL,
    );
    expect(result.ok).toBe(false);
    expect(upsertConnection).not.toHaveBeenCalled();
  });

  it("propagates a transient (retryable) verify error instead of treating it as invalid", async () => {
    const err = new Error("network blip");
    await expect(
      connectCoupangSeller(
        {
          adapter: fakeAdapter(err),
          credentialStore: fakeCredentialStore(),
          store: { upsertConnection: vi.fn() },
        },
        "seller-1",
        CREDENTIAL,
      ),
    ).rejects.toThrow("network blip");
  });
});

describe("POST /api/connections/coupang/connect", () => {
  it("returns 503 when connections aren't configured", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    const res = await app.inject({
      method: "POST",
      url: "/api/connections/coupang/connect",
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("returns 503 when the coupang adapter specifically isn't wired (naver-only connections deps)", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      connections: {
        naverAdapter: fakeAdapter(true),
        credentialStore: fakeCredentialStore(),
        connectionsStore: {
          upsertConnection: async () => ({ id: "c" }),
          listConnectionSummaries: async () => [],
        },
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/connections/coupang/connect",
      payload: { tenantId: "seller-1", ...CREDENTIAL },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("400s when any required field is missing", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      connections: {
        naverAdapter: fakeAdapter(true),
        credentialStore: fakeCredentialStore(),
        connectionsStore: {
          upsertConnection: async () => ({ id: "c" }),
          listConnectionSummaries: async () => [],
        },
        coupangAdapter: fakeAdapter(true),
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/connections/coupang/connect",
      payload: { tenantId: "seller-1", vendorId: "v-1" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("connects successfully and returns a connectionId", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      connections: {
        naverAdapter: fakeAdapter(true),
        credentialStore: fakeCredentialStore(),
        connectionsStore: {
          upsertConnection: async () => ({ id: "conn-42" }),
          listConnectionSummaries: async () => [],
        },
        coupangAdapter: fakeAdapter(true),
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/connections/coupang/connect",
      payload: { tenantId: "seller-1", ...CREDENTIAL },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ connectionId: "conn-42" });
    await app.close();
  });

  it("422s with a Korean message when verification fails", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      connections: {
        naverAdapter: fakeAdapter(true),
        credentialStore: fakeCredentialStore(),
        connectionsStore: {
          upsertConnection: async () => ({ id: "c" }),
          listConnectionSummaries: async () => [],
        },
        coupangAdapter: fakeAdapter(false),
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/connections/coupang/connect",
      payload: { tenantId: "seller-1", ...CREDENTIAL },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/쿠팡/);
    await app.close();
  });
});

describe("GET /onboarding/coupang", () => {
  it("serves the onboarding wizard HTML shell", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    const res = await app.inject({ method: "GET", url: "/onboarding/coupang" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("/api/connections/coupang/connect");
    expect(res.body).toContain("Vendor ID");
    await app.close();
  });
});

describe("GET /connections reconnect links", () => {
  it("links each marketplace's 재연동 button to its own onboarding wizard", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    const res = await app.inject({ method: "GET", url: "/connections" });
    expect(res.body).toContain("/onboarding/naver");
    expect(res.body).toContain("/onboarding/coupang");
    await app.close();
  });
});
