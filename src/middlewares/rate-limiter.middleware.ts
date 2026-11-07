import { NextFunction, Request, Response } from "express";
import rateLimit, {
  ipKeyGenerator,
  Options,
  RateLimitRequestHandler,
} from "express-rate-limit";
import httpStatus from "http-status";
import { RedisStore } from "rate-limit-redis";
import config from "../config/config";
import { getLimiterConnection, isRedisEnabled } from "../config/redis";
import logger from "../config/logger";
import ApiError from "../utils/api-error";

const MINUTE_MS = 60 * 1000;

/**
 * Where the counters live.
 *
 * The default is express-rate-limit's in-process MemoryStore, and it is only
 * correct at one instance. Counters are per-process, so N instances behind a
 * load balancer give every limit a real ceiling of N x limit — the 20-per-
 * window login cap silently becomes 20N, and nothing anywhere reports that
 * the control has been weakened. `ecosystem.config.json` runs `instances: 1`
 * today, which is the only reason this was not already a live hole.
 *
 * With Redis switched on, every instance increments the same key and the
 * configured number is the number.
 *
 * Built once per limiter, at module load, deliberately — a store created per
 * request would reset the counters it exists to keep.
 */
const buildStore = (name: string): RedisStore | undefined => {
  if (!isRedisEnabled()) return undefined;

  const client = getLimiterConnection();

  return new RedisStore({
    // Namespaced away from BullMQ, which owns its own keys under the same
    // prefix. `rl:` then `name` so one limiter's bucket cannot be read or
    // cleared as another's, and so `SCAN rl:auth:*` is a usable operation.
    prefix: `${config.REDIS.QUEUE_PREFIX}:rl:${name}:`,
    // ioredis's `call` is typed with a required first argument, which a
    // plain spread of `string[]` cannot satisfy. Destructured so the command
    // name and its arguments are separate, which is also what it is.
    sendCommand: (command: string, ...args: string[]) =>
      client.call(command, ...args) as Promise<never>,
  });
};

/**
 * Say out loud what the default costs, once per process.
 *
 * `buildStore` above explains why MemoryStore is only correct at one
 * instance. What was missing is anything that says so at runtime: the
 * shipped default is `REDIS_ENABLED=false` (.env.example), so the weak
 * configuration is the one you get by not deciding, and raising `instances`
 * in ecosystem.config.json or putting a second container behind the same
 * load balancer multiplies every limit by N in complete silence. The login
 * cap reads 20 in the code and is 20N in fact.
 *
 * A warning and not a refusal: one instance with MemoryStore is a legitimate
 * production deployment, and ecosystem.config.json pins exactly that today.
 * The failure is in scaling out without revisiting it, which is a thing to
 * be told about rather than prevented from booting.
 */
if (config.ENV === "production" && !isRedisEnabled()) {
  logger.warn(
    "[RateLimit] REDIS_ENABLED=false in production — counters are kept per " +
      "process. This is correct at exactly one instance; each additional " +
      "instance multiplies every rate limit by one. Set REDIS_ENABLED=true " +
      "(and REDIS_URL) before scaling out.",
  );
}

interface LimiterOptions {
  /**
   * Short identifier for this limiter's key namespace in Redis.
   *
   * Must be unique and must not change casually: renaming it abandons the
   * buckets in flight, which hands everyone currently rate-limited a clean
   * slate at deploy.
   */
  name: string;
  /** Length of the sliding window, in minutes. */
  windowMinutes: number;
  /** Requests allowed per key, per window. */
  limit: number;
  /** Message returned to the client on a 429. */
  message: string;
  /**
   * Don't count requests that ended 2xx/3xx. Use on credential endpoints so a
   * legitimate user working normally is never locked out — only failures burn
   * quota, which is exactly the brute-force signal we want to cap.
   */
  skipSuccessfulRequests?: boolean;
  /** Override the bucket key. Defaults to the client IP. */
  keyGenerator?: Options["keyGenerator"];
}

/**
 * Build a rate limiter wired into this app's conventions.
 *
 * Two things every limiter here gets:
 *
 * 1. The 429 is raised as an `ApiError` through `next()` rather than written
 *    directly by express-rate-limit, so it flows through `errorHandler` and
 *    comes back in the same `{ code, message }` envelope as every other error.
 * 2. Limiting is disabled under NODE_ENV=test. Counters are process-global and
 *    survive between test cases, so leaving it on makes test suites fail in
 *    whatever order happens to exhaust a bucket first.
 * 3. The counters live in Redis when Redis is enabled, and in process memory
 *    when it is not — see `buildStore`. A memory store is only correct at one
 *    instance, and gets quietly wrong rather than loudly wrong when that
 *    changes.
 */
