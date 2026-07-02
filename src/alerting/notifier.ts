import type { Logger } from "pino";

/**
 * ARK-28: baseline operational alerting for sync failures, marketplace
 * rate-limiting, and (later) settlement mismatches — the three signals the
 * mandate calls out as must-detect before real seller data flows through.
 *
 * No dedicated alerting platform yet (PagerDuty/Opsgenie is overkill for one
 * engineer + no on-call rotation). This posts to a Slack-compatible incoming
 * webhook when `ALERT_WEBHOOK_URL` is configured, and always logs structurally
 * so any future log-based alerting (e.g. a hosted log aggregator's alert
 * rules) can key off `{ alert: <category> }`. With no webhook configured
 * (dev/test default) this is log-only — never a network call.
 */

export type AlertCategory = "sync_failure" | "rate_limit" | "settlement_mismatch";

export interface AlertEvent {
  category: AlertCategory;
  message: string;
  context?: Record<string, unknown>;
}

export interface AlertNotifier {
  send(event: AlertEvent): Promise<void>;
}

export interface AlertNotifierConfig {
  /** Slack-compatible incoming webhook URL. Undefined => log-only, no-op network. */
  webhookUrl?: string;
  /** Deployment environment, included in the alert text. */
  env: string;
}

export interface AlertNotifierDeps {
  fetchImpl?: typeof fetch;
}

const LOG_LEVEL_BY_CATEGORY: Record<AlertCategory, "warn" | "error"> = {
  sync_failure: "error",
  rate_limit: "warn",
  settlement_mismatch: "error",
};

export function createAlertNotifier(
  config: AlertNotifierConfig,
  log: Logger,
  deps: AlertNotifierDeps = {},
): AlertNotifier {
  const doFetch = deps.fetchImpl ?? fetch;

  return {
    async send(event: AlertEvent): Promise<void> {
      log[LOG_LEVEL_BY_CATEGORY[event.category]](
        { alert: event.category, ...event.context },
        event.message,
      );

      if (!config.webhookUrl) return;

      try {
        const res = await doFetch(config.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: `[ARKAIN/${config.env}] ${event.category}: ${event.message}`,
          }),
        });
        if (!res.ok) {
          log.error(
            { status: res.status, category: event.category },
            "alert webhook responded with a non-2xx status",
          );
        }
      } catch (err) {
        log.error({ err, category: event.category }, "failed to deliver alert webhook");
      }
    },
  };
}

/**
 * Suppresses repeat alerts for the same key within `windowMs` so a noisy
 * connection (e.g. sustained rate-limiting) sends one alert per window
 * instead of one per retry attempt.
 */
export function createAlertThrottle(windowMs: number, now: () => number = Date.now) {
  const lastSentAt = new Map<string, number>();
  return {
    /** Returns true (and records the send) if `key` is not currently suppressed. */
    shouldSend(key: string): boolean {
      const last = lastSentAt.get(key);
      const nowMs = now();
      if (last != null && nowMs - last < windowMs) return false;
      lastSentAt.set(key, nowMs);
      return true;
    },
  };
}
