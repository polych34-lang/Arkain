import { createHmac } from "node:crypto";
import { MarketplaceError } from "../marketplace.js";
import { withRetry, type RetryOptions } from "../retry.js";
import type { EsmSite } from "./esm.mapper.js";

/**
 * Low-level transport for the ESM Trading API (ESM 2.0, G마켓/옥션).
 *
 * Responsibilities (and ONLY these — no domain knowledge lives here):
 *   1. Per-request JWT signing (see `sign()` — no token-issuance round trip,
 *      unlike Naver; the token is self-signed and sent fresh on every call).
 *   2. A `request()` that attaches the bearer token, parses JSON, maps
 *      failures to `MarketplaceError{retryable}`, and applies the shared
 *      retry policy.
 *
 * `fetch` and `now` are injectable so the whole thing is unit-testable
 * without network or real time.
 *
 * --- Auth flow (transcribed from https://etapi.gmarket.com/pages/API-가이드,
 * NOT verified against a live account — see docs/esm-2.0-integration.md §7) ---
 * header  = { alg: "HS256", typ: "JWT", kid: masterId }
 * payload = { iss: clientDomain, sub: "sell", aud: "sa.esmplus.com",
 *             ssi: `${siteId}:${sellerId}` }   // siteId: "A"=Auction, "G"=Gmarket
 * token   = base64url(header) + "." + base64url(payload) + "." + signature
 * signature = base64url(HMAC-SHA256(`${headerB64}.${payloadB64}`, secretKey))
 * Sent as `Authorization: Bearer {token}`.
 *
 * --- Response shape quirk (also unverified) ---
 * Every endpoint we found in public docs replies HTTP 200 with a body-level
 * `ResultCode`/`Message` — including the documented rate-limit case (주문조회:
 * capped at 1 call / 5s per seller id, https://etapi.gmarket.com/198). There is
 * no confirmed list of which non-zero `ResultCode`s are transient vs
 * permanent, so `mapResultError` below treats a rate-limit-shaped `Message`
 * as retryable and everything else as a hard failure — a heuristic to
 * refine once a live/sandbox account exists.
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

/** Per-seller ESM PLUS credential material (all fields required at call time). */
export interface EsmCredential {
  /** ESM PLUS 마스터 ID (JWT `kid`). */
  masterId: string;
  /** HMAC signing key issued alongside the master id. */
  secretKey: string;
  /** JWT `iss` — the calling client's registered domain. */
  clientDomain: string;
  /** Per-site seller id used in `ssi`; the site being called selects which. */
  auctionSellerId?: string;
  gmarketSellerId?: string;
}

export interface EsmHttpConfig {
  baseUrl: string;
}

export interface EsmHttpDeps {
  fetch?: FetchLike;
  /** Epoch ms; unused by signing today (no `exp` claim documented) but kept
   * injectable for parity with the Naver transport and future-proofing. */
  now?: () => number;
  retry?: RetryOptions;
}

interface RequestSpec {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}

function base64url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export class EsmHttpClient {
  private readonly fetch: FetchLike;
  private readonly retry?: RetryOptions;

  constructor(
    private readonly config: EsmHttpConfig,
    private readonly cred: EsmCredential,
    deps: EsmHttpDeps = {},
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
    this.retry = deps.retry;
  }

  /** Build the per-request JWT (see class doc for the exact shape). */
  sign(site: EsmSite): string {
    const siteId = site === "auction" ? "A" : "G";
    const sellerId =
      site === "auction" ? this.cred.auctionSellerId : this.cred.gmarketSellerId;
    if (!sellerId) {
      throw new MarketplaceError(
        `Missing ${site === "auction" ? "auctionSellerId" : "gmarketSellerId"} for ESM 2.0 credential`,
        { marketplace: "esm_2_0", retryable: false },
      );
    }
    const header = base64url(
      JSON.stringify({ alg: "HS256", typ: "JWT", kid: this.cred.masterId }),
    );
    const payload = base64url(
      JSON.stringify({
        iss: this.cred.clientDomain,
        sub: "sell",
        aud: "sa.esmplus.com",
        ssi: `${siteId}:${sellerId}`,
      }),
    );
    const signature = createHmac("sha256", this.cred.secretKey)
      .update(`${header}.${payload}`)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return `${header}.${payload}.${signature}`;
  }

  /** Perform an authenticated JSON request for a given storefront, with retry. */
  async request<T = unknown>(site: EsmSite, spec: RequestSpec): Promise<T> {
    return withRetry(async () => {
      const token = this.sign(site);
      const url = new URL(spec.path, this.config.baseUrl).toString();
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
      if (res.status < 200 || res.status >= 300) {
        throw mapHttpError(res.status, res.headers, text, spec.path);
      }
      const json = parseJson(text);
      const resultCode = Number(json?.ResultCode ?? 0);
      if (resultCode !== 0) {
        throw mapResultError(resultCode, String(json?.Message ?? ""), spec.path);
      }
      return json as T;
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

/** Transport-level (non-2xx) failure — kept defensively, see class doc. */
export function mapHttpError(
  status: number,
  headers: { get(name: string): string | null },
  rawBody: string,
  context: string,
): MarketplaceError {
  const body = parseJson(rawBody);
  const message: string = body?.Message ?? rawBody?.slice(0, 200) ?? "";
  const retryAfterHeader = headers.get("retry-after");
  const retryAfterMs = retryAfterHeader
    ? Number(retryAfterHeader) * 1000
    : undefined;
  const retryable = status === 429 || status >= 500;
  return new MarketplaceError(
    `ESM 2.0 ${context} failed (HTTP ${status}): ${message}`,
    {
      marketplace: "esm_2_0",
      retryable,
      status,
      retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
    },
  );
}

/**
 * Body-level (`ResultCode` != 0) failure. Only the order-inquiry rate limit
 * (1 call / 5s / seller id, https://etapi.gmarket.com/198) is confirmed from
 * public docs, surfaced as a Korean message rather than a distinct code — so
 * we match on that message shape. Everything else is treated as a permanent
 * (non-retryable) validation/business error until a real `ResultCode`
 * taxonomy is confirmed live.
 */
export function mapResultError(
  resultCode: number,
  message: string,
  context: string,
): MarketplaceError {
  const isRateLimited = /초당|잠시 후 다시|다시 시도/.test(message);
  return new MarketplaceError(
    `ESM 2.0 ${context} failed (ResultCode ${resultCode}): ${message}`,
    {
      marketplace: "esm_2_0",
      retryable: isRateLimited,
      code: String(resultCode),
      retryAfterMs: isRateLimited ? 5_000 : undefined,
    },
  );
}
