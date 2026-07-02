import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import { createAlertNotifier, createAlertThrottle } from "../src/alerting/notifier.js";

const silentLogger = pino({ enabled: false });

describe("createAlertNotifier", () => {
  it("logs but makes no network call when no webhook is configured", async () => {
    const fetchImpl = vi.fn();
    const notifier = createAlertNotifier({ env: "test" }, silentLogger, { fetchImpl });

    await notifier.send({ category: "sync_failure", message: "boom" });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts a Slack-compatible payload to the webhook when configured", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const notifier = createAlertNotifier(
      { env: "staging", webhookUrl: "https://hooks.example.com/alert" },
      silentLogger,
      { fetchImpl },
    );

    await notifier.send({
      category: "rate_limit",
      message: "naver_smartstore is being rate-limited",
      context: { connectionId: "conn-1" },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://hooks.example.com/alert");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.text).toContain("[ARKAIN/staging]");
    expect(body.text).toContain("rate_limit");
  });

  it("logs an error but does not throw when the webhook call fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const notifier = createAlertNotifier(
      { env: "production", webhookUrl: "https://hooks.example.com/alert" },
      silentLogger,
      { fetchImpl },
    );

    await expect(
      notifier.send({ category: "settlement_mismatch", message: "mismatch" }),
    ).resolves.toBeUndefined();
  });
});

describe("createAlertThrottle", () => {
  it("allows the first send and suppresses repeats within the window", () => {
    let clock = 0;
    const throttle = createAlertThrottle(1000, () => clock);

    expect(throttle.shouldSend("conn-1")).toBe(true);
    clock += 500;
    expect(throttle.shouldSend("conn-1")).toBe(false);

    clock += 501;
    expect(throttle.shouldSend("conn-1")).toBe(true);
  });

  it("tracks each key independently", () => {
    let clock = 0;
    const throttle = createAlertThrottle(1000, () => clock);

    expect(throttle.shouldSend("conn-1")).toBe(true);
    expect(throttle.shouldSend("conn-2")).toBe(true);
  });
});
