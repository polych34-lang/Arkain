/**
 * ARK-3 deliverable CLI: pull LIVE orders + products from a Naver scratch store
 * into local storage (./data/naver/*.json).
 *
 *   npm run naver:pull
 *
 * Credentials come from the validated env (never argv, never the repo):
 *   - NAVER_COMMERCE_CLIENT_ID / NAVER_COMMERCE_CLIENT_SECRET  (required)
 *   - NAVER_TEST_ACCOUNT_ID    (optional; set for SELLER-type connections)
 *   - NAVER_PULL_SINCE_DAYS    (optional; default 14)
 *
 * With no credentials it exits non-zero with a clear message — the live run is
 * gated on a Naver app registration + scratch store + secrets (a CEO sign-off
 * item; see the ARK-3 integration doc). Everything up to that gate is proven by
 * the unit tests, which exercise this exact adapter against mocked Naver responses.
 */
import { loadEnv } from "../config/env.js";
import { createLogger } from "../logging/logger.js";
import type { SellerCredential } from "../integrations/marketplace.js";
import { NaverSmartstoreAdapter } from "../integrations/naver/naver.adapter.js";
import { JsonFileStore } from "../storage/localStore.js";

async function main(): Promise<number> {
  const cfg = loadEnv();
  const log = createLogger(cfg);

  if (!cfg.NAVER_COMMERCE_CLIENT_ID || !cfg.NAVER_COMMERCE_CLIENT_SECRET) {
    log.error(
      "Missing NAVER_COMMERCE_CLIENT_ID / NAVER_COMMERCE_CLIENT_SECRET. " +
        "The live pull is gated on a Naver Commerce app registration + scratch " +
        "store + secrets (CEO sign-off). Set them in .env and re-run.",
    );
    return 1;
  }

  const adapter = new NaverSmartstoreAdapter({
    baseUrl: cfg.NAVER_COMMERCE_BASE_URL,
    clientId: cfg.NAVER_COMMERCE_CLIENT_ID,
    clientSecret: cfg.NAVER_COMMERCE_CLIENT_SECRET,
  });

  const credential: SellerCredential = {
    sellerId: "scratch-store",
    marketplace: "naver_smartstore",
    secret: cfg.NAVER_TEST_ACCOUNT_ID
      ? { accountId: cfg.NAVER_TEST_ACCOUNT_ID }
      : {},
  };

  const store = new JsonFileStore("./data/naver");
  const startedAt = new Date().toISOString();

  try {
    log.info("Verifying Naver credential…");
    const ok = await adapter.verifyCredential(credential);
    if (!ok) {
      log.error("Naver credential rejected (auth failed). Check id/secret/account.");
      return 1;
    }

    // --- Orders: page from `since` until caught up to now ---
    const since = new Date(
      Date.now() - cfg.NAVER_PULL_SINCE_DAYS * 24 * 60 * 60 * 1000,
    );
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

    // --- Products: page through the catalog ---
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
      marketplace: "naver_smartstore",
      startedAt,
      finishedAt: new Date().toISOString(),
      ordersPulled: orderTotal,
      productsPulled: productTotal,
      status: "success",
    });

    log.info(
      { orders: orderTotal, products: productTotal },
      "Naver pull complete -> ./data/naver",
    );
    return 0;
  } catch (err) {
    await store.appendSyncRun({
      marketplace: "naver_smartstore",
      startedAt,
      finishedAt: new Date().toISOString(),
      ordersPulled: 0,
      productsPulled: 0,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
    log.error({ err: err instanceof Error ? err.message : String(err) }, "Naver pull failed");
    return 1;
  }
}

main().then((code) => process.exit(code));
