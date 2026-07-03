import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import multipart, { type MultipartFile } from "@fastify/multipart";
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
import { renderGsShopImport } from "./web/gsshopImport.js";
import { renderSignup } from "./web/signup.js";
import { renderLogin } from "./web/login.js";
import { renderProductsDashboard } from "./web/productsDashboard.js";
import {
  connectNaverSeller,
  type ConnectionsWriteStore,
} from "./connect/naverSellerConnect.js";
import type { CredentialStore } from "./secrets/credentialStore.js";
import { hashPassword, verifyPassword } from "./auth/password.js";
import {
  getSessionSellerId,
  sessionClearCookieHeader,
  sessionSetCookieHeader,
} from "./auth/session.js";
import type { SellerAuthRecord } from "./auth/authStore.js";
import type { ProductListItem } from "./domain/repository.js";
import { MissingPriceError } from "./domain/b2b/pricing.js";
import { InvalidTransitionError } from "./domain/b2b/purchaseOrderStateMachine.js";
import type {
  Account,
  CreateAccountInput,
  CreatePurchaseOrderInput,
  PurchaseOrder,
  PurchaseOrderListFilter,
} from "./domain/b2b/types.js";
import { parseGsShopExcel } from "./imports/gsshop/gsshopExcelParser.js";
import { GsShopFormatError } from "./imports/gsshop/gsshop.types.js";
import type { NormalizedOrder } from "./integrations/marketplace.js";

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

/** ARK-46 GS샵 엑셀 임포트 surface — `PrismaDomainStore.upsertOrders` satisfies
 * this structurally (same store the sync engine's `OrderSyncStore` uses, kept
 * as its own narrow interface since this route only ever calls the one
 * method). No adapter/credential here — see src/imports/gsshop. */
export interface GsShopImportDeps {
  store: {
    upsertOrders(orders: NormalizedOrder[], tenantId: string): Promise<number>;
  };
}

/** ARK-57 로그인/워크스페이스 생성 surface. `AuthStore` satisfies this
 * structurally. Omitted the same way `store` is — undefined means the
 * pre-auth posture (no session layer at all) that every existing route
 * above already documents as its interim default. */
export interface AuthDeps {
  store: {
    createSeller(input: {
      email: string;
      passwordHash: string;
      displayName: string;
    }): Promise<SellerAuthRecord>;
    findSellerByEmail(email: string): Promise<SellerAuthRecord | null>;
  };
  sessionSecret: string;
  /** `Secure` cookie attribute — true outside local dev (config.NODE_ENV). */
  cookieSecure: boolean;
}

/** ARK-57 상품등록 surface — `PrismaDomainStore` satisfies this structurally
 * alongside `OrderReadStore` etc. */
export interface ProductsDeps {
  store: {
    createManualProduct(
      tenantId: string,
      input: { name: string; salePriceKrw: number; stockQuantity: number },
    ): Promise<ProductListItem>;
    listProducts(tenantId: string): Promise<ProductListItem[]>;
  };
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
  /** GS샵 주문 엑셀 임포트 (ARK-46). Omitted the same way `store` is. */
  gsshopImport?: GsShopImportDeps;
  /** 로그인/워크스페이스 생성 (ARK-57). Omitted the same way `store` is. */
  auth?: AuthDeps;
  /** 상품등록 (ARK-57). Omitted the same way `store` is. */
  products?: ProductsDeps;
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
  "gsshop",
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

