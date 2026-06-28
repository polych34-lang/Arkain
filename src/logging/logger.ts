import pino, { type Logger } from "pino";
import type { AppConfig } from "../config/env.js";

/**
 * Structured JSON logging via pino. In production we emit JSON lines (ready for
 * any log aggregator); in development we pretty-print if `pino-pretty` is present.
 *
 * `redact` strips secrets and seller PII paths defensively so a stray
 * `log.info({ credential })` can never leak a token or token-like field.
 */
export function createLogger(cfg: AppConfig): Logger {
  const pretty =
    cfg.NODE_ENV === "development"
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "SYS:standard" },
          },
        }
      : {};

  return pino({
    level: cfg.LOG_LEVEL,
    base: { service: "arkain", env: cfg.NODE_ENV },
    redact: {
      paths: [
        "*.password",
        "*.token",
        "*.accessToken",
        "*.refreshToken",
        "*.clientSecret",
        "*.authorization",
        "req.headers.authorization",
        "credential",
        "credentials",
      ],
      censor: "[REDACTED]",
    },
    ...pretty,
  });
}
