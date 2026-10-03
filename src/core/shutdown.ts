import type { Server } from "node:http";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;

export function resolveShutdownTimeoutMs(value = process.env.NANOLLM_SHUTDOWN_TIMEOUT_MS) {
  const timeout = Number(value);
  return Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 2_147_483_647
    ? timeout
    : DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

export function installGracefulShutdown(options: {
  server: Server;
  stopBackgroundWork: () => void;
  cleanup: () => Promise<void>;
  timeoutMs?: number;
}) {
  const timeoutMs = options.timeoutMs ?? resolveShutdownTimeoutMs();
  // Reserve time for queued database writes after long-running streams are cut off.
  const drainMs = timeoutMs - Math.min(5_000, Math.ceil(timeoutMs / 5));
  let shuttingDown = false;
  let backgroundWorkStopped = false;
  let cleanupPromise: Promise<void> | undefined;
  const stopBackgroundWork = () => {
    if (backgroundWorkStopped) return;
    backgroundWorkStopped = true;
    options.stopBackgroundWork();
  };
  const cleanup = () => cleanupPromise ??= Promise.resolve().then(options.cleanup);

  options.server.on("request", (_request, response) => {
    response.once("finish", () => {
      if (shuttingDown) {
        // A connection that was busy at close() can become idle later.
        setImmediate(() => options.server.closeIdleConnections());
      }
    });
  });

  options.server.once("close", () => {
    // Also preserve cleanup for callers that close the exported server directly.
    void Promise.resolve().then(() => {
      stopBackgroundWork();
      return cleanup();
    }).catch((error) => {
      console.error("[SHUTDOWN] Cleanup failed:", error);
      process.exitCode = 1;
    });
  });

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[SHUTDOWN] Received ${signal}; draining requests for up to ${drainMs}ms`);
    const deadline = setTimeout(() => {
      console.error(`[SHUTDOWN] Cleanup exceeded ${timeoutMs}ms`);
      process.exit(1);
    }, timeoutMs);
    const drainDeadline = setTimeout(() => {
      console.log("[SHUTDOWN] Drain deadline reached; closing remaining HTTP connections");
      options.server.closeAllConnections();
    }, drainMs);

    try {
      stopBackgroundWork();
      await new Promise<void>((resolve, reject) => {
        options.server.close((error) => error ? reject(error) : resolve());
      });
      clearTimeout(drainDeadline);
      await cleanup();
      console.log("[SHUTDOWN] Complete; exiting with code 0");
      process.exit(0);
    } catch (error) {
      console.error("[SHUTDOWN] Failed:", error);
      process.exit(1);
    } finally {
      clearTimeout(deadline);
      clearTimeout(drainDeadline);
    }
  };

  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  return { isShuttingDown: () => shuttingDown };
}
