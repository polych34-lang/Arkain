import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { loadEnv, redactedConfig } from "./config/env.js";
import { createLogger } from "./logging/logger.js";
import type {
  ConnectionSummary,
  OrderListFilter,
  OrderListItem,
} from "./domain/repository.js";
import type { UnifiedOrderStatus } from "./domain/status.js";
import type { MarketplaceAdapter, MarketplaceId } from "./integrations/marketplace.js";
import type { SyncSummary } from "./sync/orderSyncEngine.js";
import { renderOrdersDashboard } from "./web/ordersDashboard.js";
import { renderNaverOnboarding } from "./web/naverOnboarding.js";
import { renderConnectionsDashboard } from "./web/connectionsDashboard.js";
import {
  connectNaverSeller,
  type ConnectionsWriteStore,
} from "./connect/naverSellerConnect.js";
import type { CredentialStore } from "./secrets/credentialStore.js";
import { MissingPriceError } from "./domain/b2b/pricing.js";
import { InvalidTransitionError } from "./domain/b2b/purchaseOrderStateMachine.js";
import type {
  Account,
  CreateAccountInput,
  CreatePurchaseOrderInput,
  PurchaseOrder,
  PurchaseOrderListFilter,
} from "./domain/b2b/types.js";

/** The dashboard's read dependency — `PrismaDomainStore` satisfies this
 * structurally. Kept narrow so tests can supply an in-memory fake. */
export interface OrderReadStore {
  listOrders(filter?: OrderListFilter): Promise<OrderListItem[]>;
}

/** ARK-21 seller self-service connect surface — `PrismaDomainStore` satisfies
 * this structurally alongside `ConnectionsWriteStore`. */
export interface ConnectionsDeps {
  naverAdapter: MarketplaceAdapter;
  credentialStore: CredentialStore;
  connectionsStore: ConnectionsWriteStore & {
    listConnectionSummaries(tenantId: string): Promise<ConnectionSummary[]>;
  };
  /** Deep link to Naver's SELLER-mode consent screen. Undefined until
   * SellerDesk's solution-provider registration is approved (business/legal
   * step, out of this issue's scope) — the onboarding UI degrades honestly
   * to a manual account-id fallback rather than fabricating a link. */
  naverConsentUrl?: string;
}

/** ARK-16 B2B module surface — `B2BStore` satisfies this structurally. */
export interface B2BStoreDeps {
  createAccount(input: CreateAccountInput): Promise<Account>;
  listAccounts(tenantId: string): Promise<Account[]>;
  upsertPriceListEntry(
    tenantId: string,
    entry: { accountId: string; sku: string; productName: string; unitPriceKrw: number },
  ): Promise<void>;
  createPurchaseOrder(input: CreatePurchaseOrderInput): Promise<PurchaseOrder>;
  listPurchaseOrders(filter: PurchaseOrderListFilter): Promise<PurchaseOrder[]>;
  submitPurchaseOrder(tenantId: string, id: string): Promise<PurchaseOrder>;
  approvePurchaseOrder(tenantId: string, id: string): Promise<PurchaseOrder>;
  rejectPurchaseOrder(tenantId: string, id: string, reason: string): Promise<PurchaseOrder>;
}

export interface BuildAppDeps {
  /** Order read path. Omitted when `DATABASE_URL` isn't configured (or in
   * tests that don't need it) — routes then report `configured: false`. */
  store?: OrderReadStore;
  /** Triggers one sync cycle on demand (demo/ops convenience alongside the
   * scheduler). Omitted the same way `store` is. */
  runSync?: () => Promise<SyncSummary[]>;
  /** B2B (ARK-16) read/write path. Omitted the same way `store` is. */
  b2bStore?: B2BStoreDeps;
  /** Seller self-service Naver connect (ARK-21). Omitted the same way `store` is. */
  connections?: ConnectionsDeps;
}

const VALID_STATUSES = new Set<UnifiedOrderStatus>([
  "PENDING",
  "PAID",
  "DISPATCHED",
  "DELIVERED",
  "CONFIRMED",
  "CANCELLED",
  "RETURNED",
  "EXCHANGED",
  "MIXED",
  "UNKNOWN",
]);
const VALID_MARKETPLACES = new Set<MarketplaceId>([
  "naver_smartstore",
  "coupang",
  "eleven_st",
]);

