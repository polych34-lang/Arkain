/**
 * ARK-11 deliverable CLI: pull LIVE orders + products from ESM 2.0 (G마켓/옥션)
 * into local storage (./data/esm/*.json).
 *
 *   npm run esm:pull
 *
 * Credentials come from the validated env (never argv, never the repo):
 *   - ESM_MASTER_ID / ESM_SECRET_KEY / ESM_CLIENT_DOMAIN  (required)
 *   - ESM_GMARKET_SELLER_ID and/or ESM_AUCTION_SELLER_ID  (at least one required)
 *   - ESM_PULL_SINCE_DAYS  (optional; default 14)
 *
 * With no credentials it exits non-zero with a clear message — the live run is
 * gated on an ESM PLUS master account + API key issuance (a CEO sign-off
 * item, same boundary as ARK-3's Naver gate; see docs/esm-2.0-integration.md).
 * Everything up to that gate is proven by the unit tests, which exercise this
 * exact adapter against mocked ESM responses (transcribed from public docs,
 * not a live account — see the doc's confidence caveat).
 */
import { loadEnv } from "../config/env.js";
import { createLogger } from "../logging/logger.js";
import type { SellerCredential } from "../integrations/marketplace.js";
import { EsmAdapter } from "../integrations/esm/esm.adapter.js";
import { JsonFileStore } from "../storage/localStore.js";

async function main(): Promise<number> {
  const cfg = loadEnv();
  const log = createLogger(cfg);

  if (!cfg.ESM_MASTER_ID || !cfg.ESM_SECRET_KEY || !cfg.ESM_CLIENT_DOMAIN) {
    log.error(
      "Missing ESM_MASTER_ID / ESM_SECRET_KEY / ESM_CLIENT_DOMAIN. " +
        "The live pull is gated on an ESM PLUS master account + API key issuance " +
        "(CEO sign-off). Set them in .env and re-run.",
    );
    return 1;
  }
  if (!cfg.ESM_GMARKET_SELLER_ID && !cfg.ESM_AUCTION_SELLER_ID) {
    log.error(
      "Set at least one of ESM_GMARKET_SELLER_ID / ESM_AUCTION_SELLER_ID.",
    );
    return 1;
  }

  const adapter = new EsmAdapter({ baseUrl: cfg.ESM_API_BASE_URL });

  const credential: SellerCredential = {
    sellerId: "scratch-store",
    marketplace: "esm_2_0",
    secret: {
      masterId: cfg.ESM_MASTER_ID,
      secretKey: cfg.ESM_SECRET_KEY,
      clientDomain: cfg.ESM_CLIENT_DOMAIN,
      ...(cfg.ESM_GMARKET_SELLER_ID ? { gmarketSellerId: cfg.ESM_GMARKET_SELLER_ID } : {}),
      ...(cfg.ESM_AUCTION_SELLER_ID ? { auctionSellerId: cfg.ESM_AUCTION_SELLER_ID } : {}),
    },
  };

  const store = new JsonFileStore("./data/esm");
  const startedAt = new Date().toISOString();

  try {
    log.info("Verifying ESM 2.0 credential…");
    const ok = await adapter.verifyCredential(credential);
    if (!ok) {
      log.error("ESM 2.0 credential rejected. Check master id / secret key / seller ids.");
      return 1;
    }

    const since = new Date(Date.now() - cfg.ESM_PULL_SINCE_DAYS * 24 * 60 * 60 * 1000);
    let cursor: string | undefined;
    let orderTotal = 0;
    let orderPages = 0;
    do {
      const page = await adapter.fetchOrders(credential, { since, cursor });
      orderTotal = await store.upsertOrders(page.orders);
      orderPages++;
      log.info(
        { page: orderPages, fetched: page.orders.length, total: orderTotal },
        "orders page",
      );
      cursor = page.nextCursor;
    } while (cursor);

    let pCursor: string | undefined;
    let productTotal = 0;
    let productPages = 0;
    do {
      const page = await adapter.fetchProducts!(credential, { cursor: pCursor });
      productTotal = await store.upsertProducts(page.products);
      productPages++;
      log.info(
        { page: productPages, fetched: page.products.length, total: productTotal },
        "products page",
      );
      pCursor = page.nextCursor;
    } while (pCursor);

    await store.appendSyncRun({
      marketplace: "esm_2_0",
      startedAt,
      finishedAt: new Date().toISOString(),
      ordersPulled: orderTotal,
      productsPulled: productTotal,
      status: "success",
    });

    log.info(
      { orders: orderTotal, products: productTotal },
      "ESM 2.0 pull complete -> ./data/esm",
    );
    return 0;
  } catch (err) {
    await store.appendSyncRun({
      marketplace: "esm_2_0",
      startedAt,
      finishedAt: new Date().toISOString(),
      ordersPulled: 0,
      productsPulled: 0,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
    log.error({ err: err instanceof Error ? err.message : String(err) }, "ESM 2.0 pull failed");
    return 1;
  }
}

main().then((code) => process.exit(code));
