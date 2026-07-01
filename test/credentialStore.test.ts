import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EnvelopeCredentialStore } from "../src/secrets/credentialStore.js";

function store(): EnvelopeCredentialStore {
  return new EnvelopeCredentialStore(randomBytes(32).toString("base64"));
}

describe("EnvelopeCredentialStore tenant separation (ARK-10)", () => {
  it("round-trips a secret for its own seller/marketplace", async () => {
    const s = store();
    const stored = await s.put("seller-a", "naver_smartstore", { token: "secret-a" });
    await expect(s.get(stored)).resolves.toEqual({ token: "secret-a" });
  });

  it("produces different ciphertext for the same secret across sellers (no shared/derivable state)", async () => {
    const s = store();
    const a = await s.put("seller-a", "naver_smartstore", { token: "same-secret" });
    const b = await s.put("seller-b", "naver_smartstore", { token: "same-secret" });
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("refuses to decrypt when the stored record is relabeled to a different seller", async () => {
    const s = store();
    const stored = await s.put("seller-a", "naver_smartstore", { token: "secret-a" });
    // Simulate a cross-tenant mixup bug: same ciphertext, wrong owning seller.
    const relabeled = { ...stored, sellerId: "seller-b" };
    await expect(s.get(relabeled)).rejects.toThrow();
  });

  it("refuses to decrypt when the stored record is relabeled to a different marketplace", async () => {
    const s = store();
    const stored = await s.put("seller-a", "naver_smartstore", { token: "secret-a" });
    const relabeled = { ...stored, marketplace: "coupang" as const };
    await expect(s.get(relabeled)).rejects.toThrow();
  });
});
