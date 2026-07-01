import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { connectNaverSeller } from "../src/connect/naverSellerConnect.js";
import type { MarketplaceAdapter } from "../src/integrations/marketplace.js";
import type { CredentialStore, StoredCredential } from "../src/secrets/credentialStore.js";
import type { ConnectionSummary } from "../src/domain/repository.js";

function fakeAdapter(verifyResult: boolean | Error): MarketplaceAdapter {
  return {
    id: "naver_smartstore",
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

describe("connectNaverSeller", () => {
  it("verifies then stores the encrypted accountId credential", async () => {
    const stored: unknown[] = [];
    const result = await connectNaverSeller(
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
      "acc-1",
    );
    expect(result).toEqual({ ok: true, connectionId: "conn-1" });
    expect(stored).toHaveLength(1);
  });

  it("does not store anything when verification fails", async () => {
    const upsertConnection = vi.fn();
    const result = await connectNaverSeller(
      { adapter: fakeAdapter(false), credentialStore: fakeCredentialStore(), store: { upsertConnection } },
      "seller-1",
      "bad-id",
    );
    expect(result.ok).toBe(false);
    expect(upsertConnection).not.toHaveBeenCalled();
  });

  it("propagates a transient (retryable) verify error instead of treating it as invalid", async () => {
    const err = new Error("network blip");
    await expect(
      connectNaverSeller(
        {
          adapter: fakeAdapter(err),
          credentialStore: fakeCredentialStore(),
          store: { upsertConnection: vi.fn() },
        },
        "seller-1",
        "acc-1",
      ),
    ).rejects.toThrow("network blip");
  });
});

describe("POST /api/connections/naver/connect", () => {
  it("returns 503 when connections aren't configured", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    const res = await app.inject({
      method: "POST",
      url: "/api/connections/naver/connect",
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("400s when tenantId/accountId are missing", async () => {
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
      url: "/api/connections/naver/connect",
      payload: {},
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
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/connections/naver/connect",
      payload: { tenantId: "seller-1", accountId: "acc-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ connectionId: "conn-42" });
    await app.close();
  });

  it("422s with a Korean message when verification fails", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      connections: {
        naverAdapter: fakeAdapter(false),
        credentialStore: fakeCredentialStore(),
        connectionsStore: {
          upsertConnection: async () => ({ id: "c" }),
          listConnectionSummaries: async () => [],
        },
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/connections/naver/connect",
      payload: { tenantId: "seller-1", accountId: "bad" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/연결/);
    await app.close();
  });
});

describe("GET /api/connections", () => {
  it("reports configured:false when connections deps are absent", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    const res = await app.inject({ method: "GET", url: "/api/connections?tenantId=seller-1" });
    expect(res.json()).toEqual({ configured: false, connections: [] });
    await app.close();
  });

  it("400s without a tenantId query param", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    const res = await app.inject({ method: "GET", url: "/api/connections" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("lists connection summaries for the given tenant", async () => {
    const summary: ConnectionSummary = {
      id: "conn-1",
      marketplace: "naver_smartstore",
      status: "active",
      createdAt: "2026-07-01T00:00:00.000Z",
      lastSyncedAt: null,
      lastSyncStatus: null,
    };
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      connections: {
        naverAdapter: fakeAdapter(true),
        credentialStore: fakeCredentialStore(),
        connectionsStore: {
          upsertConnection: async () => ({ id: "c" }),
          listConnectionSummaries: async () => [summary],
        },
      },
    });
    const res = await app.inject({ method: "GET", url: "/api/connections?tenantId=seller-1" });
    expect(res.json()).toEqual({ configured: true, connections: [summary] });
    await app.close();
  });
});

describe("GET /onboarding/naver and GET /connections", () => {
  it("serve the onboarding wizard and management dashboard HTML shells", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv);

    const onboarding = await app.inject({ method: "GET", url: "/onboarding/naver" });
    expect(onboarding.statusCode).toBe(200);
    expect(onboarding.headers["content-type"]).toMatch(/text\/html/);
    expect(onboarding.body).toContain("/api/connections/naver/connect");
    expect(onboarding.body).toContain("준비 중");

    const connections = await app.inject({ method: "GET", url: "/connections" });
    expect(connections.statusCode).toBe(200);
    expect(connections.body).toContain("/api/connections");

    await app.close();
  });

  it("shows the consent button instead of the manual fallback once a consent URL is configured", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      connections: {
        naverAdapter: fakeAdapter(true),
        credentialStore: fakeCredentialStore(),
        connectionsStore: {
          upsertConnection: async () => ({ id: "c" }),
          listConnectionSummaries: async () => [],
        },
        naverConsentUrl: "https://apicenter.commerce.naver.com/consent/sellerdesk",
      },
    });
    const res = await app.inject({ method: "GET", url: "/onboarding/naver" });
    expect(res.body).toContain("https://apicenter.commerce.naver.com/consent/sellerdesk");
    await app.close();
  });
});
