import { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import { buildApp, type BuildAppDeps } from "./app.js";
import { loadEnv } from "./config/env.js";
import { PrismaDomainStore } from "./domain/repository.js";
import { B2BStore } from "./domain/b2b/repository.js";
import { NaverSmartstoreAdapter } from "./integrations/naver/naver.adapter.js";
import { EsmAdapter } from "./integrations/esm/esm.adapter.js";
import { CoupangAdapter } from "./integrations/coupang/coupang.adapter.js";
import { MarketplaceError } from "./integrations/marketplace.js";
import type { MarketplaceAdapter, MarketplaceId } from "./integrations/marketplace.js";
import type { RetryOptions } from "./integrations/retry.js";
import { createLogger } from "./logging/logger.js";
import { EnvelopeCredentialStore } from "./secrets/credentialStore.js";
import { OrderSyncEngine, type SyncConnection } from "./sync/orderSyncEngine.js";
import { createAlertNotifier, createAlertThrottle, type AlertNotifier } from "./alerting/notifier.js";

/** ARK-28: alert at most once per marketplace per window, even if a sync
 * cycle burns through several retries against the same rate limit. */
const RATE_LIMIT_ALERT_WINDOW_MS = 5 * 60 * 1000;

/** Only a server-signalled rate limit (explicit Retry-After / 429 with a
 * hint) counts as "rate_limit" — a bare 5xx retry is a transient failure,
 * not a rate-limit signal, and is left to the sync_failure path if it never
 * recovers within the retry budget. */
function onRetryAlert(
  marketplace: MarketplaceId,
  alerter: AlertNotifier,
  throttle: ReturnType<typeof createAlertThrottle>,
): RetryOptions["onRetry"] {
  return ({ attempt, error }) => {
    if (!(error instanceof MarketplaceError) || error.opts.retryAfterMs == null) return;
    if (!throttle.shouldSend(marketplace)) return;
    void alerter.send({
      category: "rate_limit",
      message: `${marketplace} is rate-limiting sync requests`,
      context: { marketplace, attempt },
    });
  };
}

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
  const b2bStore = new B2BStore(prisma);
  const credentialStore = new EnvelopeCredentialStore(config.CREDENTIAL_ENC_KEY);

  // ARK-28: baseline ops alerting (sync failures, marketplace rate-limiting).
  // Log-only when ALERT_WEBHOOK_URL is unset (dev/test default).
  const alerter = createAlertNotifier(
    { webhookUrl: config.ALERT_WEBHOOK_URL, env: config.NODE_ENV },
    log,
  );
  const rateLimitThrottle = createAlertThrottle(RATE_LIMIT_ALERT_WINDOW_MS);

  const naverAdapter = new NaverSmartstoreAdapter(
    {
      baseUrl: config.NAVER_COMMERCE_BASE_URL,
      clientId: config.NAVER_COMMERCE_CLIENT_ID,
      clientSecret: config.NAVER_COMMERCE_CLIENT_SECRET,
    },
    { retry: { onRetry: onRetryAlert("naver_smartstore", alerter, rateLimitThrottle) } },
  );

  const adapters: Partial<Record<MarketplaceId, MarketplaceAdapter>> = {
    naver_smartstore: naverAdapter,
    // ESM 2.0 (ARK-11): no app-level key (per-seller only, see env.ts), so
    // this is always safe to register — a connection simply can't be synced
    // until its per-seller credential is stored via CredentialStore.
    esm_2_0: new EsmAdapter(
      { baseUrl: config.ESM_API_BASE_URL },
      { retry: { onRetry: onRetryAlert("esm_2_0", alerter, rateLimitThrottle) } },
    ),
    // Coupang (ARK-27): same no-app-level-key shape as ESM (per-seller
    // vendorId/accessKey/secretKey only).
    coupang: new CoupangAdapter(
      { baseUrl: config.COUPANG_API_BASE_URL },
      { retry: { onRetry: onRetryAlert("coupang", alerter, rateLimitThrottle) } },
    ),
  };

  const engine = new OrderSyncEngine(adapters, store, {
    defaultSinceDays: config.NAVER_PULL_SINCE_DAYS,
    onError: (connectionId, err) => {
      log.error({ connectionId, err }, "order sync failed");
      void alerter.send({
        category: "sync_failure",
        message: `order sync failed for connection ${connectionId}`,
        context: { connectionId, error: err instanceof Error ? err.message : String(err) },
      });
    },
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
      b2bStore,
      // ARK-21: seller self-service Naver connect. `store` structurally
      // satisfies both `upsertConnection` and `listConnectionSummaries`.
      connections: {
        naverAdapter,
        credentialStore,
        connectionsStore: store,
        naverConsentUrl: config.NAVER_SELLER_CONSENT_URL,
      },
      // ARK-46: GS샵 엑셀 임포트. No adapter/credential — `store` already
      // structurally satisfies `upsertOrders`.
      gsshopImport: { store },
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
