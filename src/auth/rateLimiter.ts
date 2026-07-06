/**
 * ARK-86: minimal in-process sliding-window rate limiter for the unauthenticated
 * account-recovery endpoints (find-company-code / forgot-password). No new
 * dependency (`@fastify/rate-limit` etc.) — same "one Fly machine, no
 * distributed store" posture as `src/auth/session.ts`'s cookie-only session.
 * Per-key timestamps only, pruned lazily on each `consume()` — fine at this
 * app's traffic/key cardinality; revisit if either grows.
 */
export interface RateLimiter {
  /** Returns true if `key` is still under its limit (and records this hit),
   * false if `key` is currently rate-limited. */
  consume(key: string): boolean;
}

export function createRateLimiter(
  opts: { max: number; windowMs: number },
  now: () => number = Date.now,
): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    consume(key: string): boolean {
      const windowStart = now() - opts.windowMs;
      const recent = (hits.get(key) ?? []).filter((t) => t > windowStart);
      if (recent.length >= opts.max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now());
      hits.set(key, recent);
      return true;
    },
  };
}
