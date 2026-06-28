import bcrypt from "bcryptjs";
import { MarketplaceError } from "../marketplace.js";
import { withRetry, type RetryOptions } from "../retry.js";

/**
 * Low-level transport for the 네이버 커머스 API (Naver Commerce API).
 *
 * Responsibilities (and ONLY these — no domain knowledge lives here):
 *   1. OAuth2 token issuance via the bcrypt electronic-signature flow, with a
 *      per-account token cache + proactive refresh.
 *   2. A `request()` that attaches the bearer token, parses JSON, maps failures
 *      to `MarketplaceError{ retryable }`, and applies the shared retry policy.
 *
 * `fetch` and `now` are injectable so the whole thing is unit-testable without
 * network or real time. The default uses the global `fetch` (Node ≥ 18).
 *
 * --- Auth flow (Naver's quirk worth remembering) ---
 * Naver does NOT take the client_secret directly. You sign `"{clientId}_{ts}"`
 * with bcrypt **using the client_secret as the bcrypt salt**, base64 the hash,
 * and send that as `client_secret_sign`. The token endpoint is form-encoded.
 * See docs/naver-commerce-integration.md §Auth.
 */

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface NaverHttpConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /**
   * For solution providers (type=SELLER), the seller's Naver account id. Omit
   * for a self-owned app (type=SELF). Tokens are cached per account id.
   */
  accountId?: string;
}

export interface NaverHttpDeps {
  fetch?: FetchLike;
  /** Epoch ms. Injectable for deterministic token-expiry tests. */
  now?: () => number;
  /** Retry policy overrides (tests inject a no-op sleep). */
  retry?: RetryOptions;
}

interface CachedToken {
  accessToken: string;
  /** Absolute epoch ms at which we consider the token expired (with skew). */
  expiresAtMs: number;
}

interface RequestSpec {
  method: "GET" | "POST" | "PUT";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

/** Refresh the token this many ms before its real expiry, to avoid 401 races. */
const TOKEN_SKEW_MS = 60_000;

export class NaverHttpClient {
  private readonly fetch: FetchLike;
  private readonly now: () => number;
  private readonly retry?: RetryOptions;
  private readonly cache = new Map<string, CachedToken>();

  constructor(
    private readonly config: NaverHttpConfig,
    deps: NaverHttpDeps = {},
  ) {
    const fallbackFetch = (globalThis as { fetch?: unknown }).fetch as
      | FetchLike
      | undefined;
    const resolved = deps.fetch ?? fallbackFetch;
    if (!resolved) {
      throw new Error(
        "No fetch implementation available; pass deps.fetch or run on Node >= 18",
      );
    }
    this.fetch = resolved;
    this.now = deps.now ?? (() => Date.now());
    this.retry = deps.retry;
  }

  /** Build the bcrypt electronic signature for the token request. */
  static sign(clientId: string, clientSecret: string, timestampMs: number): string {
    const password = `${clientId}_${timestampMs}`;
    const hashed = bcrypt.hashSync(password, clientSecret);
    return Buffer.from(hashed, "utf-8").toString("base64");
  }

  private get cacheKey(): string {
    return this.config.accountId ?? "SELF";
  }

  /** Get a valid bearer token, issuing/refreshing as needed. */
  async getToken(): Promise<string> {
    const cached = this.cache.get(this.cacheKey);
    if (cached && cached.expiresAtMs - TOKEN_SKEW_MS > this.now()) {
      return cached.accessToken;
    }
    return this.issueToken();
  }

  private async issueToken(): Promise<string> {
    const timestamp = this.now();
    const signature = NaverHttpClient.sign(
      this.config.clientId,
      this.config.clientSecret,
      timestamp,
    );
    const form = new URLSearchParams({
      client_id: this.config.clientId,
      timestamp: String(timestamp),
      grant_type: "client_credentials",
      client_secret_sign: signature,
      type: this.config.accountId ? "SELLER" : "SELF",
    });
    if (this.config.accountId) form.set("account_id", this.config.accountId);

    const token = await withRetry(async () => {
      const res = await this.fetch(
        `${this.config.baseUrl}/external/v1/oauth2/token`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        },
      );
      const text = await res.text();
      if (res.status >= 200 && res.status < 300) {
        const json = parseJson(text);
        const accessToken = json?.access_token;
        const expiresIn = Number(json?.expires_in ?? 0);
        if (typeof accessToken !== "string" || !expiresIn) {
          throw new MarketplaceError("Naver token response missing fields", {
            marketplace: "naver_smartstore",
            retryable: false,
            status: res.status,
          });
        }
        this.cache.set(this.cacheKey, {
          accessToken,
          expiresAtMs: this.now() + expiresIn * 1000,
        });
        return accessToken;
      }
      throw mapHttpError(res.status, res.headers, text, "token");
    }, this.retry);

    return token;
  }

  /** Perform an authenticated JSON request, with retry + error mapping. */
  async request<T = unknown>(spec: RequestSpec): Promise<T> {
    return withRetry(async () => {
      const token = await this.getToken();
      const url = this.buildUrl(spec.path, spec.query);
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      };
      let body: string | undefined;
      if (spec.body !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(spec.body);
      }

      const res = await this.fetch(url, { method: spec.method, headers, body });
      const text = await res.text();
      if (res.status >= 200 && res.status < 300) {
        return parseJson(text) as T;
      }
      // A 401 usually means the token went stale mid-flight — drop it so the
      // next attempt re-issues, and let the retry policy run.
      if (res.status === 401) this.cache.delete(this.cacheKey);
      throw mapHttpError(res.status, res.headers, text, spec.path);
    }, this.retry);
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): string {
    const url = new URL(path, this.config.baseUrl);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }
}

function parseJson(text: string): any {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * Map an HTTP failure to a `MarketplaceError` with the right `retryable` flag.
 * 429 + 5xx + gateway rate-limit are retryable; 4xx (auth/validation) are not.
 */
export function mapHttpError(
  status: number,
  headers: { get(name: string): string | null },
  rawBody: string,
  context: string,
): MarketplaceError {
  const body = parseJson(rawBody);
  const code: string | undefined = body?.code ?? body?.errorCode;
  const message: string =
    body?.message ?? body?.error_description ?? rawBody?.slice(0, 200) ?? "";

  const retryAfterHeader = headers.get("retry-after");
  const retryAfterMs = retryAfterHeader
    ? Number(retryAfterHeader) * 1000
    : undefined;

  const isRateLimited =
    status === 429 || (typeof code === "string" && code.includes("RATELIMIT"));
  const retryable = isRateLimited || status >= 500;

  return new MarketplaceError(
    `Naver ${context} failed (${status}${code ? ` ${code}` : ""}): ${message}`,
    {
      marketplace: "naver_smartstore",
      retryable,
      status,
      code,
      retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
    },
  );
}