function parseOrderFilter(query: Record<string, unknown>): OrderListFilter {
  const filter: OrderListFilter = {};
  const marketplace = query.marketplace;
  if (typeof marketplace === "string" && VALID_MARKETPLACES.has(marketplace as MarketplaceId)) {
    filter.marketplace = marketplace as MarketplaceId;
  }
  const status = query.status;
  if (typeof status === "string" && VALID_STATUSES.has(status as UnifiedOrderStatus)) {
    filter.status = status as UnifiedOrderStatus;
  }
  const limit = Number(query.limit);
  if (Number.isInteger(limit) && limit > 0) filter.limit = limit;
  return filter;
}

/**
 * Construct the Fastify app with routes wired but no network listener bound.
 * Kept separate from `main.ts` so tests can exercise routes via `app.inject()`.
 * Return type is inferred so the pino logger's concrete type flows through.
 */
export function buildApp(
  env: NodeJS.ProcessEnv = process.env,
  deps: BuildAppDeps = {},
) {
  const config = loadEnv(env);
  const logger = createLogger(config);

  const app = Fastify({ loggerInstance: logger });

  app.get("/health", async () => ({
    status: "ok",
    service: "arkain",
    env: config.NODE_ENV,
    // Liveness only. Readiness (DB, marketplace reachability) is added with
    // those subsystems in ENG-Domain-Model / ENG-Naver-Spike.
    checks: { process: "ok" },
  }));

  app.get("/", async () => ({
    name: "ARKAIN",
    description: "Multi-market seller management — order-sync MVP",
    docs: "/health",
    dashboard: "/orders",
    onboarding: "/onboarding/naver",
    connections: "/connections",
  }));

  // --- ENG-Orders-MVP (ARK-5): the unified order dashboard --------------
  app.get("/api/orders", async (req) => {
    if (!deps.store) {
      return { configured: false, orders: [] as OrderListItem[] };
    }
    const filter = parseOrderFilter(req.query as Record<string, unknown>);
    const orders = await deps.store.listOrders(filter);
    return { configured: true, orders };
  });

  app.get("/orders", async (_req, reply) => {
    reply.type("text/html; charset=utf-8");
    return renderOrdersDashboard();
  });

  app.post("/api/sync/run", async (_req, reply) => {
    if (!deps.runSync) {
      reply.code(503);
      return { error: "sync engine not configured (DATABASE_URL/CREDENTIAL_ENC_KEY unset)" };
    }
    const results = await deps.runSync();
    return { results };
  });

  // --- Seller self-service Naver connect (ARK-21) ------------------------
  app.get("/onboarding/naver", async (_req, reply) => {
    reply.type("text/html; charset=utf-8");
    return renderNaverOnboarding({ consentUrl: deps.connections?.naverConsentUrl });
  });

  app.get("/connections", async (_req, reply) => {
    reply.type("text/html; charset=utf-8");
    return renderConnectionsDashboard();
  });

  app.get("/api/connections", async (req, reply) => {
    const tenantId = (req.query as Record<string, unknown>).tenantId;
    if (typeof tenantId !== "string" || !tenantId) {
      reply.code(400);
      return { error: "tenantId query param is required" };
    }
    if (!deps.connections) {
      return { configured: false, connections: [] as ConnectionSummary[] };
    }
    const connections = await deps.connections.connectionsStore.listConnectionSummaries(tenantId);
    return { configured: true, connections };
  });

  app.post("/api/connections/naver/connect", async (req, reply) => {
    if (!deps.connections) {
      reply.code(503);
      return { error: "연동이 아직 설정되지 않았습니다 (DATABASE_URL/CREDENTIAL_ENC_KEY 미설정)" };
    }
    const body = (req.body ?? {}) as { tenantId?: string; accountId?: string };
    if (!body.tenantId || !body.accountId) {
      reply.code(400);
      return { error: "tenantId and accountId are required" };
    }
    const result = await connectNaverSeller(
      {
        adapter: deps.connections.naverAdapter,
        credentialStore: deps.connections.credentialStore,
        store: deps.connections.connectionsStore,
      },
      body.tenantId,
      body.accountId.trim(),
    );
    if (!result.ok) {
      reply.code(422);
      return { error: result.error };
    }
    return { connectionId: result.connectionId };
  });

  // --- B2B module (ARK-16): 거래처(Account) + 대량발주(PurchaseOrder) -------
  //
  // No auth/session layer yet (ADR-0002 §2d gap, not re-litigated here), so
  // `tenantId` is taken as an explicit request field for now, same interim
  // posture as the rest of the pre-auth API surface.
  if (deps.b2bStore) {
    const b2bStore = deps.b2bStore;

    app.post("/api/b2b/accounts", async (req, reply) => {
      const body = req.body as Partial<CreateAccountInput>;
      if (!body.tenantId || !body.name) {
        reply.code(400);
        return { error: "tenantId and name are required" };
      }
      const account = await b2bStore.createAccount(body as CreateAccountInput);
      return { account };
    });

    app.get("/api/b2b/accounts", async (req, reply) => {
      const tenantId = (req.query as Record<string, unknown>).tenantId;
      if (typeof tenantId !== "string") {
        reply.code(400);
        return { error: "tenantId query param is required" };
      }
      const accounts = await b2bStore.listAccounts(tenantId);
      return { accounts };
    });

    app.post("/api/b2b/accounts/:accountId/prices", async (req, reply) => {
      const { accountId } = req.params as { accountId: string };
      const body = req.body as {
        tenantId?: string;
        sku?: string;
        productName?: string;
        unitPriceKrw?: number;
      };
      if (!body.tenantId || !body.sku || !body.productName || body.unitPriceKrw == null) {
        reply.code(400);
        return { error: "tenantId, sku, productName, unitPriceKrw are required" };
      }
      await b2bStore.upsertPriceListEntry(body.tenantId, {
        accountId,
        sku: body.sku,
        productName: body.productName,
        unitPriceKrw: body.unitPriceKrw,
      });
      return { ok: true };
    });

    app.post("/api/b2b/purchase-orders", async (req, reply) => {
      const body = req.body as Partial<CreatePurchaseOrderInput>;
      if (!body.tenantId || !body.accountId || !body.lines?.length) {
        reply.code(400);
        return { error: "tenantId, accountId, and at least one line are required" };
      }
      try {
        const order = await b2bStore.createPurchaseOrder(body as CreatePurchaseOrderInput);
        return { order };
      } catch (err) {
        if (err instanceof MissingPriceError) {
          reply.code(422);
          return { error: err.message };
        }
        throw err;
      }
    });

    app.get("/api/b2b/purchase-orders", async (req, reply) => {
      const query = req.query as Record<string, unknown>;
      if (typeof query.tenantId !== "string") {
        reply.code(400);
        return { error: "tenantId query param is required" };
      }
      const filter: PurchaseOrderListFilter = { tenantId: query.tenantId };
      if (typeof query.accountId === "string") filter.accountId = query.accountId;
      if (typeof query.status === "string") {
        filter.status = query.status as PurchaseOrderListFilter["status"];
      }
      const orders = await b2bStore.listPurchaseOrders(filter);
      return { orders };
    });

    const transitionHandler =
      (
        run: (tenantId: string, id: string, body: Record<string, unknown>) => Promise<PurchaseOrder>,
      ) =>
      async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const body = (req.body ?? {}) as { tenantId?: string; reason?: string };
        if (!body.tenantId) {
          reply.code(400);
          return { error: "tenantId is required" };
        }
        try {
          const order = await run(body.tenantId, id, body);
          return { order };
        } catch (err) {
          if (err instanceof InvalidTransitionError) {
            reply.code(409);
            return { error: err.message };
          }
          throw err;
        }
      };

    app.post(
      "/api/b2b/purchase-orders/:id/submit",
      transitionHandler((tenantId, id) => b2bStore.submitPurchaseOrder(tenantId, id)),
    );
    app.post(
      "/api/b2b/purchase-orders/:id/approve",
      transitionHandler((tenantId, id) => b2bStore.approvePurchaseOrder(tenantId, id)),
    );
    app.post(
      "/api/b2b/purchase-orders/:id/reject",
      transitionHandler((tenantId, id, body) =>
        b2bStore.rejectPurchaseOrder(tenantId, id, (body.reason as string) ?? ""),
      ),
    );
  }

  logger.info({ config: redactedConfig(config) }, "ARKAIN app constructed");
  return { app, config };
}

export type BuildAppResult = ReturnType<typeof buildApp>;
