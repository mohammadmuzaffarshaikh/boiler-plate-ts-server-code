import request from "supertest";
import httpStatus from "http-status";
import app from "../../src/app";
import * as prismaClient from "../../src/config/prisma-client";
import { resetHealthCache } from "../../src/routes/health.routes";
import config from "../../src/config/config";
import { assertDatabaseReachable, disconnect } from "../helpers/db";

/**
 * GET /api/health
 *
 * The process refuses to start without a database, but it can lose one
 * afterwards — a failover, a restart, a partition — and nothing else in the
 * app would notice. This endpoint is how a load balancer finds out.
 */
describe("health route", () => {
  beforeAll(async () => {
    await assertDatabaseReachable();
  });

  afterAll(async () => {
    await disconnect();
  });

  // The route caches its answer for a second, so every spec must start from
  // a cold cache or it reads the previous one's result.
  beforeEach(() => {
    resetHealthCache();
  });

  it("answers 200 while the database is reachable", async () => {
    const res = await request(app).get("/api/health");

    expect(res.status).toBe(httpStatus.OK);
    expect(res.body).toMatchObject({
      status: "ok",
      services: { database: "up" },
    });
    expect(res.body.uptime).toEqual(expect.any(Number));
  });

  it("answers 503 when the database has gone away", async () => {
    jest.spyOn(prismaClient, "checkDatabase").mockResolvedValue(false);

    const res = await request(app).get("/api/health");

    // 503 is what takes the instance out of rotation. Answering 200 here
    // would leave it serving 500s to real traffic.
    expect(res.status).toBe(httpStatus.SERVICE_UNAVAILABLE);
    expect(res.body).toMatchObject({
      status: "unavailable",
      services: { database: "down" },
    });
  });

  it("reports Redis without ever failing on it", async () => {
    // Redis backs deferred side-effects only, so an instance without it is
    // degraded, not unfit to serve requests — the same asymmetry the startup
    // sequence applies.
    const res = await request(app).get("/api/health");

    expect(res.status).toBe(httpStatus.OK);

    if (config.REDIS.ENABLED) {
      expect(["up", "down"]).toContain(res.body.services.redis);
    } else {
      expect(res.body.services.redis).toBe("disabled");
    }
    // Whatever Redis is doing, the overall verdict follows the database.
    expect(res.body.status).toBe("ok");
  });

  it("needs no authentication", async () => {
    // Whatever polls it generally cannot hold a token.
    await request(app).get("/api/health").expect(httpStatus.OK);
  });

  it("leaks no connection details", async () => {
    const body = JSON.stringify((await request(app).get("/api/health")).body);

    expect(body).not.toContain("postgres://");
    expect(body).not.toContain("mysecretpassword");
    expect(body.toLowerCase()).not.toContain("localhost");
  });

  it("serves a burst from one database round-trip", async () => {
    // Unauthenticated and exempt from the rate limiter, so without the cache
    // every request anyone sends is a query and a pool slot.
    const probe = jest.spyOn(prismaClient, "checkDatabase").mockResolvedValue(true);

    await Promise.all(
      Array.from({ length: 50 }, () => request(app).get("/api/health")),
    );

    expect(probe.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("stops serving a stale 'ok' once the cache expires", async () => {
    jest.spyOn(prismaClient, "checkDatabase").mockResolvedValue(true);
    await request(app).get("/api/health").expect(httpStatus.OK);

    jest.spyOn(prismaClient, "checkDatabase").mockResolvedValue(false);
    // Still cached.
    await request(app).get("/api/health").expect(httpStatus.OK);

    await new Promise((r) => setTimeout(r, 1100));
    await request(app).get("/api/health").expect(httpStatus.SERVICE_UNAVAILABLE);
  });

  it("is not behind the global rate limiter", async () => {
    // A load balancer polls on a fixed interval from one address — exactly
    // the shape the limiter exists to stop. Being throttled out of its own
    // health check would report a healthy instance as down.
    const statuses = await Promise.all(
      Array.from({ length: 40 }, () =>
        request(app).get("/api/health").then((r) => r.status),
      ),
    );

    expect(statuses.every((s) => s === httpStatus.OK)).toBe(true);
  });
});
