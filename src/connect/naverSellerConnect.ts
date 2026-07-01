import type { MarketplaceAdapter } from "../integrations/marketplace.js";
import type { CredentialStore } from "../secrets/credentialStore.js";

/**
 * ARK-21: SELLER(솔루션 제공자) 모드 셀프서비스 connect.
 *
 * The seller supplies only their Naver `accountId` — no client_id/secret,
 * those are ARKAIN's app-level keys already configured (see
 * NaverAdapterConfig / env.ts). This is the write path the ARK-3 spike never
 * had (that CLI only ever read from `.env`); it verifies the account before
 * persisting so a mistyped id is never stored as if it worked.
 */

const NAVER_MARKETPLACE = "naver_smartstore" as const;

export interface ConnectionsWriteStore {
  upsertConnection(
    tenantId: string,
    marketplace: typeof NAVER_MARKETPLACE,
    stored: { ciphertext: string; keyVersion: number },
  ): Promise<{ id: string }>;
}

export interface NaverConnectDeps {
  adapter: MarketplaceAdapter;
  credentialStore: CredentialStore;
  store: ConnectionsWriteStore;
}

export type NaverConnectResult =
  | { ok: true; connectionId: string }
  | { ok: false; error: string };

/** A verify failure (bad account_id / no consent granted) is a normal,
 * expected outcome — reported, not thrown. A network/5xx/rate-limit error
 * from `verifyCredential` is NOT a verdict (see naver.adapter.ts) and is left
 * to propagate so the caller treats it as transient, not "invalid". */
export async function connectNaverSeller(
  deps: NaverConnectDeps,
  tenantId: string,
  accountId: string,
): Promise<NaverConnectResult> {
  const secret = { accountId };
  const valid = await deps.adapter.verifyCredential({
    sellerId: tenantId,
    marketplace: NAVER_MARKETPLACE,
    secret,
  });
  if (!valid) {
    return {
      ok: false,
      error: "네이버 계정 연결을 확인하지 못했습니다. 2단계 연결 허용을 다시 진행해주세요.",
    };
  }

  const stored = await deps.credentialStore.put(tenantId, NAVER_MARKETPLACE, secret);
  const conn = await deps.store.upsertConnection(tenantId, NAVER_MARKETPLACE, stored);
  return { ok: true, connectionId: conn.id };
}
