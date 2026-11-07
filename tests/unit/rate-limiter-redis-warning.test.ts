/**
 * The warning that makes the in-process default visible.
 *
 * `buildStore` falls back to express-rate-limit's MemoryStore whenever Redis
 * is off, and `.env.example` ships `REDIS_ENABLED=false`. That combination is
 * correct at exactly one instance and silently wrong at any other number: N
 * instances each keep their own counters, so every configured limit has a
 * real ceiling of N times itself.
 *
 * `ecosystem.config.json` pins `instances: 1`, which is the only reason this
 * is not already a live hole — and nothing said so at runtime, so raising
 * that number or adding a second container weakened every limit with no
 * trace in the logs.
 *
 * Nothing is imported at the top of this file on purpose. The middleware's
 * warning runs at module load, so every dependency has to be mocked before
 * the first `require` — and `src/config/logger.ts` itself reads `config.ENV`
 * when it loads, which is early enough to catch a `let` still in its
 * temporal dead zone.
 */
const mockWarn = jest.fn();
const mockState = { env: "test", redisEnabled: false };

jest.mock("../../src/config/logger", () => ({
  __esModule: true,
  default: {
    warn: mockWarn,
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mocked rather than booted: what is under test is the condition, and a real
// config in production mode would demand ALLOWED_ORIGINS, SITE_URL and the
// rest of the production checklist before it would hand one over.
jest.mock("../../src/config/config", () => ({
  __esModule: true,
  default: {
    get ENV() {
      return mockState.env;
    },
    REDIS: { QUEUE_PREFIX: "bull" },
    RATE_LIMIT: {
      GLOBAL: { WINDOW_MINUTES: 15, MAX: 100 },
      AUTH: { WINDOW_MINUTES: 15, MAX: 20 },
      UPLOAD: { WINDOW_MINUTES: 15, MAX: 50 },
      PASSWORD_RESET: { WINDOW_MINUTES: 60, IP_MAX: 5, EMAIL_MAX: 3 },
    },
  },
}));

jest.mock("../../src/config/redis", () => ({
  isRedisEnabled: () => mockState.redisEnabled,
  getLimiterConnection: () => ({ call: jest.fn() }),
}));

jest.mock("rate-limit-redis", () => ({
  RedisStore: jest.fn().mockImplementation(() => ({ __redisStore: true })),
}));

jest.mock("express-rate-limit", () => ({
  __esModule: true,
  default: jest.fn(() => jest.fn()),
  ipKeyGenerator: (ip: string) => ip,
}));

/** Re-evaluate the middleware, whose warning runs once at module load. */
const loadIn = (env: string, redisEnabled: boolean): string[] => {
  mockState.env = env;
  mockState.redisEnabled = redisEnabled;
  mockWarn.mockClear();

  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("../../src/middlewares/rate-limiter.middleware");
  });

  return mockWarn.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes("[RateLimit]"));
};

describe("the in-process rate-limit store in production", () => {
  it("warns when Redis is off in production", () => {
    // THE REGRESSION. Nothing reported this before.
    expect(loadIn("production", false)).toHaveLength(1);
  });

  it("names REDIS_ENABLED, so the line says what to change", () => {
    expect(loadIn("production", false)[0]).toMatch(/REDIS_ENABLED/);
  });

  it("explains that limits multiply per instance", () => {
    // A warning that only says "Redis is off" gets read as a nice-to-have.
    expect(loadIn("production", false)[0]).toMatch(/per\s+process|instance/i);
  });

  it("says it once per process, not once per limiter", () => {
    // Five limiters are built at module load. Five identical warnings is how
    // a startup log teaches people to skip startup logs.
    expect(loadIn("production", false)).toHaveLength(1);
  });

  it("stays quiet in production once Redis is on", () => {
    expect(loadIn("production", true)).toHaveLength(0);
  });

  it("stays quiet in development, where one process is the whole point", () => {
    expect(loadIn("development", false)).toHaveLength(0);
  });

  it("does not refuse to boot", () => {
    // One instance with MemoryStore is a legitimate deployment, and
    // ecosystem.config.json pins exactly that. This is a thing to be told
    // about, not prevented from starting.
    expect(() => loadIn("production", false)).not.toThrow();
  });
});
