import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import type { MarketplaceId } from "../integrations/marketplace.js";

/**
 * How ARKAIN stores marketplace credentials.
 *
 * Threat model: a leaked database dump must NOT expose seller marketplace
 * tokens. So per-seller secrets are envelope-encrypted with AES-256-GCM before
 * they ever hit the DB. The data-encryption key (CREDENTIAL_ENC_KEY) lives in
 * the platform secret manager (not the DB, not the repo).
 *
 * Production plan (see ARCHITECTURE.md):
 *   - CREDENTIAL_ENC_KEY is injected by the secret manager (e.g. cloud KMS /
 *     SOPS / Vault), versioned for rotation.
 *   - Ciphertext + key version + iv + auth tag are persisted in the
 *     `seller_credentials` table; plaintext is held only in memory, briefly.
 *   - Access is per-integration, just-in-time — adapters receive a decrypted
 *     `SellerCredential` only for the duration of a sync call.
 *
 * This file ships a working AES-256-GCM implementation usable in dev today.
 */

export interface StoredCredential {
  sellerId: string;
  marketplace: MarketplaceId;
  /** base64(iv).base64(authTag).base64(ciphertext) */
  ciphertext: string;
  keyVersion: number;
}

export interface CredentialStore {
  put(
    sellerId: string,
    marketplace: MarketplaceId,
    secret: Record<string, string>,
  ): Promise<StoredCredential>;
  get(stored: StoredCredential): Promise<Record<string, string>>;
}

const ALGO = "aes-256-gcm";

/** AES-GCM AAD binding a credential to the seller/marketplace it belongs to
 * — see the ARK-10 comment on `put`/`get` below. */
function tenantAad(sellerId: string, marketplace: MarketplaceId): string {
  return `${sellerId}:${marketplace}`;
}

/**
 * Envelope encryption using a single symmetric key from config. Backed by an
 * in-memory map for dev; swap the map for the `seller_credentials` table in
 * ENG-Domain-Model without changing the crypto.
 */
export class EnvelopeCredentialStore implements CredentialStore {
  private readonly key: Buffer;
  readonly keyVersion = 1;

  constructor(encKeyBase64: string) {
    const key = Buffer.from(encKeyBase64, "base64");
    if (key.length !== 32) {
      throw new Error(
        `CREDENTIAL_ENC_KEY must decode to 32 bytes, got ${key.length}`,
      );
    }
    this.key = key;
  }

  async put(
    sellerId: string,
    marketplace: MarketplaceId,
    secret: Record<string, string>,
  ): Promise<StoredCredential> {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, this.key, iv);
    // ARK-10: bind the ciphertext to (sellerId, marketplace) as AES-GCM
    // additional authenticated data. Without this, `get()` would decrypt
    // whatever ciphertext it's handed regardless of which seller it's
    // "supposed" to belong to — the sellerId on `StoredCredential` would be
    // trusted metadata, not a cryptographic guarantee. With AAD, a
    // mismatched sellerId/marketplace (e.g. from a future cross-tenant query
    // bug) fails auth-tag verification instead of silently returning the
    // wrong seller's secret. See docs/multi-tenancy.md.
    cipher.setAAD(Buffer.from(tenantAad(sellerId, marketplace)));
    const plaintext = Buffer.from(JSON.stringify(secret), "utf8");
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      sellerId,
      marketplace,
      keyVersion: this.keyVersion,
      ciphertext: `${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}`,
    };
  }

  async get(stored: StoredCredential): Promise<Record<string, string>> {
    const parts = stored.ciphertext.split(".");
    if (parts.length !== 3) throw new Error("malformed ciphertext");
    const [ivB64, tagB64, ctB64] = parts as [string, string, string];
    const decipher = createDecipheriv(
      ALGO,
      this.key,
      Buffer.from(ivB64, "base64"),
    );
    decipher.setAAD(Buffer.from(tenantAad(stored.sellerId, stored.marketplace)));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(pt.toString("utf8")) as Record<string, string>;
  }
}
