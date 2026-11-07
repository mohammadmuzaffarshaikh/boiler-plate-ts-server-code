import app from "./app";
import config from "./config/config";
import logger from "./config/logger";
import { Server } from "http";
import {
  connectDatabase,
  disconnectDatabase,
  safeDatabaseUrl,
} from "./config/prisma-client";
import { initRedis, closeRedis } from "./config/redis";
import registerCronJobs from "./jobs";

let server: Server | undefined;

logger.info(`Node Environment => ${config.ENV}`);

/**
 * Start the process, in a fixed order with the database first.
 *
 * Nothing that can accept a request happens before the connection is proven.
 * Each step reports its own failure, because a single catch around all of
 * them used to blame the database for an occupied port.
 */
async function startServer(): Promise<void> {
  try {
    await connectDatabase();
    // Password masked: managed Postgres puts credentials inline in the URL,
    // and this line previously printed them in full on every boot.
    logger.info(`Connected to PostgreSQL (via Prisma) => ${safeDatabaseUrl()}`);
  } catch (error) {
    logger.error((error as Error).message);
    logger.error(
      "Refusing to start without a database. Check DATABASE_URL and that " +
        "Postgres is reachable, then start again.",
    );
    process.exit(1);
  }

  try {
    registerCronJobs();
    logger.info("Cron jobs registered successfully.");
  } catch (error) {
    logger.error("Failed to register cron jobs", error);
    process.exit(1);
  }

  // Producer connection only — this process enqueues, it does not consume.
  // A worker entrypoint would call initRedis(["queue", "worker"]).
  //
  // initRedis reports its own failures and always resolves, so an unreachable
  // Redis never stops startup. That asymmetry with the database above is the
  // point: Postgres is load-bearing for every request, Redis only backs
  // deferred side-effects.
  await initRedis();

  await listen();
}

/**
 * Bind the port, and only report success once it is genuinely bound.
 *
 * TWO THINGS HERE ARE NOT OBVIOUS:
 *
 * 1. Express calls the `app.listen(port, callback)` callback even when the
 *    bind FAILED. On EADDRINUSE the order is: callback, then the `error`
 *    event, with `server.listening` still false throughout. Logging from
 *    that callback meant the process announced "listening on port 8080" and
 *    then died — and `startServer()` had already been told it succeeded.
 *    The `listening` EVENT is the one that only fires on a real bind.
 *
 * 2. `listen` reports EADDRINUSE and EACCES asynchronously, so a try/catch
 *    around it catches nothing; the failure used to surface as an unhandled
 *    exception attributed to whatever ran next.
 */
const listen = (): Promise<void> =>
  new Promise((resolve) => {
    const httpServer = app.listen(config.PORT);
    server = httpServer;

    httpServer.once("listening", () => {
      logger.info(`Node server listening on port => ${config.PORT}`);
      resolve();
    });

    httpServer.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        logger.error(
          `Port ${config.PORT} is already in use. Stop the other process or ` +
            "set PORT to something else.",
        );
      } else if (error.code === "EACCES") {
        logger.error(
          `Not permitted to bind port ${config.PORT}. Ports below 1024 need ` +
            "elevated privileges.",
        );
      } else {
        logger.error("HTTP server error", error);
      }
      process.exit(1);
    });
  });

// Start the app. Any failure inside has already been reported and exited;
// this catch is the backstop for anything unforeseen.
startServer().catch((error) => {
  logger.error("Failed to start server", error);
  process.exit(1);
});

/**
 * Close everything once, in the right order, then leave.
 *
 * Previously this logic was spread over three handlers that had drifted
 * apart, and two of them could not work:
 *
 *   - the SIGTERM handler never called `process.exit`, and `registerCronJobs`
 *     leaves node-cron timers armed, so the process lingered until the
 *     orchestrator SIGKILLed it — racing the cleanup it had just started;
 *   - `process.on("exit")` ran an async handler, but the event loop is
 *     already drained by then, so neither the `server.close` callback nor
 *     `closeRedis()` ever executed.
 *
 * One function, called from every signal, fixes both. `shuttingDown` guards
 * against a second signal arriving mid-shutdown.
 */
let shuttingDown = false;

/**
 * How long the whole shutdown may take before the process leaves anyway.
 *
 * A request still in flight holds `server.close()` open, and a 95 MB upload
 * streaming to R2 is exactly that. Draining is wanted; draining forever is
 * not, and waiting for the orchestrator's SIGKILL instead is strictly worse
 * because nothing after that point runs at all.
 */
const SHUTDOWN_TIMEOUT_MS = 10_000;

const shutdown = async (reason: string, code = 0): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(`Shutting down (${reason})`);

  // `unref` so the watchdog never keeps an otherwise-finished process alive;
  // the `finally` below exits first in the normal case.
  const watchdog = setTimeout(() => {
    logger.error(
      `Shutdown did not finish within ${SHUTDOWN_TIMEOUT_MS}ms; exiting anyway.`,
    );
    process.exit(code);
  }, SHUTDOWN_TIMEOUT_MS);
  watchdog.unref();

  try {
    if (server) {
      // Stop accepting connections and let in-flight requests drain.
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      logger.info("Server closed");
    }

    // Order matters. Once BullMQ lands: await worker.close(), then
    // queue.close(), and only then closeRedis(). Dropping the shared
    // connection first strands in-flight jobs, which another worker then has
    // to recover as stalled ~30s later.
    await closeRedis();
    await disconnectDatabase();
  } catch (error) {
    // A failing cleanup step must never stop the process leaving. Without
    // the `finally` below, a throw here skipped `process.exit` entirely —
    // and because the rejection re-entered `shutdown` through
    // `unhandledRejection`, the guard above swallowed the second attempt and
    // the process hung until it was killed.
    logger.error(`Error during shutdown: ${(error as Error).message}`);
  } finally {
    clearTimeout(watchdog);
    process.exit(code);
  }
};

const unexpectedErrorHandler = (error: Error) => {
  logger.error("Unexpected error:", error);
  void shutdown("unexpected error", 1);
};

process.on("uncaughtException", unexpectedErrorHandler);
process.on("unhandledRejection", unexpectedErrorHandler);

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT")); // Ctrl+C

// NOTE: no `process.on("exit")` handler. The event loop is already drained
// by the time it fires, so nothing asynchronous — closing the server,
// Redis, Prisma — can run there. Shutdown is driven by the signals above.
