import express, { Request, Response, Router } from "express";
import httpStatus from "http-status";
import catchAsync from "../utils/catch-async";
import { checkDatabase } from "../config/prisma-client";
import { isRedisEnabled, pingRedis } from "../config/redis";

const router: Router = express.Router();

/**
 * Liveness and readiness in one endpoint.
 *
 * The process refuses to start without a database, but it can of course lose
 * one afterwards — a failover, a restart, a network partition — and nothing
 * else in the app would notice. This is how a load balancer or an uptime
 * check finds out: **503 whenever Postgres is unreachable**, so the instance
 * is pulled out of rotation instead of serving 500s.
 *
 * Redis is reported but never fails the check. It backs deferred side-effects
 * only, so an instance without it is degraded, not unfit to serve requests —
 * the same asymmetry the startup sequence applies.
 *
 * Deliberately unauthenticated, because the thing polling it generally cannot
 * hold a token, and deliberately thin: no version, no connection strings, no
 * error text. It answers "can this instance serve traffic", nothing more.
 */
/**
 * How long one probe result is reused.
 *
 * This endpoint is unauthenticated AND deliberately exempt from the rate
 * limiter, so without a cache every request anyone cares to send becomes a
 * database round-trip and a pool slot — an unauthenticated way to put load
 * on Postgres. A short window makes a flood cost one query per second while
 * still reflecting a real outage well inside any polling interval.
 */
const CACHE_MS = 1_000;

interface HealthSnapshot {
  at: number;
  status: number;
  body: Record<string, unknown>;
}

let snapshot: HealthSnapshot | null = null;

/** Exposed for tests; nothing in the app should need it. */
export const resetHealthCache = (): void => {
  snapshot = null;
};

const probe = async (): Promise<HealthSnapshot> => {
  const [database, redis] = await Promise.all([
    checkDatabase(),
    isRedisEnabled() ? pingRedis() : Promise.resolve(false),
  ]);

  return {
    at: Date.now(),
    status: database ? httpStatus.OK : httpStatus.SERVICE_UNAVAILABLE,
    body: {
      status: database ? "ok" : "unavailable",
      uptime: Math.floor(process.uptime()),
      services: {
        database: database ? "up" : "down",
        redis: !isRedisEnabled() ? "disabled" : redis ? "up" : "down",
      },
    },
  };
};

/** In-flight probe, so a burst of requests shares one round-trip. */
let pending: Promise<HealthSnapshot> | null = null;

router.get(
  "/",
  catchAsync(async (_req: Request, res: Response) => {
    if (!snapshot || Date.now() - snapshot.at > CACHE_MS) {
      // Collapse concurrent misses onto a single probe. Without this, forty
      // simultaneous requests on a cold cache would all miss and all query.
      pending ??= probe().finally(() => {
        pending = null;
      });
      snapshot = await pending;
    }

    // `uptime` is the one field that should never look stale.
    res
      .status(snapshot.status)
      .send({ ...snapshot.body, uptime: Math.floor(process.uptime()) });
  }),
);

export default router;
