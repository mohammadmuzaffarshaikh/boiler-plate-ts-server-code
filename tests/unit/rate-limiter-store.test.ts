import type { Options } from "express-rate-limit";

/**
 * Where the rate-limit counters live.
 *
 * THE BUG THIS PINS. Every limiter used express-rate-limit's default
 * MemoryStore, which keeps its counters in the process. That is correct at
 * exactly one instance and quietly wrong at any other number: with N
 * instances behind a load balancer each one counts separately, so the
 * 20-per-window login cap has a real ceiling of 20N and nothing reports that
 * the control has been weakened. `ecosystem.config.json` runs `instances: 1`
 * today, which is the only reason it was not already a live hole — and
 * "correct until someone scales out" is not a property worth shipping in a
 * boilerplate whose whole job is to be scaled out.
 *
 * Mocked at the module boundary rather than run against a real Redis: what
 * is being asserted is *which store was chosen and how it was namespaced*,
 * which is a wiring decision, not a Redis behaviour. The counting itself is
 * express-rate-limit's and rate-limit-redis's to get right.
 */

let mockRedisEnabled = false;
const mockCall = jest.fn();

jest.mock("../../src/config/redis", () => ({
  isRedisEnabled: () => mockRedisEnabled,
  getLimiterConnection: () => ({ call: mockCall }),
}));

const redisStoreOptions: { prefix?: string }[] = [];
jest.mock("rate-limit-redis", () => ({
  RedisStore: jest.fn().mockImplementation((options: { prefix?: string }) => {
    redisStoreOptions.push(options);
    return { __redisStore: true, prefix: options.prefix };
  }),
}));

const limiterOptions: Partial<Options>[] = [];
jest.mock("express-rate-limit", () => ({
  __esModule: true,
  default: jest.fn((options: Partial<Options>) => {
    limiterOptions.push(options);
    return jest.fn();
  }),
  ipKeyGenerator: (ip: string) => ip,
}));

/** Load the middleware fresh, so the module-level limiters are rebuilt. */
const loadLimiters = (redisEnabled: boolean) => {
  mockRedisEnabled = redisEnabled;
  limiterOptions.length = 0;
  redisStoreOptions.length = 0;

  let loaded!: typeof import("../../src/middlewares/rate-limiter.middleware");
  // The limiters are built at module load, so re-reading them needs a
  // require inside `isolateModules`. A static import is hoisted and
  // evaluated once, which is the thing this helper exists to defeat.
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require("../../src/middlewares/rate-limiter.middleware");
  });

  return loaded;
};

describe("rate limiter store selection", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("with Redis switched off", () => {
    it("passes no store, leaving the in-process default", () => {
      loadLimiters(false);

      expect(limiterOptions.length).toBeGreaterThan(0);
      for (const options of limiterOptions) {
        expect(options.store).toBeUndefined();
      }
    });

    it("does not construct a Redis store", () => {
      loadLimiters(false);

      expect(redisStoreOptions).toHaveLength(0);
    });
  });

  describe("with Redis switched on", () => {
    it("gives every limiter a Redis store", () => {
      loadLimiters(true);

      expect(limiterOptions.length).toBeGreaterThan(0);
      for (const options of limiterOptions) {
        expect(options.store).toMatchObject({ __redisStore: true });
      }
    });

    it("namespaces each limiter's keys separately", () => {
      loadLimiters(true);

      const prefixes = redisStoreOptions.map((o) => o.prefix);

      // Guards the two assertions below from passing on an empty array,
      // which is exactly what a regression to the memory store looks like:
      // `new Set([]).size === [].length` and a `for` over nothing both hold.
      expect(prefixes.length).toBe(limiterOptions.length);
      expect(prefixes.length).toBeGreaterThan(0);

      // Distinct, or one limiter's bucket is read and spent as another's —
      // a login attempt would burn upload quota and vice versa.
      expect(new Set(prefixes).size).toBe(prefixes.length);

      // Under the app's own prefix and below `rl:`, so these keys cannot
      // collide with BullMQ's, which share the queue prefix.
      for (const prefix of prefixes) {
        expect(prefix).toMatch(/:rl:[a-z-]+:$/);
      }
    });

    it("covers the limiters that actually guard something", () => {
      loadLimiters(true);

      const prefixes = redisStoreOptions.map((o) => o.prefix ?? "");

      for (const name of [
        "global",
        "auth",
        "pwreset-ip",
        "pwreset-email",
        "upload",
      ]) {
        expect(prefixes.some((p) => p.endsWith(`:rl:${name}:`))).toBe(true);
      }
    });
  });

  describe("when the store is unreachable", () => {
    it("fails open rather than 500ing the request", () => {
      // `passOnStoreError` is the whole reason Redis can back this without
      // becoming load-bearing. `config/redis.ts` already states the rule:
      // Postgres is required for every request, Redis backs things the API
      // survives without. Rate limiting is a backstop against noise and
      // brute force, not the control that stops either — the per-account
      // lockout in `auth.service` is, and that one lives in Postgres.
      //
      // Failing closed would mean a Redis blip takes the entire API down,
      // which is a larger and likelier outage than the one it prevents.
      loadLimiters(true);

      for (const options of limiterOptions) {
        expect(options.passOnStoreError).toBe(true);
      }
    });
  });

  describe("regardless of store", () => {
    it.each([true, false])(
      "keeps the draft-7 headers and drops the legacy ones (redis=%s)",
      (redisEnabled) => {
        loadLimiters(redisEnabled);

        for (const options of limiterOptions) {
          expect(options.standardHeaders).toBe("draft-7");
          expect(options.legacyHeaders).toBe(false);
        }
      },
    );

    it.each([true, false])(
      "stays inert under NODE_ENV=test (redis=%s)",
      (redisEnabled) => {
        // Counters are shared across cases in one process, so a live limiter
        // fails whichever spec happens to exhaust a bucket first.
        loadLimiters(redisEnabled);

        for (const options of limiterOptions) {
          expect(options.skip?.({} as never, {} as never)).toBe(true);
        }
      },
    );
  });
});
