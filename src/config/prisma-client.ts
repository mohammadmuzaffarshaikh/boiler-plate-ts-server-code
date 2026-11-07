import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import config from "./config";
import logger from "./logger";
import { redactUrlPassword } from "../utils/redact";

/**
 * The Postgres connection, and the only honest way to ask whether it works.
 *
 * THE TRAP THIS FILE EXISTS TO CLOSE:
 * `prisma.$connect()` is not a connectivity check when a driver adapter is in
 * use. The pool is created lazily, so `$connect()` resolves happily against a
 * port with nothing listening and the *first real query* is what fails. A
 * server that trusts it logs "Connected to PostgreSQL", starts accepting
 * traffic, and then answers every request with a 500 — a worse outcome than
 * refusing to boot. `connectDatabase()` below round-trips a real query.
 */

/** Connection string with the password masked, for logs. */
export const safeDatabaseUrl = (): string =>
  redactUrlPassword(config.DATABASE.URL, "DATABASE_URL");

class PrismaSingleton {
  private static instance: PrismaClient;

  private constructor() {}

  public static getInstance(): PrismaClient {
    if (!PrismaSingleton.instance) {
      const adapter = new PrismaPg({
        connectionString: config.DATABASE.URL,

        // node-pg leaves this unset, meaning "wait forever". Against a
        // database that is unreachable but not refusing connections — a
        // dropped firewall rule, a dead host, a failover — every request
        // would hang instead of erroring, and the process would pile them up
        // until it fell over. This is the single most important line here.
        connectionTimeoutMillis: config.DATABASE.CONNECT_TIMEOUT_MS,

        max: config.DATABASE.POOL_MAX,
        idleTimeoutMillis: config.DATABASE.IDLE_TIMEOUT_MS,

        // Server-side ceiling on one statement, so a runaway query releases
        // its pooled connection instead of holding it until someone notices.
        ...(config.DATABASE.STATEMENT_TIMEOUT_MS > 0
          ? { statement_timeout: config.DATABASE.STATEMENT_TIMEOUT_MS }
          : {}),

        // Shows up in pg_stat_activity, which is the only practical way to
        // tell which process is holding connections on a shared instance.
        application_name: `boilerplate-${config.ENV}`,
      });

      PrismaSingleton.instance = new PrismaClient({
        adapter,
        // Prisma's own `info` level narrates pool activity on every boot and
        // adds nothing outside development.
        log:
          config.ENV === "development" ? ["info", "warn", "error"] : ["warn", "error"],
      });
    }

    return PrismaSingleton.instance;
  }
}

export const prisma = PrismaSingleton.getInstance();

/** Prisma errors are multi-line with a code frame; logs want one line. */
const firstLine = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .pop() ?? "unknown error"
  );
};

/**
 * How long the health probe waits before calling the database down.
 *
 * Deliberately far below `DB_CONNECT_TIMEOUT_MS`. Against a host that drops
 * packets rather than refusing — a stale firewall rule, a dead node, a
 * failover in progress — the pool waits the full connect timeout, so an
 * unbounded probe blocks for ten seconds. That is longer than any sensible
 * load balancer's own timeout, so the check would be recorded as a timeout
 * instead of as a clean "unhealthy", and the request would hold a pool slot
 * the whole time. Measured at 10.1s before this existed.
 */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Is the database actually answering?
 *
 * Never throws — it backs the health endpoint, where an exception would turn
 * "the database is down" into "the health check is down".
 *
 * Note the losing side of the race is abandoned, not cancelled: the query
 * keeps running in the pool. That is why the health route caches its answer
 * rather than probing on every request.
 */
export const checkDatabase = async (
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`health probe timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Open the connection and prove it works, retrying a bounded number of times.
 *
 * Retries exist for one specific, common situation: the app and the database
 * start together (compose, a pod restart, a host reboot) and Postgres is a
 * second or two behind. Exiting instantly there produces a crash loop that
 * looks like a configuration problem but is only a race.
 *
 * It is bounded on purpose. After the last attempt this throws, and the
 * caller exits non-zero — the process must never reach `app.listen()` with an
 * unproven database. "Retry forever" would leave a container that is
 * permanently "starting" and never reports itself unhealthy.
 *
 * @throws when every attempt fails.
 */
export const connectDatabase = async (): Promise<void> => {
  const attempts = config.DATABASE.CONNECT_RETRIES + 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await prisma.$connect();
      // The round-trip is the actual check; see the note at the top.
      await prisma.$queryRaw`SELECT 1`;

      if (attempt > 1) {
        logger.info(`[Database] Connected on attempt ${attempt}/${attempts}`);
      }
      return;
    } catch (err) {
      lastError = err;

      if (attempt === attempts) break;

      const delay = config.DATABASE.CONNECT_RETRY_DELAY_MS * 2 ** (attempt - 1);
      logger.warn(
        `[Database] Attempt ${attempt}/${attempts} failed ` +
          `(${firstLine(err)}); retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }

  throw new Error(
    `Could not reach the database at ${safeDatabaseUrl()} after ${attempts} ` +
      `attempt(s): ${firstLine(lastError)}`,
    { cause: lastError },
  );
};

export const disconnectDatabase = async (): Promise<void> => {
  await prisma.$disconnect();
};
