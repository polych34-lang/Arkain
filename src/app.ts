import Fastify from "fastify";
import { loadEnv, redactedConfig } from "./config/env.js";
import { createLogger } from "./logging/logger.js";
import type {
  OrderListFilter,
  OrderListItem,
} from "./domain/repository.js";
import type { UnifiedOrderStatus } from "./domain/status.js";
import type { MarketplaceId } from "./integrations/marketplace.js";
import type { SyncSummary } from "./sync/orderSyncEngine.js";
import { renderOrdersDashboard } from "./web/ordersDashboard.js";

/** The dashboard's read dependency — `PrismaDomainStore` satisfies this
 * structurally. Kept narrow so tests can supply an in-memory fake. */
export interface OrderReadStore {
  listOrders(filter?: OrderListFilter): Promise<OrderListItem[]>;
}

export interface BuildAppDeps {
  /** Order read path. Omitted when `DATABASE_URL` isn't configured (or in
   * tests that don't need it) — routes then report `configured: false`. */
  store?: OrderReadStore;
  /** Triggers one sync cycle on demand (demo/ops convenience alongside the
   * scheduler). Omitted the same way `store` is. */
  runSync?: () => Promise<SyncSummary[]>;
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

  logger.info({ config: redactedConfig(config) }, "ARKAIN app constructed");
  return { app, config };
}

export type BuildAppResult = ReturnType<typeof buildApp>;
