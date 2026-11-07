import Redis, { RedisOptions } from "ioredis";
import config from "./config";
import logger from "./logger";

/**
 * Redis connections, shaped for BullMQ.
 *
 * Two roles, deliberately NOT one shared client:
 *
 *   - "queue"  — producers. Lives on the HTTP request path (a controller
 *                enqueueing an order-confirmation email). Must fail fast:
 *                a request thread may never block on an unreachable Redis.
 *   - "worker" — consumers. Workers and QueueEvents use blocking commands
 *                (BZPOPMIN etc.) that legitimately sit idle for a long time,
 *                so they must NOT have a per-request retry ceiling.
 *   - "limiter" — the rate-limit store. Same fail-fast shape as "queue", for
 *                the same reason (it sits on the request path), but its own
 *                client so `CLIENT LIST` can tell a slow limiter apart from a
 *                slow enqueue, and so a future `keyPrefix` or database
 *                selection on one does not silently apply to the other.
 *
 * Those two requirements are contradictory, which is why one shared client
 * cannot serve both. BullMQ's own docs are explicit: for workers
 * `maxRetriesPerRequest` must be null or "the exceptions raised by Redis when
 * calling certain commands could break the worker functionality", while for
 * producers it "should either be left at its default ... or set to another
 * value, maybe 1". Share one null-retry client and a Redis outage turns every
 * enqueue into a hung HTTP request instead of a 500.
 *
 * Within a role the client IS shared. BullMQ accepts an existing ioredis
 * instance as `connection`, and a Worker still gets its own blocking socket
 * because it duplicates the connection internally. So N queues cost one
 * connection, while each worker costs roughly two.
 *
 * @see https://docs.bullmq.io/guide/connections
 * @see https://docs.bullmq.io/guide/going-to-production
 */

export type ConnectionRole = "queue" | "worker" | "limiter";

/** Give up on an initial TCP connect rather than hanging the boot sequence. */
const CONNECT_TIMEOUT_MS = 10_000;

/** How long a graceful QUIT may take before the socket is dropped instead. */
const QUIT_TIMEOUT_MS = 5_000;

/** Reconnect backoff ceiling. */
const MAX_RETRY_DELAY_MS = 10_000;

/**
 * Strip the password before a connection string reaches the logs. Managed
 * Redis URLs carry credentials inline, and logs travel further than they look.
 */
export const redactRedisUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return "<un-parseable REDIS_URL>";
  }
};

const baseOptions = (role: ConnectionRole): RedisOptions => ({
  // Importing this module must never open a socket: config is imported by
  // tests, by `prisma` scripts and by the CLI, none of which want Redis.
  // `initRedis()` performs the connect explicitly at startup instead.
  lazyConnect: true,

  // Shows up in `CLIENT LIST`, which is the only practical way to work out
  // which process is holding connections on a shared Redis instance.
  connectionName: `${config.REDIS.QUEUE_PREFIX}:${config.ENV}:${role}`,

  connectTimeout: CONNECT_TIMEOUT_MS,

  // Linear backoff with a ceiling. Returning a number keeps ioredis retrying;
  // returning anything else would make the outage permanent until restart.
  retryStrategy: (times: number): number =>
    Math.min(times * 500, MAX_RETRY_DELAY_MS),

  // NOTE: never set `keyPrefix` here. BullMQ does its own key prefixing and
  // ioredis's `keyPrefix` is documented as incompatible with it — the Lua
  // scripts build key names internally and would miss the prefix. Use
  // `config.REDIS.QUEUE_PREFIX` as BullMQ's own `prefix` option instead.
});

