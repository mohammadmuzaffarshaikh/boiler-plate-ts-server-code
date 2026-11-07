import express, { Express } from "express";
import request from "supertest";
import httpStatus from "http-status";
import {
  createRateLimiter,
  passwordResetEmailLimiter,
} from "../../src/middlewares/rate-limiter.middleware";
import {
  errorConverter,
  errorHandler,
} from "../../src/middlewares/error.middleware";
import config from "../../src/config/config";

/**
 * Do the limiters actually limit?
 *
 * Nothing asserted this. `skip: () => config.ENV === "test"` turns every
 * limiter into a no-op under Jest, and no spec anywhere asserted a 429 from
 * an app route — the only 429s in `tests/` were Resend error mapping in
 * `email-service.test.ts`. So the window arithmetic, the key generators, the
 * IP-plus-email chaining on `/forgot-password` and `skipSuccessfulRequests`
 * were all unverified behaviourally: a change that silently made a limiter
 * allow everything would have passed CI with every test green.
 *
 * `rate-limiter-store.test.ts` is the companion to this file and covers which
 * *store* is chosen. This one covers what the limiter does once it has one.
 *
 * `config.ENV` is moved off "test" for the duration, which is the only way to
 * get past that `skip`. Each spec builds its own limiter with its own name,
 * so each gets a fresh MemoryStore and no counting leaks between them.
 */
let counter = 0;
const uniqueName = (): string => `spec-${Date.now()}-${counter++}`;

const buildApp = (
  limiter: ReturnType<typeof createRateLimiter>,
  options: { trustProxy?: boolean } = {},
): Express => {
  const app = express();
  if (options.trustProxy) app.set("trust proxy", 1);
  app.use(express.json());
  app.post("/thing", limiter, (_req, res) => {
    res.status(httpStatus.OK).send({ status: "success" });
  });
  app.use(errorConverter, errorHandler);
  return app;
};

