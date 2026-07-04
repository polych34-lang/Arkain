import type { MarketplaceAdapter } from "../integrations/marketplace.js";
import type { CredentialStore } from "../secrets/credentialStore.js";

/**
 * ARK-74: seller self-service connect for 쿠팡, same shape as ARK-21's
 * `connectNaverSeller`. Unlike Naver's SELLER mode, 쿠팡 has no ARKAIN-level
 * app credential or OAuth consent screen (docs/coupang-integration.md §2) —
 * the seller supplies their own `vendorId`/`accessKey`/`secretKey`, issued
 * from 쿠팡 WING > 오픈API 관리. This function only verifies + persists; it
 * does not touch `CoupangAdapter`/HTTP/mapper internals.
 */

const COUPANG_MARKETPLACE = "coupang" as const;

export interface CoupangCredentialInput {
  vendorId: string;
  accessKey: string;
  secretKey: string;
}

export interface ConnectionsWriteStore {
  upsertConnection(
    tenantId: string,
    marketplace: typeof COUPANG_MARKETPLACE,
    stored: { ciphertext: string; keyVersion: number },
  ): Promise<{ id: string }>;
}

export interface CoupangConnectDeps {
  adapter: MarketplaceAdapter;
  credentialStore: CredentialStore;
  store: ConnectionsWriteStore;
}

export type CoupangConnectResult =
  | { ok: true; connectionId: string }
  | { ok: false; error: string };

/** Same posture as `connectNaverSeller`: a verify failure (bad keys) is a
 * normal, expected outcome — reported, not thrown. A network/5xx/rate-limit
 * error from `verifyCredential` is not a verdict and is left to propagate. */
export async function connectCoupangSeller(
  deps: CoupangConnectDeps,
  tenantId: string,
  credential: CoupangCredentialInput,
): Promise<CoupangConnectResult> {
  const secret = {
    vendorId: credential.vendorId,
    accessKey: credential.accessKey,
    secretKey: credential.secretKey,
  };
  const valid = await deps.adapter.verifyCredential({
    sellerId: tenantId,
    marketplace: COUPANG_MARKETPLACE,
    secret,
  });
  if (!valid) {
    return {
      ok: false,
      error: "쿠팡 연동을 확인하지 못했습니다. Vendor ID/Access Key/Secret Key를 다시 확인해주세요.",
    };
  }

  const stored = await deps.credentialStore.put(tenantId, COUPANG_MARKETPLACE, secret);
  const conn = await deps.store.upsertConnection(tenantId, COUPANG_MARKETPLACE, stored);
  return { ok: true, connectionId: conn.id };
}
