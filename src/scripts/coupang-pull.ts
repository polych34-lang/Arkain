/**
 * ARK-27 deliverable CLI: pull LIVE orders + products from 쿠팡 Wing/Open API
 * into local storage (./data/coupang/*.json).
 *
 *   npm run coupang:pull
 *
 * Credentials come from the validated env (never argv, never the repo):
 *   - COUPANG_VENDOR_ID / COUPANG_ACCESS_KEY / COUPANG_SECRET_KEY (required)
 *   - COUPANG_PULL_SINCE_DAYS (optional; default 14)
 *
 * With no credentials it exits non-zero with a clear message — the live run
 * is gated on a Coupang WING vendor account + Open API key issuance (a CEO
 * sign-off item, same boundary as ARK-3's Naver gate and ARK-11's ESM gate;
 * see docs/coupang-integration.md). Everything up to that gate is proven by
 * the unit tests, which exercise this exact adapter against mocked Coupang
 * responses (transcribed from public docs, not a live account — see the
 * doc's confidence caveat).
 */
import { loadEnv } from "../config/env.js";
import { createLogger } from "../logging/logger.js";
import type { SellerCredential } from "../integrations/marketplace.js";
import { CoupangAdapter } from "../integrations/coupang/coupang.adapter.js";
import { JsonFileStore } from "../storage/localStore.js";

async function main(): Promise<number> {
  const cfg = loadEnv();
  const log = createLogger(cfg);

  if (!cfg.COUPANG_VENDOR_ID || !cfg.COUPANG_ACCESS_KEY || !cfg.COUPANG_SECRET_KEY) {
    log.error(
      "Missing COUPANG_VENDOR_ID / COUPANG_ACCESS_KEY / COUPANG_SECRET_KEY. " +
        "The live pull is gated on a Coupang WING vendor account + Open API key " +
        "issuance (CEO sign-off). Set them in .env and re-run.",
    );
    return 1;
  }

  const adapter = new CoupangAdapter({ baseUrl: cfg.COUPANG_API_BASE_URL });

  const credential: SellerCredential = {
    sellerId: "scratch-store",
    marketplace: "coupang",
    secret: {
      vendorId: cfg.COUPANG_VENDOR_ID,
      accessKey: cfg.COUPANG_ACCESS_KEY,
      secretKey: cfg.COUPANG_SECRET_KEY,
    },
  };

  const store = new JsonFileStore("./data/coupang");
  const startedAt = new Date().toISOString();

  try {
    log.info("Verifying Coupang credential…");
    const ok = await adapter.verifyCredential(credential);
    if (!ok) {
      log.error("Coupang credential rejected. Check vendor id / access key / secret key.");
      return 1;
    }

    const since = new Date(Date.now() - cfg.COUPANG_PULL_SINCE_DAYS * 24 * 60 * 60 * 1000);
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
      marketplace: "coupang",
      startedAt,
      finishedAt: new Date().toISOString(),
      ordersPulled: orderTotal,
      productsPulled: productTotal,
      status: "success",
    });

    log.info(
      { orders: orderTotal, products: productTotal },
      "Coupang pull complete -> ./data/coupang",
    );
    return 0;
  } catch (err) {
    await store.appendSyncRun({
      marketplace: "coupang",
      startedAt,
      finishedAt: new Date().toISOString(),
      ordersPulled: 0,
      productsPulled: 0,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
    log.error({ err: err instanceof Error ? err.message : String(err) }, "Coupang pull failed");
    return 1;
  }
}

main().then((code) => process.exit(code));
