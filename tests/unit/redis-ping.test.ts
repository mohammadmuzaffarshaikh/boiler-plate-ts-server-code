import config from "../../src/config/config";

/**
 * `pingRedis` backs `/api/health`, which awaits it inside a `Promise.all`
 * alongside the database probe.
 *
 * The probe therefore has to be BOUNDED. A Redis host that accepts the TCP
 * connection and then stops answering — a failover, a hung proxy — leaves
 * `ping()` pending forever, so the whole health endpoint hangs past the load
 * balancer's own timeout and the instance is pulled from rotation over a
 * dependency the file's own comment says may be down.
 */
const ping = jest.fn();

jest.mock("ioredis", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    ping,
    on: jest.fn(),
    status: "ready",
  })),
}));

// Imported after the mock is registered.
import { pingRedis } from "../../src/config/redis";

describe("pingRedis", () => {
  const enabled = config.REDIS.ENABLED;

  beforeEach(() => {
    ping.mockReset();
    config.REDIS.ENABLED = true;
  });

  afterEach(() => {
    config.REDIS.ENABLED = enabled;
    jest.useRealTimers();
  });

  it("is true on PONG", async () => {
    ping.mockResolvedValue("PONG");
    await expect(pingRedis()).resolves.toBe(true);
  });

  it("is false on any other reply", async () => {
    ping.mockResolvedValue("WAT");
    await expect(pingRedis()).resolves.toBe(false);
  });

  it("is false when the ping rejects", async () => {
    ping.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(pingRedis()).resolves.toBe(false);
  });

  it("gives up rather than hanging when Redis never answers", async () => {
    // THE REGRESSION. Unbounded, this promise never settles and
    // `/api/health` never responds.
    jest.useFakeTimers();
    ping.mockReturnValue(new Promise(() => undefined));

    const result = pingRedis();
    await jest.advanceTimersByTimeAsync(5_000);

    await expect(result).resolves.toBe(false);
  });

  it("reports a stall as down rather than throwing", async () => {
    // Redis is explicitly allowed to be down — it backs deferred work only.
    // A timed-out probe is a reportable state, not an error that should
    // fail the health check.
    jest.useFakeTimers();
    ping.mockReturnValue(new Promise(() => undefined));

    const result = pingRedis();
    await jest.advanceTimersByTimeAsync(5_000);

    await expect(result).resolves.toBe(false);
  });

  it("does not touch the connection when Redis is disabled", async () => {
    config.REDIS.ENABLED = false;

    await expect(pingRedis()).resolves.toBe(false);
    expect(ping).not.toHaveBeenCalled();
  });

  it("leaves no pending timer behind on the fast path", async () => {
    // The timeout timer is cleared in a `finally`. A stray one holds the
    // event loop open and delays graceful shutdown.
    jest.useFakeTimers();
    ping.mockResolvedValue("PONG");

    await expect(pingRedis()).resolves.toBe(true);

    expect(jest.getTimerCount()).toBe(0);
  });
});
