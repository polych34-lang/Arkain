import Fastify from "fastify";
import { loadEnv, redactedConfig } from "./config/env.js";
import { createLogger } from "./logging/logger.js";

/**
 * Construct the Fastify app with routes wired but no network listener bound.
 * Kept separate from `main.ts` so tests can exercise routes via `app.inject()`.
 * Return type is inferred so the pino logger's concrete type flows through.
 */
export function buildApp(env: NodeJS.ProcessEnv = process.env) {
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
  }));

  logger.info({ config: redactedConfig(config) }, "ARKAIN app constructed");
  return { app, config };
}

export type BuildAppResult = ReturnType<typeof buildApp>;
