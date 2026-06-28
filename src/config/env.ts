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
  };
}
