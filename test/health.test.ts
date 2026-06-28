import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("health endpoint", () => {
  it("returns ok", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", service: "arkain" });
    await app.close();
  });

  it("rejects an invalid PORT at config load", async () => {
    expect(() =>
      buildApp({ NODE_ENV: "test", PORT: "not-a-number" } as NodeJS.ProcessEnv),
    ).toThrow(/Invalid environment configuration/);
  });
});