describe("rate limiter behaviour", () => {
  let previousEnv: string;

  beforeEach(() => {
    previousEnv = config.ENV;
    // The limiters are a no-op under "test" by design. Nothing can be
    // asserted about them without stepping out of it.
    config.ENV = "development";
  });

  afterEach(() => {
    config.ENV = previousEnv;
  });

  describe("the window", () => {
    it("allows requests up to the limit and refuses the next one", async () => {
      // THE GAP. No test in the suite had ever seen a 429 from a limiter.
      const app = buildApp(
        createRateLimiter({
          name: uniqueName(),
          windowMinutes: 15,
          limit: 3,
          message: "Too many requests.",
        }),
      );

      for (let i = 0; i < 3; i++) {
        await request(app).post("/thing").expect(httpStatus.OK);
      }
      await request(app).post("/thing").expect(httpStatus.TOO_MANY_REQUESTS);
    });

    it("answers with the message it was configured with", async () => {
      const app = buildApp(
        createRateLimiter({
          name: uniqueName(),
          windowMinutes: 15,
          limit: 1,
          message: "Too many password reset requests. Please try again later.",
        }),
      );

      await request(app).post("/thing").expect(httpStatus.OK);
      const res = await request(app).post("/thing");

      expect(res.status).toBe(httpStatus.TOO_MANY_REQUESTS);
      expect(res.body.message).toBe(
        "Too many password reset requests. Please try again later.",
      );
    });

    it("sends draft-7 RateLimit headers and not the legacy ones", async () => {
      const app = buildApp(
        createRateLimiter({
          name: uniqueName(),
          windowMinutes: 15,
          limit: 5,
          message: "Too many requests.",
        }),
      );

      const res = await request(app).post("/thing");

      expect(res.headers).toHaveProperty("ratelimit");
      expect(res.headers).not.toHaveProperty("x-ratelimit-limit");
    });

    it("is inert under the test environment", async () => {
      // The `skip` the rest of the suite relies on. If this ever stops being
      // true, several hundred specs start failing for a reason that has
      // nothing to do with what they assert.
      config.ENV = "test";
      const app = buildApp(
        createRateLimiter({
          name: uniqueName(),
          windowMinutes: 15,
          limit: 1,
          message: "Too many requests.",
        }),
      );

      for (let i = 0; i < 5; i++) {
        await request(app).post("/thing").expect(httpStatus.OK);
      }
    });
  });

  describe("skipSuccessfulRequests", () => {
    it("does not count a success against the budget", async () => {
      // What `authLimiter` is built with: a staff member who signs in
      // correctly ten times should never be throttled. Only the failures
      // are supposed to accumulate.
      const limiter = createRateLimiter({
        name: uniqueName(),
        windowMinutes: 15,
        limit: 2,
        message: "Too many requests.",
        skipSuccessfulRequests: true,
      });

      const app = express();
      app.use(express.json());
      app.post("/thing", limiter, (req, res) => {
        const ok = (req.body as { ok?: boolean }).ok;
        res.status(ok ? httpStatus.OK : httpStatus.UNAUTHORIZED).send({});
      });
      app.use(errorConverter, errorHandler);

      for (let i = 0; i < 5; i++) {
        await request(app).post("/thing").send({ ok: true }).expect(httpStatus.OK);
      }

      // The budget is untouched, so two failures are still allowed.
      await request(app).post("/thing").send({ ok: false }).expect(httpStatus.UNAUTHORIZED);
      await request(app).post("/thing").send({ ok: false }).expect(httpStatus.UNAUTHORIZED);
      await request(app)
        .post("/thing")
        .send({ ok: false })
        .expect(httpStatus.TOO_MANY_REQUESTS);
    });
  });

  describe("who shares a bucket", () => {
    it("counts each IP separately by default", async () => {
      const app = buildApp(
        createRateLimiter({
          name: uniqueName(),
          windowMinutes: 15,
          limit: 1,
          message: "Too many requests.",
        }),
        { trustProxy: true },
      );

      await request(app)
        .post("/thing")
        .set("X-Forwarded-For", "203.0.113.1")
        .expect(httpStatus.OK);
      await request(app)
        .post("/thing")
        .set("X-Forwarded-For", "203.0.113.1")
        .expect(httpStatus.TOO_MANY_REQUESTS);

      // A different client is unaffected by the first one's spending.
      await request(app)
        .post("/thing")
        .set("X-Forwarded-For", "203.0.113.2")
        .expect(httpStatus.OK);
    });
  });

  describe("the password-reset email limiter's key", () => {
    /**
     * The chain on `/forgot-password` is IP **and** email. The IP limiter
     * alone is bypassed by a botnet; the email limiter alone is bypassed by
     * varying the address. Neither half had a test.
     *
     * The exported limiter is used directly here rather than a rebuilt one,
     * because its `keyGenerator` is the thing under test.
     */
    const resetApp = (): Express => {
      const app = express();
      app.set("trust proxy", 1);
      app.use(express.json());
      app.post("/forgot", passwordResetEmailLimiter, (_req, res) => {
        res.status(httpStatus.OK).send({ status: "success" });
      });
      app.use(errorConverter, errorHandler);
      return app;
    };

    const max = config.RATE_LIMIT.PASSWORD_RESET.EMAIL_MAX;

    it("follows the address across different IPs", async () => {
      // THE POINT OF THIS BUCKET: one mailbox cannot be flooded from many
      // sources. Reset mail costs money and sender reputation.
      const app = resetApp();
      const email = `victim-${Date.now()}@example.com`;

      for (let i = 0; i < max; i++) {
        await request(app)
          .post("/forgot")
          .set("X-Forwarded-For", `198.51.100.${i + 1}`)
          .send({ email })
          .expect(httpStatus.OK);
      }

      await request(app)
        .post("/forgot")
        .set("X-Forwarded-For", "198.51.100.254")
        .send({ email })
        .expect(httpStatus.TOO_MANY_REQUESTS);
    });

    it("keeps separate budgets for separate addresses", async () => {
      const app = resetApp();
      const spent = `spent-${Date.now()}@example.com`;
      const fresh = `fresh-${Date.now()}@example.com`;

      for (let i = 0; i < max; i++) {
        await request(app).post("/forgot").send({ email: spent }).expect(httpStatus.OK);
      }
      await request(app)
        .post("/forgot")
        .send({ email: spent })
        .expect(httpStatus.TOO_MANY_REQUESTS);

      // An unrelated user is not locked out by someone else's flood.
      await request(app).post("/forgot").send({ email: fresh }).expect(httpStatus.OK);
    });

    it("treats one address in two casings as one bucket", async () => {
      // `bodyEmail` lower-cases, for the same reason every lookup in
      // `user.service` folds: otherwise varying the capitalisation is a free
      // reset of the counter.
      const app = resetApp();
      const email = `Casing-${Date.now()}@Example.com`;

      for (let i = 0; i < max; i++) {
        await request(app)
          .post("/forgot")
          .send({ email: email.toLowerCase() })
          .expect(httpStatus.OK);
      }

      await request(app)
        .post("/forgot")
        .send({ email: email.toUpperCase() })
        .expect(httpStatus.TOO_MANY_REQUESTS);
    });

    it("falls back to the IP when the body carries no address", async () => {
      // A malformed-body flood would 400 at validation anyway, but it must
      // still be bounded rather than sharing one empty-string bucket with
      // every other caller on earth.
      const app = resetApp();

      for (let i = 0; i < max; i++) {
        await request(app)
          .post("/forgot")
          .set("X-Forwarded-For", "192.0.2.77")
          .send({})
          .expect(httpStatus.OK);
      }

      await request(app)
        .post("/forgot")
        .set("X-Forwarded-For", "192.0.2.77")
        .send({})
        .expect(httpStatus.TOO_MANY_REQUESTS);

      await request(app)
        .post("/forgot")
        .set("X-Forwarded-For", "192.0.2.78")
        .send({})
        .expect(httpStatus.OK);
    });
  });
});