  // 20MB cap: comfortably above a multi-thousand-row 주문리스트 엑셀, small
  // enough to not be an easy DoS vector on a pre-auth upload endpoint.
  void app.register(multipart, {
    attachFieldsToBody: true,
    limits: { fileSize: 20 * 1024 * 1024 },
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "arkain",
    env: config.NODE_ENV,
    // Liveness only. Readiness (DB, marketplace reachability) is added with
    // those subsystems in ENG-Domain-Model / ENG-Naver-Spike.
    checks: { process: "ok" },
  }));

  // ARK-64: sellers landing on the bare domain in a browser were shown raw
  // JSON with no visible way to reach the login screen. This is a seller
  // product now (not an API-only service), so "/" sends people straight to
  // the actual UI; the same index is still available at "/api" for anyone
  // who wants the machine-readable route map.
  app.get("/api", async () => ({
    name: "ARKAIN",
    description: "Multi-market seller management — order-sync MVP",
    docs: "/health",
    signup: "/signup",
    login: "/login",
    products: "/products",
    dashboard: "/orders",
    onboarding: "/onboarding/naver",
    connections: "/connections",
    gsshopImport: "/imports/gsshop",
  }));

  app.get("/", async (_req, reply) => {
    reply.redirect("/login");
  });

  // --- ENG-Orders-MVP (ARK-5): the unified order dashboard --------------
  app.get("/api/orders", async (req, reply) => {
    if (!deps.store) {
      return { configured: false, orders: [] as OrderListItem[] };
    }
    const filter = parseOrderFilter(req.query as Record<string, unknown>);
    // ARK-57: once auth is configured, every tenant-facing caller must go
    // through a session (repository.ts's `OrderListFilter.tenantId` doc
    // comment) — the client-supplied filter is never trusted for tenant
    // scoping, only the verified session cookie is. Pre-auth deployments
    // (deps.auth unset, e.g. every existing test) keep the old unscoped
    // ops-dashboard behavior untouched.
    if (deps.auth) {
      const sellerId = getSessionSellerId(req, deps.auth.sessionSecret);
      if (!sellerId) {
        reply.code(401);
        return { error: "로그인이 필요합니다" };
      }
      filter.tenantId = sellerId;
    }
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

  // --- ARK-57: 로그인 / 워크스페이스 생성 (sign-up combines both) ------------
  app.get("/signup", async (_req, reply) => {
    reply.type("text/html; charset=utf-8");
    return renderSignup();
  });

  app.get("/login", async (_req, reply) => {
    reply.type("text/html; charset=utf-8");
    return renderLogin();
  });

  app.post("/api/auth/signup", async (req, reply) => {
    if (!deps.auth) {
      reply.code(503);
      return { error: "회원가입이 아직 설정되지 않았습니다 (DATABASE_URL/SESSION_SECRET 미설정)" };
    }
    const body = (req.body ?? {}) as {
      workspaceName?: string;
      email?: string;
      password?: string;
    };
    const email = body.email?.trim().toLowerCase();
    if (!body.workspaceName?.trim() || !email || !body.password) {
      reply.code(400);
      return { error: "workspaceName, email, password are required" };
    }
    if (body.password.length < 8) {
      reply.code(400);
      return { error: "비밀번호는 8자 이상이어야 합니다" };
    }
    const existing = await deps.auth.store.findSellerByEmail(email);
    if (existing) {
      reply.code(409);
      return { error: "이미 사용중인 이메일입니다" };
    }
    const passwordHash = await hashPassword(body.password);
    const seller = await deps.auth.store.createSeller({
      email,
      passwordHash,
      displayName: body.workspaceName.trim(),
    });
    reply.header(
      "set-cookie",
      sessionSetCookieHeader(seller.id, deps.auth.sessionSecret, {
        secure: deps.auth.cookieSecure,
      }),
    );
    return { sellerId: seller.id, displayName: seller.displayName };
  });

  app.post("/api/auth/login", async (req, reply) => {
    if (!deps.auth) {
      reply.code(503);
      return { error: "로그인이 아직 설정되지 않았습니다 (DATABASE_URL/SESSION_SECRET 미설정)" };
    }
    const body = (req.body ?? {}) as { email?: string; password?: string };
    const email = body.email?.trim().toLowerCase();
    if (!email || !body.password) {
      reply.code(400);
      return { error: "email and password are required" };
    }
    const seller = await deps.auth.store.findSellerByEmail(email);
    const ok = seller ? await verifyPassword(body.password, seller.passwordHash) : false;
    if (!seller || !ok) {
      reply.code(401);
      return { error: "이메일 또는 비밀번호가 올바르지 않습니다" };
    }
    reply.header(
      "set-cookie",
      sessionSetCookieHeader(seller.id, deps.auth.sessionSecret, {
        secure: deps.auth.cookieSecure,
      }),
    );
    return { sellerId: seller.id, displayName: seller.displayName };
  });

  app.post("/api/auth/logout", async (_req, reply) => {
    reply.header(
      "set-cookie",
      sessionClearCookieHeader({ secure: deps.auth?.cookieSecure ?? false }),
    );
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => {
    if (!deps.auth) return { authenticated: false };
    const sellerId = getSessionSellerId(req, deps.auth.sessionSecret);
    return { authenticated: sellerId != null, sellerId };
  });

  // --- ARK-57: 상품등록 (manual product entry, no marketplace sync yet) -----
  app.get("/products", async (_req, reply) => {
    reply.type("text/html; charset=utf-8");
    return renderProductsDashboard();
  });

  app.get("/api/products", async (req, reply) => {
    if (!deps.products || !deps.auth) {
      return { configured: false, products: [] as ProductListItem[] };
    }
    const sellerId = getSessionSellerId(req, deps.auth.sessionSecret);
    if (!sellerId) {
      reply.code(401);
      return { error: "로그인이 필요합니다" };
    }
    const products = await deps.products.store.listProducts(sellerId);
    return { configured: true, products };
  });

  app.post("/api/products", async (req, reply) => {
    if (!deps.products || !deps.auth) {
      reply.code(503);
      return { error: "상품등록이 아직 설정되지 않았습니다 (DATABASE_URL/SESSION_SECRET 미설정)" };
    }
    const sellerId = getSessionSellerId(req, deps.auth.sessionSecret);
    if (!sellerId) {
      reply.code(401);
      return { error: "로그인이 필요합니다" };
    }
    const body = (req.body ?? {}) as {
      name?: string;
      salePriceKrw?: number;
      stockQuantity?: number;
    };
    if (!body.name?.trim() || !Number.isFinite(body.salePriceKrw) || !Number.isFinite(body.stockQuantity)) {
      reply.code(400);
      return { error: "name, salePriceKrw, stockQuantity are required" };
    }
    if ((body.salePriceKrw as number) < 0 || (body.stockQuantity as number) < 0) {
      reply.code(400);
      return { error: "salePriceKrw and stockQuantity must not be negative" };
    }
    const product = await deps.products.store.createManualProduct(sellerId, {
      name: body.name.trim(),
      salePriceKrw: body.salePriceKrw as number,
      stockQuantity: body.stockQuantity as number,
    });
    return { product };
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

  // --- GS샵 주문 엑셀 임포트 (ARK-46) — 별도 임포트 컴포넌트, 어댑터 아님 --------
  //
  // MarketplaceAdapter/fetchOrders가 없다(ARK-15 §3(a): GS샵은 공개 주문 API가
  // 없다). 셀러가 GS샵 파트너스 포털에서 내려받은 주문리스트 엑셀을 여기 업로드하면
  // 파싱해서 오픈마켓 어댑터와 같은 `NormalizedOrder[]` -> `upsertOrders` 경로로
  // 흘려보낸다. 스케줄러/폴링 없음 — 셀러가 매번 수동으로 업로드(MVP 스코프 판단,
  // docs/gsshop-excel-import.md).
  app.get("/imports/gsshop", async (_req, reply) => {
    reply.type("text/html; charset=utf-8");
    return renderGsShopImport();
  });

  app.post("/api/imports/gsshop", async (req, reply) => {
    if (!deps.gsshopImport) {
      reply.code(503);
      return { error: "GS샵 임포트가 아직 설정되지 않았습니다 (DATABASE_URL 미설정)" };
    }
    const body = (req.body ?? {}) as {
      tenantId?: { value: string };
      file?: MultipartFile;
    };
    const tenantId = body.tenantId?.value?.trim();
    if (!tenantId || !body.file) {
      reply.code(400);
      return { error: "tenantId and file are required" };
    }

    let result;
    try {
      const buffer = await body.file.toBuffer();
      result = await parseGsShopExcel(buffer);
    } catch (err) {
      if (err instanceof GsShopFormatError) {
        reply.code(422);
        return { error: err.message };
      }
      throw err;
    }

    const totalOrders = await deps.gsshopImport.store.upsertOrders(result.orders, tenantId);
    return {
      ordersImported: result.orders.length,
      totalOrders,
      rowsRead: result.rowsRead,
      rowErrors: result.rowErrors,
    };
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
