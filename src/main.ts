import { buildApp } from "./app.js";

/**
 * Process entrypoint: build the app and bind the HTTP listener.
 * Graceful shutdown on SIGINT/SIGTERM so in-flight requests drain.
 */
async function main(): Promise<void> {
  const { app, config } = buildApp();

  const close = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void close("SIGINT"));
  process.on("SIGTERM", () => void close("SIGTERM"));

  try {
    await app.listen({ port: config.PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err, "failed to start");
    process.exit(1);
  }
}

void main();