const optionsFor = (role: ConnectionRole): RedisOptions =>
  role !== "worker"
    ? {
        ...baseOptions(role),
        // One retry, then surface the error. A failed enqueue should become a
        // visible 5xx, not a request that waits for Redis to come back.
        maxRetriesPerRequest: 1,
        // Do not buffer commands issued while the socket is down; reject them.
        // Buffering looks like success to the caller and then silently
        // replays a stale job minutes later, after the HTTP response is gone.
        enableOfflineQueue: false,
      }
    : {
        ...baseOptions("worker"),
        // Required by BullMQ. Blocking reads have no business timing out.
        maxRetriesPerRequest: null,
        // Left on, per BullMQ's production guide: a worker reconnecting after
        // an outage should resume rather than drop its in-flight commands.
        enableOfflineQueue: true,
      };

const attachLogging = (client: Redis, role: ConnectionRole): void => {
  // A dropped Redis emits one `error` per retry attempt. Logging every one
  // buries everything else, so report the first and stay quiet until recovery.
  let errorLogged = false;

  client.on("ready", () => {
    logger.info(`[Redis:${role}] ${errorLogged ? "Reconnected" : "Connected"}`);
    errorLogged = false;
  });

  client.on("error", (err: Error) => {
    if (errorLogged) return;
    errorLogged = true;
    logger.error(`[Redis:${role}] ${err.message} — retrying in the background`);
  });

  client.on("end", () => {
    logger.warn(`[Redis:${role}] Connection closed`);
  });
};

/**
 * One client per role, created on first use. Mirrors `PrismaSingleton`:
 * every importer gets the same instance, so connection count stays a function
 * of roles and processes rather than of import sites.
 */
class RedisSingleton {
  private static readonly clients = new Map<ConnectionRole, Redis>();

  private constructor() {}

  public static getInstance(role: ConnectionRole): Redis {
    if (!config.REDIS.ENABLED) {
      // Deliberately a throw rather than a `null` return. Returning null would
      // push a null check into every queue, worker and controller that touches
      // Redis; reaching for a connection while Redis is switched off is a
      // wiring bug, and the toggle is meant to be read once, at registration.
      throw new Error(
        "Redis is disabled (REDIS_ENABLED=false). Guard queue registration " +
          "with isRedisEnabled() instead of requesting a connection.",
      );
    }

    const existing = RedisSingleton.clients.get(role);
    if (existing) return existing;

    const client = new Redis(config.REDIS.URL, optionsFor(role));
    attachLogging(client, role);
    RedisSingleton.clients.set(role, client);
    return client;
  }

  public static entries(): [ConnectionRole, Redis][] {
    return [...RedisSingleton.clients.entries()];
  }

  public static clear(): void {
    RedisSingleton.clients.clear();
  }
}

/** Whether queues and workers should be registered at all. */
export const isRedisEnabled = (): boolean => config.REDIS.ENABLED;

/**
 * Shared connection for BullMQ producers — `new Queue(name, { connection })`.
 * Fails fast when Redis is unreachable.
 */
export const getQueueConnection = (): Redis =>
  RedisSingleton.getInstance("queue");

/**
 * Shared connection for the rate-limit store.
 *
 * Fail-fast like the producer connection, because this is on the request
 * path. The limiter is configured with `passOnStoreError: true`, so a Redis
 * outage degrades it to "allow" rather than turning every request into a 500
 * — see `middlewares/rate-limiter.middleware.ts` for why that is the right
 * direction to fail for this particular control.
 */
export const getLimiterConnection = (): Redis =>
  RedisSingleton.getInstance("limiter");

/**
 * Shared connection for BullMQ consumers — `new Worker(name, fn, { connection })`
 * and `new QueueEvents(name, { connection })`. BullMQ duplicates this
 * internally for each worker's blocking socket.
 */
export const getWorkerConnection = (): Redis =>
  RedisSingleton.getInstance("worker");

