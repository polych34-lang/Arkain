import { MarketplaceError } from "./marketplace.js";

/**
 * One retry/backoff policy for ALL marketplaces.
 *
 * Adapters never implement their own retry loops — they raise
 * `MarketplaceError{ retryable }` (and optionally a `retryAfterMs` hint from a
 * Retry-After header), and this helper decides whether and when to retry. That
 * keeps backoff behaviour identical across 네이버 / 쿠팡 / 11번가 (priority #3:
 * the policy is shared, the adapter is thin).
 *
 * Strategy: exponential backoff with full jitter, capped, honouring an explicit
 * server-provided delay when present (429 Retry-After / rate-limit responses).
 */

export interface RetryOptions {
  /** Max attempts including the first. Default 5. */
  maxAttempts?: number;
  /** Base delay for backoff in ms. Default 500. */
  baseDelayMs?: number;
  /** Ceiling for any single backoff in ms. Default 20_000. */
  maxDelayMs?: number;
  /** Injectable sleep (tests pass a no-op). Default real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter in [0,1). Default Math.random. Tests pass a constant. */
  random?: () => number;
  /** Called before each backoff so callers can log/observe. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Is this error worth retrying? Only retryable MarketplaceErrors are. */
function isRetryable(error: unknown): error is MarketplaceError {
  return error instanceof MarketplaceError && error.opts.retryable === true;
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 20_000;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === maxAttempts) throw error;

      // Honour an explicit server delay (Retry-After), else exponential
      // backoff with full jitter: random in [base*2^(n-1)/2, base*2^(n-1)].
      const serverDelay = error.opts.retryAfterMs;
      const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jittered = exp / 2 + random() * (exp / 2);
      const delayMs = Math.min(
        maxDelayMs,
        serverDelay != null ? serverDelay : jittered,
      );

      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
  // Unreachable (loop either returns or throws), but satisfies the type checker.
  throw lastError;
}
