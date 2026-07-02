import { z } from "zod";

/**
 * Central, validated configuration. Nothing in the app reads `process.env`
 * directly — everything goes through `loadEnv()` so that a missing or malformed
 * variable fails loudly at boot instead of silently producing wrong data later.
 *
 * Secrets are never logged. See `redactedConfig()`.
 */
const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "staging", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  // Optional at boot so the skeleton runs without a DB; required once
  // persistence is wired in (ENG-Domain-Model / ENG-Orders-MVP).
  DATABASE_URL: z.string().url().optional(),

  // Credential encryption key (base64, 32 bytes). Optional at boot; required
  // before any seller marketplace credential is stored.
  CREDENTIAL_ENC_KEY: z.string().min(1).optional(),

  // Naver Commerce app-level credentials. Optional until the Naver spike.
  NAVER_COMMERCE_CLIENT_ID: z.string().optional(),
  NAVER_COMMERCE_CLIENT_SECRET: z.string().optional(),
  NAVER_COMMERCE_BASE_URL: z
    .string()
    .url()
    .default("https://api.commerce.naver.com"),

  // Naver spike (ARK-3) scratch-store knobs. Optional.
  // For a SELLER-type (solution-provider) connection, the test seller's account
  // id; omit for a SELF-type app where the client id/secret are the store's own.
  NAVER_TEST_ACCOUNT_ID: z.string().optional(),
  // How many days back the pull CLI looks for changed orders. Default 14.
  NAVER_PULL_SINCE_DAYS: z.coerce.number().int().positive().default(14),

  // ARK-21: deep link to Naver's SELLER-mode solution-consent screen, shown
  // as the "연결 허용" button on /onboarding/naver. Stays unset until
  // SellerDesk's own solution-provider registration with Naver is approved
  // (business/legal step, tracked outside this codebase) — the onboarding UI
  // falls back to manual account-id entry rather than fabricating a URL.
  NAVER_SELLER_CONSENT_URL: z.string().url().optional(),

  // ENG-Orders-MVP (ARK-5): in-process poll interval for the order-sync
  // scheduler. Default 5 minutes. Only takes effect when DATABASE_URL and
  // CREDENTIAL_ENC_KEY are both set (see main.ts).
  ORDER_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),

  // ESM 2.0 (G마켓/옥션, ARK-11). Unlike Naver, ESM has no app-level shared
  // key — every field below is per-seller (one ESM PLUS master account).
  // These env vars exist only to drive the `esm:pull` scratch/dev CLI; real
  // per-seller credentials go through CredentialStore, never env, in prod.
  ESM_API_BASE_URL: z.string().url().default("https://sa2.esmplus.com"),
  ESM_MASTER_ID: z.string().optional(),
  ESM_SECRET_KEY: z.string().optional(),
  ESM_CLIENT_DOMAIN: z.string().optional(),
  ESM_AUCTION_SELLER_ID: z.string().optional(),
  ESM_GMARKET_SELLER_ID: z.string().optional(),
  ESM_PULL_SINCE_DAYS: z.coerce.number().int().positive().default(14),

  // 쿠팡 Wing/Open API (ARK-27). Like ESM, no app-level shared key — every
  // field below is per-seller (accessKey/secretKey/vendorId issued directly
  // by Coupang WING > 오픈API 관리). Exists only to drive the `coupang:pull`
  // scratch/dev CLI; real per-seller credentials go through CredentialStore,
  // never env, in prod.
  COUPANG_API_BASE_URL: z.string().url().default("https://api-gateway.coupang.com"),
  COUPANG_VENDOR_ID: z.string().optional(),
  COUPANG_ACCESS_KEY: z.string().optional(),
  COUPANG_SECRET_KEY: z.string().optional(),
  COUPANG_PULL_SINCE_DAYS: z.coerce.number().int().positive().default(14),

  // ARK-28: Slack-compatible incoming webhook for ops alerts (sync failure,
  // marketplace rate-limiting, settlement mismatch). Optional — unset means
  // log-only alerting (the default in dev/test/CI). See src/alerting/notifier.ts.
  ALERT_WEBHOOK_URL: z.string().url().optional(),
});

export type AppConfig = z.infer<typeof EnvSchema>;

let cached: AppConfig | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppConfig {
  // Only memoize the canonical process.env load. Explicit sources (tests,
  // multi-tenant config) are parsed fresh so they never see a stale singleton.
  const usingProcessEnv = source === process.env;
  if (usingProcessEnv && cached) return cached;

  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (usingProcessEnv) cached = parsed.data;
  return parsed.data;
}

/** A version of the config safe to log — secrets are masked. */
export function redactedConfig(cfg: AppConfig): Record<string, unknown> {
  const mask = (v: string | undefined) => (v ? "***set***" : "***unset***");
  return {
    NODE_ENV: cfg.NODE_ENV,
    PORT: cfg.PORT,
    LOG_LEVEL: cfg.LOG_LEVEL,
    DATABASE_URL: mask(cfg.DATABASE_URL),
    CREDENTIAL_ENC_KEY: mask(cfg.CREDENTIAL_ENC_KEY),
    NAVER_COMMERCE_CLIENT_ID: mask(cfg.NAVER_COMMERCE_CLIENT_ID),
    NAVER_COMMERCE_CLIENT_SECRET: mask(cfg.NAVER_COMMERCE_CLIENT_SECRET),
    NAVER_COMMERCE_BASE_URL: cfg.NAVER_COMMERCE_BASE_URL,
    NAVER_TEST_ACCOUNT_ID: mask(cfg.NAVER_TEST_ACCOUNT_ID),
    NAVER_PULL_SINCE_DAYS: cfg.NAVER_PULL_SINCE_DAYS,
    NAVER_SELLER_CONSENT_URL: cfg.NAVER_SELLER_CONSENT_URL ?? "***unset***",
    ORDER_SYNC_INTERVAL_MS: cfg.ORDER_SYNC_INTERVAL_MS,
    ESM_API_BASE_URL: cfg.ESM_API_BASE_URL,
    ESM_MASTER_ID: mask(cfg.ESM_MASTER_ID),
    ESM_SECRET_KEY: mask(cfg.ESM_SECRET_KEY),
    ESM_CLIENT_DOMAIN: mask(cfg.ESM_CLIENT_DOMAIN),
    ESM_AUCTION_SELLER_ID: mask(cfg.ESM_AUCTION_SELLER_ID),
    ESM_GMARKET_SELLER_ID: mask(cfg.ESM_GMARKET_SELLER_ID),
    ESM_PULL_SINCE_DAYS: cfg.ESM_PULL_SINCE_DAYS,
    COUPANG_API_BASE_URL: cfg.COUPANG_API_BASE_URL,
    COUPANG_VENDOR_ID: mask(cfg.COUPANG_VENDOR_ID),
    COUPANG_ACCESS_KEY: mask(cfg.COUPANG_ACCESS_KEY),
    COUPANG_SECRET_KEY: mask(cfg.COUPANG_SECRET_KEY),
    COUPANG_PULL_SINCE_DAYS: cfg.COUPANG_PULL_SINCE_DAYS,
    ALERT_WEBHOOK_URL: mask(cfg.ALERT_WEBHOOK_URL),
  };
}
