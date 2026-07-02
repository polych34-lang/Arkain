import { createHmac } from "node:crypto";
import { MarketplaceError } from "../marketplace.js";
import { withRetry, type RetryOptions } from "../retry.js";

/**
 * Low-level transport for the 쿠팡 Wing/Open API (`api-gateway.coupang.com`).
 *
 * Responsibilities (and ONLY these — no domain knowledge lives here):
 *   1. Per-request HMAC signing (see `sign()` — no token-issuance round trip,
 *      same shape as ESM's per-request JWT, unlike Naver's cached OAuth2 token).
 *   2. A `request()` that attaches the signed `Authorization` header, parses
 *      JSON, maps failures to `MarketplaceError{retryable}`, and applies the
 *      shared retry policy.
 *
 * `fetch` and `now` are injectable so the whole thing is unit-testable without
 * network or real time.
 *
 * --- Auth flow (transcribed from the public Coupang Open API guide,
 * NOT verified against a live vendor account — see docs/coupang-integration.md §6) ---
 * signed-date = UTC `yyMMdd'T'HHmmss'Z'` (e.g. `260702T091500Z`)
 * message     = `${signedDate}${method}${path}${query}`
 *   - `path` excludes the host; `query` is the raw query string with no
 *     leading `?`, keys sorted ascending (documented client implementations
 *     agree on this; Coupang's own reference does not show a multi-param
 *     example, so key order is our best-effort, defensive default).
 * signature   = hex(HMAC-SHA256(message, secretKey))
 * header      = `CEA algorithm=HmacSHA256, access-key={accessKey},
 *                signed-date={signedDate}, signature={signature}`
 *
 * Unlike Naver (app-level client_id/secret) and like ESM (per-seller only),
 * Coupang issues `accessKey`/`secretKey`/`vendorId` directly to each seller
 * from WING > 오픈API 관리 — there is no ARKAIN-level shared credential.
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

/** Per-seller Coupang Wing credential material (all fields required at call time). */
export interface CoupangCredential {
  vendorId: string;
  accessKey: string;
  secretKey: string;
}

export interface CoupangHttpConfig {
  baseUrl: string;
}

export interface CoupangHttpDeps {
  fetch?: FetchLike;
  /** Epoch ms; drives the `signed-date` clock. Injectable for deterministic tests. */
  now?: () => number;
  retry?: RetryOptions;
}

interface RequestSpec {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** UTC `yyMMdd'T'HHmmss'Z'`, the documented `signed-date` shape. */
export function formatSignedDate(nowMs: number): string {
  const d = new Date(nowMs);
  const yy = String(d.getUTCFullYear()).slice(2);
  return `${yy}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** Raw query string (no leading `?`), keys sorted for a deterministic signature. */
export function buildSignedQuery(
  query?: Record<string, string | number | undefined>,
): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

export class CoupangHttpClient {
  private readonly fetch: FetchLike;
  private readonly now: () => number;
  private readonly retry?: RetryOptions;

  constructor(
    private readonly config: CoupangHttpConfig,
    private readonly cred: CoupangCredential,
    deps: CoupangHttpDeps = {},
  ) {
    const fallbackFetch = (globalThis as { fetch?: unknown }).fetch as
      | FetchLike
      | undefined;
    const resolved = deps.fetch ?? fallbackFetch;
    if (!resolved) {
      throw new Error(
        "No fetch implementation available; pass deps.fetch or run on Node >= 20",
      );
    }
    this.fetch = resolved;
    this.now = deps.now ?? (() => Date.now());
    this.retry = deps.retry;
  }

  /** Build the `CEA algorithm=...` header for one request (see class doc). */
  sign(method: string, path: string, query: string): string {
    const signedDate = formatSignedDate(this.now());
    const message = `${signedDate}${method}${path}${query}`;
    const signature = createHmac("sha256", this.cred.secretKey)
      .update(message)
      .digest("hex");
    return `CEA algorithm=HmacSHA256, access-key=${this.cred.accessKey}, signed-date=${signedDate}, signature=${signature}`;
  }

  /** Perform an authenticated JSON request, with retry + error mapping. */
  async request<T = unknown>(spec: RequestSpec): Promise<T> {
    return withRetry(async () => {
      const query = buildSignedQuery(spec.query);
      const authorization = this.sign(spec.method, spec.path, query);
      const url = new URL(spec.path, this.config.baseUrl);
      if (query) url.search = query;

      const headers: Record<string, string> = {
        authorization,
        accept: "application/json",
      };
      let body: string | undefined;
      if (spec.body !== undefined) {
        headers["content-type"] = "application/json;charset=UTF-8";
        body = JSON.stringify(spec.body);
      }

      const res = await this.fetch(url.toString(), {
        method: spec.method,
        headers,
        body,
      });
      const text = await res.text();
      if (res.status >= 200 && res.status < 300) {
        return parseJson(text) as T;
      }
      throw mapHttpError(res.status, res.headers, text, spec.path);
    }, this.retry);
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
 * Coupang's docs describe standard HTTP status codes (401 auth, 404 not found,
 * 429 rate limit, 5xx) rather than ESM's always-200/body-code pattern, so this
 * follows Naver's HTTP-status-based approach — unverified against a live
 * vendor account, see docs/coupang-integration.md §6.
 */
export function mapHttpError(
  status: number,
  headers: { get(name: string): string | null },
  rawBody: string,
  context: string,
): MarketplaceError {
  const body = parseJson(rawBody);
  const code: string | undefined =
    body?.code !== undefined ? String(body.code) : undefined;
  const message: string = body?.message ?? rawBody?.slice(0, 200) ?? "";

  const retryAfterHeader = headers.get("retry-after");
  const retryAfterMs = retryAfterHeader
    ? Number(retryAfterHeader) * 1000
    : undefined;

  const retryable = status === 429 || status >= 500;

  return new MarketplaceError(
    `Coupang ${context} failed (${status}${code ? ` ${code}` : ""}): ${message}`,
    {
      marketplace: "coupang",
      retryable,
      status,
      code,
      retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
    },
  );
}