/**
 * Open connections at boot so the first enqueue does not pay for the
 * handshake, and so a misconfigured Redis is reported at startup rather than
 * on the first customer order.
 *
 * Defaults to the producer and limiter roles, because the API process
 * enqueues and rate-limits but does not consume. A worker entrypoint asks for
 * what it needs instead:
 *
 *     await initRedis(["queue", "worker"]);
 *
 * Opening a role here is an optimisation, not a requirement — any role still
 * connects lazily on first use if `initRedis` was never told about it.
 *
 * Does NOT exit the process on failure, unlike the Prisma connect in
 * `index.ts`. Postgres is load-bearing for every request; Redis backs
 * asynchronous side-effects (transactional email, WhatsApp), so the API stays
 * useful without it and ioredis keeps retrying in the background.
 */
export const initRedis = async (
  roles: ConnectionRole[] = ["queue", "limiter"],
): Promise<void> => {
  if (!config.REDIS.ENABLED) {
    logger.info(
      "[Redis] Disabled via REDIS_ENABLED=false — queues will not be registered",
    );
    return;
  }

  if (roles.length === 0) return;

  try {
    const clients = roles.map((role) => RedisSingleton.getInstance(role));
    await Promise.all(clients.map((client) => client.connect()));
    // Round-trip one command: a successful TCP connect still says nothing
    // about auth, the selected database, or a proxy that accepts and drops.
    await clients[0]!.ping();
    logger.info(`[Redis] Ready => ${redactRedisUrl(config.REDIS.URL)}`);
  } catch (err) {
    logger.error(
      `[Redis] Initial connection to ${redactRedisUrl(config.REDIS.URL)} ` +
        `failed: ${(err as Error).message}. The API will serve requests, but ` +
        "queued work will not run until Redis is reachable.",
    );
  }
};

/** Liveness probe for a health endpoint. Never throws. */
/**
 * How long the health probe waits for a PONG.
 *
 * Mirrors `PROBE_TIMEOUT_MS` in prisma-client, and for the same reason: a
 * host that accepts the TCP connection and then stops answering — a
 * failover, a hung proxy — leaves `ping()` pending forever. `/api/health`
 * awaits this inside a `Promise.all`, so an unbounded ping hangs the whole
 * endpoint past the load balancer's own timeout and the instance is pulled
 * from rotation over a dependency that is explicitly allowed to be down.
 */
const PING_TIMEOUT_MS = 2_000;

export const pingRedis = async (): Promise<boolean> => {
  if (!config.REDIS.ENABLED) return false;

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      getQueueConnection()
        .ping()
        .then((reply) => reply === "PONG"),
      new Promise<boolean>((resolve) => {
        // Resolves false rather than rejecting: a timed-out ping is simply
        // "redis is down", which is a reportable state, not an error.
        timer = setTimeout(() => resolve(false), PING_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return false;
  } finally {
    // Unref'd either way would do, but clearing is exact: a pending timer
    // holds the event loop open and would delay a graceful shutdown.
    if (timer) clearTimeout(timer);
  }
};

const shutdownClient = async (
  role: ConnectionRole,
  client: Redis,
): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.quit(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`QUIT timed out after ${QUIT_TIMEOUT_MS}ms`)),
          QUIT_TIMEOUT_MS,
        );
      }),
    ]);
    logger.info(`[Redis:${role}] Closed gracefully`);
  } catch (err) {
    // `quit()` sends QUIT and waits for the reply, which never arrives if
    // Redis is already gone — that hangs shutdown forever. Drop the socket.
    client.disconnect();
    logger.warn(
      `[Redis:${role}] Graceful close failed (${(err as Error).message}); ` +
        "socket dropped",
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Close every open connection.
 *
 * Shutdown order matters and this is the LAST step: close workers
 * (`await worker.close()`), then queues (`await queue.close()`), then call
 * this. Closing the shared connection first would strand in-flight jobs,
 * which other workers then have to recover as stalled ~30s later.
 */
export const closeRedis = async (): Promise<void> => {
  const clients = RedisSingleton.entries();
  if (clients.length === 0) return;

  await Promise.all(
    clients.map(([role, client]) => shutdownClient(role, client)),
  );
  RedisSingleton.clear();
};