export const createRateLimiter = ({
  name,
  windowMinutes,
  limit,
  message,
  skipSuccessfulRequests = false,
  keyGenerator,
}: LimiterOptions): RateLimitRequestHandler => {
  const store = buildStore(name);

  if (store) {
    logger.info(`[RateLimit:${name}] Counters in Redis`);
  }

  return rateLimit({
    windowMs: windowMinutes * MINUTE_MS,
    limit,
    skipSuccessfulRequests,
    ...(keyGenerator ? { keyGenerator } : {}),
    ...(store ? { store } : {}),
    // RateLimit-* headers per the IETF draft; drop the legacy X-RateLimit-*.
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: () => config.ENV === "test",
    // FAIL OPEN, and only here. If Redis is unreachable the request is
    // allowed through rather than 500ing, which is the same call
    // `config/redis.ts` already makes for the process as a whole: Postgres is
    // load-bearing for every request, Redis backs things the API can survive
    // without. Rate limiting is a backstop against noise and brute force, not
    // the control that stops either — the per-account lockout in
    // `auth.service` is, and that one lives in Postgres and does not move.
    // Failing closed here would mean a Redis blip takes the whole API down,
    // which is a larger and more likely outage than the one it would prevent.
    passOnStoreError: true,
    handler: (_req: Request, _res: Response, next: NextFunction) => {
      next(new ApiError(httpStatus.TOO_MANY_REQUESTS, message));
    },
  });
};

/** Normalised client IP. IPv6 is masked to a /56 so one client can't rotate
 *  through its own prefix to get a fresh bucket per request. */
const ipKey = (req: Request): string => ipKeyGenerator(req.ip ?? "");

/** Lower-cased `email` from the request body, if the route carries one. */
const bodyEmail = (req: Request): string => {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === "string" ? email.trim().toLowerCase() : "";
};

/**
 * Blanket ceiling for the whole API.
 *
 * Not a security control on its own — it is the backstop that keeps a single
 * misbehaving client (runaway retry loop, scraper, cheap flood) from
 * saturating the process. Deliberately generous so normal browsing of a
 * storefront never touches it.
 */
export const globalLimiter: RateLimitRequestHandler = createRateLimiter({
  name: "global",
  windowMinutes: config.RATE_LIMIT.GLOBAL.WINDOW_MINUTES,
  limit: config.RATE_LIMIT.GLOBAL.MAX,
  message: "Too many requests. Please try again later.",
});

/**
 * Credential endpoints: login, register, token refresh, Google sign-in.
 *
 * Complements the per-account lockout in `auth.service.ts`. The lockout stops
 * one account being ground down; this stops one IP spraying one password
 * across many accounts, which never trips a per-account counter.
 */
export const authLimiter: RateLimitRequestHandler = createRateLimiter({
  name: "auth",
  windowMinutes: config.RATE_LIMIT.AUTH.WINDOW_MINUTES,
  limit: config.RATE_LIMIT.AUTH.MAX,
  message: "Too many authentication attempts. Please try again later.",
  skipSuccessfulRequests: true,
});

/**
 * Password reset, keyed by IP — caps enumeration sweeps from one source.
 *
 * Chain with `passwordResetEmailLimiter`: this one alone is bypassed by a
 * botnet, that one alone is bypassed by varying the address.
 */
export const passwordResetIpLimiter: RateLimitRequestHandler =
  createRateLimiter({
    name: "pwreset-ip",
    windowMinutes: config.RATE_LIMIT.PASSWORD_RESET.WINDOW_MINUTES,
    limit: config.RATE_LIMIT.PASSWORD_RESET.IP_MAX,
    message: "Too many password reset requests. Please try again later.",
  });

/**
 * Password reset, keyed by target email address.
 *
 * Stops someone flooding one person's inbox from many IPs. Worth its own
 * bucket because reset mail is the one endpoint where an anonymous caller
 * makes us send outbound email — it costs money and burns sender reputation.
 *
 * Falls back to the IP when no email is supplied, so a malformed-body flood
 * is still bounded (the request would 400 at validation regardless).
 */
export const passwordResetEmailLimiter: RateLimitRequestHandler =
  createRateLimiter({
    name: "pwreset-email",
    windowMinutes: config.RATE_LIMIT.PASSWORD_RESET.WINDOW_MINUTES,
    limit: config.RATE_LIMIT.PASSWORD_RESET.EMAIL_MAX,
    message:
      "Too many password reset requests for this account. Please try again later.",
    keyGenerator: (req: Request) => bodyEmail(req) || ipKey(req),
  });

/**
 * File uploads.
 *
 * Its own bucket because an upload is far more expensive than a normal
 * request — it holds a connection for the length of a 100 MB transfer, costs
 * temp disk, and ends in a billable write to R2. The global limiter is too
 * generous to bound that, and these routes are staff-only, so the limit can
 * be tight without affecting shoppers.
 */
export const uploadLimiter: RateLimitRequestHandler = createRateLimiter({
  name: "upload",
  windowMinutes: config.RATE_LIMIT.UPLOAD.WINDOW_MINUTES,
  limit: config.RATE_LIMIT.UPLOAD.MAX,
  message: "Too many uploads. Please try again later.",
});
