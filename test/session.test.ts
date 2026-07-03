import { describe, expect, it } from "vitest";
import {
  getSessionSellerId,
  parseCookies,
  SESSION_COOKIE_NAME,
  sessionSetCookieHeader,
  signSessionValue,
  verifySessionValue,
} from "../src/auth/session.js";

const SECRET = "secret-a";

describe("session sign/verify", () => {
  it("round-trips a sellerId", () => {
    const value = signSessionValue("seller-123", SECRET);
    expect(verifySessionValue(value, SECRET)).toBe("seller-123");
  });

  it("rejects a tampered value", () => {
    const value = signSessionValue("seller-123", SECRET);
    const tampered = value.replace("seller-123", "seller-999");
    expect(verifySessionValue(tampered, SECRET)).toBeNull();
  });

  it("rejects a value signed with a different secret", () => {
    const value = signSessionValue("seller-123", SECRET);
    expect(verifySessionValue(value, "secret-b")).toBeNull();
  });

  it("rejects malformed/empty input without throwing", () => {
    expect(verifySessionValue(undefined, SECRET)).toBeNull();
    expect(verifySessionValue("", SECRET)).toBeNull();
    expect(verifySessionValue("no-signature", SECRET)).toBeNull();
  });
});

describe("parseCookies", () => {
  it("parses a standard cookie header", () => {
    expect(parseCookies("a=1; b=2")).toEqual({ a: "1", b: "2" });
  });

  it("returns empty object for undefined", () => {
    expect(parseCookies(undefined)).toEqual({});
  });
});

describe("getSessionSellerId", () => {
  it("extracts the sellerId from a request-shaped object", () => {
    const cookieHeader = sessionSetCookieHeader("seller-1", SECRET, { secure: false });
    const cookieValue = cookieHeader.split(";")[0].split("=").slice(1).join("=");
    const req = { headers: { cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` } };
    expect(getSessionSellerId(req, SECRET)).toBe("seller-1");
  });

  it("returns null when no cookie header is present", () => {
    expect(getSessionSellerId({ headers: {} }, SECRET)).toBeNull();
  });
});
