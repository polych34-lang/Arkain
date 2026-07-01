import { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import { buildApp, type BuildAppDeps } from "./app.js";
import { loadEnv } from "./config/env.js";
import { PrismaDomainStore } from "./domain/repository.js";
import { NaverSmartstoreAdapter } from "./integrations/naver/naver.adapter.js";
import { EsmAdapter } from "./integrations/esm/esm.adapter.js";
import type { MarketplaceAdapter, MarketplaceId } from "./integrations/marketplace.js";
import { createLogger } from "./logging/logger.js";
import { EnvelopeCredentialStore } from "./secrets/credentialStore.js";
import { OrderSyncEngine, type SyncConnection } from "./sync/orderSyncEngine.js";

/**
 * Assemble the order-sync engine + dashboard read path when persistence is
 * configured. Both `DATABASE_URL` and `CREDENTIAL_ENC_KEY` are optional at
 * boot (env.ts) so the skeleton still runs without them — this is the one
 * place that upgrades from "no DB" to "wired for real sync".
 */
function buildSyncDeps(
  config: ReturnType<typeof loadEnv>,
  log: Logger,
): {
  deps: BuildAppDeps;
  stopScheduler?: () => void;
} {
  if (!config.DATABASE_URL || !config.CREDENTIAL_ENC_KEY) {
    return { deps: {} };
  }

  const prisma = new PrismaClient();
  const store = new PrismaDomainStore(prisma);
  const credentialStore = new EnvelopeCredentialStore(config.CREDENTIAL_ENC_KEY);

  const adapters: Partial<Record<MarketplaceId, MarketplaceAdapter>> = {
    naver_smartstore: new NaverSmartstoreAdapter({
      baseUrl: config.NAVER_COMMERCE_BASE_URL,
      clientId: config.NAVER_COMMERCE_CLIENT_ID,
      clientSecret: config.NAVER_COMMERCE_CLIENT_SECRET,
    }),
    // ESM 2.0 (ARK-11): no app-level key (per-seller only, see env.ts), so
    // this is always safe to register — a connection simply can't be synced
    // until its per-seller credential is stored via CredentialStore.
    esm_2_0: new EsmAdapter({ baseUrl: config.ESM_API_BASE_URL }),
  };

  const engine = new OrderSyncEngine(adapters, store, {
    defaultSinceDays: config.NAVER_PULL_SINCE_DAYS,
    onError: (connectionId, err) => log.error({ connectionId, err }, "order sync failed"),
  });

  // Decrypt connections just-in-time, per cycle — never held between ticks.
  const loadConnections = async (): Promise<SyncConnection[]> => {
    const connections = await store.listActiveConnections();
    return Promise.all(
      connections.map(async (c) => ({
        id: c.id,
        marketplace: c.marketplace,
        credential: {
          sellerId: c.sellerId,
          marketplace: c.marketplace,
          secret: await credentialStore.get(c),
        },
      })),
    );
  };

  const scheduler = engine.startScheduler(loadConnections, config.ORDER_SYNC_INTERVAL_MS);

  return {
    deps: {
      store,
      runSync: async () => engine.syncAll(await loadConnections()),
    },
    stopScheduler: scheduler.stop,
  };
}

/**
 * Process entrypoint: build the app and bind the HTTP listener.
 * Graceful shutdown on SIGINT/SIGTERM so in-flight requests drain.
 */
async function main(): Promise<void> {
  const config = loadEnv();
  const { deps, stopScheduler } = buildSyncDeps(config, createLogger(config));
  const { app } = buildApp(process.env, deps);

  const close = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    stopScheduler?.();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void close("SIGINT"));
  process.on("SIGTERM", () => void close("SIGTERM"));

  try {
    await app.listen({ port: config.PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err, "failed to start");
    process.exit(1);
  }
}

void main();
