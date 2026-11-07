import {
  prisma,
  checkDatabase,
  connectDatabase,
  safeDatabaseUrl,
} from "../../src/config/prisma-client";
import config from "../../src/config/config";

/**
 * The database connection, and the check that it actually works.
 *
 * `prisma.$connect()` is NOT a connectivity check with a driver adapter: the
 * pool is lazy, so it resolves against a dead port and the first real query
 * is what fails. Trusting it meant the server logged success, accepted
 * traffic, and 500ed everything. These tests pin the replacement down.
 */
describe("prisma-client", () => {
  describe("safeDatabaseUrl", () => {
    it("masks the password", () => {
      // Managed Postgres puts credentials inline in the URL, and this value
      // is logged on every boot.
      const raw = config.DATABASE.URL;
      const safe = safeDatabaseUrl();

      expect(safe).not.toContain("mysecretpassword");
      expect(safe).toMatch(/:\*\*\*@/);
      // Everything else survives, so the log still identifies the server.
      expect(safe).toContain(new URL(raw).hostname);
    });
  });

  describe("checkDatabase", () => {
    it("is true when a query round-trips", async () => {
      jest.spyOn(prisma, "$queryRaw").mockResolvedValue([{ "?column?": 1 }]);
      await expect(checkDatabase()).resolves.toBe(true);
    });

    it("gives up quickly instead of waiting out the pool's connect timeout", async () => {
      // Against a host that drops packets rather than refusing, the pool
      // waits DB_CONNECT_TIMEOUT_MS (10s by default). An unbounded probe
      // blocked that long — longer than any load balancer's own timeout, so
      // the check was recorded as a timeout instead of a clean "unhealthy",
      // while holding a pool slot throughout. Measured at 10.1s.
      jest
        .spyOn(prisma, "$queryRaw")
        .mockReturnValue(new Promise(() => {}) as never); // never settles

      const started = Date.now();
      await expect(checkDatabase(150)).resolves.toBe(false);

      expect(Date.now() - started).toBeLessThan(1_000);
    });

    it("is false — and does not throw — when the query fails", async () => {
      // It backs the health endpoint, where throwing would turn "the
      // database is down" into "the health check is down".
      jest.spyOn(prisma, "$queryRaw").mockRejectedValue(new Error("ECONNREFUSED"));
      await expect(checkDatabase()).resolves.toBe(false);
    });
  });

  describe("connectDatabase", () => {
    it("round-trips a real query, not just $connect", async () => {
      const connect = jest.spyOn(prisma, "$connect").mockResolvedValue(undefined);
      const query = jest.spyOn(prisma, "$queryRaw").mockResolvedValue([{ ok: 1 }]);

      await connectDatabase();

      expect(connect).toHaveBeenCalled();
      // This is the assertion that matters: $connect alone proves nothing.
      expect(query).toHaveBeenCalled();
    });

    it("retries, then gives up — it does not hang forever", async () => {
      jest.spyOn(prisma, "$connect").mockResolvedValue(undefined);
      const query = jest
        .spyOn(prisma, "$queryRaw")
        .mockRejectedValue(new Error("Can't reach database server"));

      await expect(connectDatabase()).rejects.toThrow(/Could not reach the database/);

      // Bounded: CONNECT_RETRIES + 1 attempts, then throw so the caller can
      // exit non-zero. Retrying forever would leave a container permanently
      // "starting" and never reporting itself unhealthy.
      expect(query).toHaveBeenCalledTimes(config.DATABASE.CONNECT_RETRIES + 1);
    });

    it("succeeds on a later attempt without surfacing the earlier failure", async () => {
      jest.spyOn(prisma, "$connect").mockResolvedValue(undefined);
      let calls = 0;
      jest.spyOn(prisma, "$queryRaw").mockImplementation((() => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error("starting up"))
          : Promise.resolve([{ ok: 1 }]);
      }) as never);

      // The case retries exist for: app and database start together and
      // Postgres is a second behind.
      await expect(connectDatabase()).resolves.toBeUndefined();
      expect(calls).toBe(2);
    });

    it("never leaks the password in the failure message", async () => {
      jest.spyOn(prisma, "$connect").mockResolvedValue(undefined);
      jest.spyOn(prisma, "$queryRaw").mockRejectedValue(new Error("nope"));

      const error = await connectDatabase().catch((e: Error) => e);

      expect((error as Error).message).not.toContain("mysecretpassword");
      expect((error as Error).message).toMatch(/:\*\*\*@/);
    });
  });

  describe("pool configuration", () => {
    it("sets a connection timeout", () => {
      // node-pg's default is "wait forever", which turns an unreachable
      // database into hung requests rather than errors.
      expect(config.DATABASE.CONNECT_TIMEOUT_MS).toBeGreaterThan(0);
    });

    it("bounds the pool and caps a single statement", () => {
      expect(config.DATABASE.POOL_MAX).toBeGreaterThan(0);
      expect(config.DATABASE.STATEMENT_TIMEOUT_MS).toBeGreaterThanOrEqual(0);
    });
  });
});
