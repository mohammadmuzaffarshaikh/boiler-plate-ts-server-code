import express, { Express } from "express";
import request from "supertest";
import httpStatus from "http-status";
import app from "../../src/app";
import config from "../../src/config/config";
import buildAuthRouter from "../../src/routes/app/auth.routes";
import {
  errorConverter,
  errorHandler,
} from "../../src/middlewares/error.middleware";
import {
  prisma,
  assertDatabaseReachable,
  createTestUser,
  cleanupUsers,
  disconnect,
  TEST_PASSWORD,
} from "../helpers/db";
import { cookieTokens, nativeLogin } from "../helpers/auth";

/**
 * The auth surface, end to end against a real Postgres.
 *
 * Rate limiters are inert here (`skip: () => config.ENV === "test"`), so
 * nothing below is affected by request counts — which also means the limiter
 * itself is not covered by this file. See tests/README.md.
 */
describe("auth routes", () => {
  const createdUserIds: string[] = [];
  const uniqueEmail = () =>
    `spec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

  beforeAll(async () => {
    await assertDatabaseReachable();
  });

  afterAll(async () => {
    await cleanupUsers(createdUserIds);
    await disconnect();
  });

  const track = async (email: string) => {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) createdUserIds.push(user.id);
    return user;
  };

  describe("POST /api/app/auth/register", () => {
    /**
     * The real `app` does not have this route: it is mounted only when
     * NODE_ENV=development (src/routes/app/index.ts) and the suite runs as
     * `test`. So the endpoint is exercised on a router built with the switch
     * forced on, and the switch itself is covered by the two specs after it.
     *
     * This is the whole app's middleware minus the global limiter and CORS,
     * which neither this endpoint nor these assertions involve.
     */
    const registrationApp: Express = express();
    registrationApp.use(express.json());
    registrationApp.use(
      "/api/app/auth",
      buildAuthRouter({ allowSelfRegistration: true }),
    );
    registrationApp.use(errorConverter, errorHandler);

    it("is not mounted outside development", async () => {
      // 404, not 403: outside development the path does not exist, so there
      // is nothing for a prober to confirm. `config.ENV` is asserted so this
      // spec fails loudly rather than silently passing if the suite is ever
      // run as development.
      expect(config.ENV).not.toBe("development");

      await request(app)
        .post("/api/app/auth/register")
        .send({
          firstName: "Ada",
          lastName: "Lovelace",
          email: uniqueEmail(),
          password: "Password123",
        })
        .expect(httpStatus.NOT_FOUND);
    });

    it("creates a STAFF account — `users` holds nobody else", async () => {
      const email = uniqueEmail();
      const res = await request(registrationApp)
        .post("/api/app/auth/register")
        .send({
          firstName: "Ada",
          lastName: "Lovelace",
          email,
          password: "Password123",
        });

      expect(res.status).toBe(httpStatus.CREATED);
      const user = await track(email);
      expect(user).not.toBeNull();
      // The schema default. Not CUSTOMER — that value no longer exists, and
      // this assertion is the one that would fail if it came back.
      expect(user!.role).toBe("STAFF");
      // Registration must not assert a mailbox it has not proven.
      expect(user!.emailVerifiedAt).toBeNull();
    });

    it("ignores a role supplied by the caller", async () => {
      // The Joi schema has no `role` key and `validate` rejects unknown ones,
      // so this is a 400 rather than a quiet downgrade to the default. Worth
      // pinning explicitly: the route is the only path into `users` that is
      // not an invitation, and `userService.createUser` spreads its argument
      // straight into `prisma.user.create`.
      const res = await request(registrationApp)
        .post("/api/app/auth/register")
        .send({
          firstName: "Mallory",
          lastName: "Quinn",
          email: uniqueEmail(),
          password: "Password123",
          role: "ADMIN",
        });

      expect(res.status).toBe(httpStatus.BAD_REQUEST);
    });

    it("rejects a duplicate email", async () => {
      const email = uniqueEmail();
      const body = { firstName: "A", lastName: "B", email, password: "Password123" };

      await request(registrationApp).post("/api/app/auth/register").send(body);
      await track(email);
      const res = await request(registrationApp)
        .post("/api/app/auth/register")
        .send(body);

      expect(res.status).toBe(httpStatus.BAD_REQUEST);
    });

    it("rejects a weak password", async () => {
      const res = await request(registrationApp).post("/api/app/auth/register").send({
        firstName: "A", lastName: "B", email: uniqueEmail(), password: "short",
      });
      expect(res.status).toBe(httpStatus.BAD_REQUEST);
    });
  });

  describe("the old unprefixed paths", () => {
    // Every admin endpoint moved under /api/app. If one of these starts
    // answering again, two namespaces have quietly become one.
    it.each([
      ["post", "/api/auth/login"],
      ["post", "/api/auth/register"],
      ["get", "/api/auth/self"],
      ["get", "/api/files"],
    ])("%s %s is gone", async (method, path) => {
      const res = await (request(app) as never as Record<string, Function>)[
        method
      ](path);
      expect(res.status).toBe(httpStatus.NOT_FOUND);
    });
  });

  describe("POST /api/app/auth/login", () => {
    it("sets httpOnly cookies and puts no tokens in the body", async () => {
      // This spec used to assert the opposite — that both tokens came back
      // in the body *as well as* in cookies. That is the hole §28 closed:
      // the body copy handed any XSS in the admin SPA both credentials,
      // which is precisely what `httpOnly` exists to prevent.
      const user = await createTestUser();
      createdUserIds.push(user.id);

      const res = await request(app)
        .post("/api/app/auth/login")
        .send({ email: user.email, password: TEST_PASSWORD });

      expect(res.status).toBe(httpStatus.OK);
      expect(res.body.data.token).toBeUndefined();
      expect(res.body.data.refreshToken).toBeUndefined();

      const cookies = res.headers["set-cookie"] as unknown as string[];
      expect(cookies.join(";")).toMatch(/HttpOnly/i);
      expect(cookieTokens(res).access).toEqual(expect.any(String));
      expect(cookieTokens(res).refresh).toEqual(expect.any(String));
    });

    it("never returns the password hash", async () => {
      const user = await createTestUser();
      createdUserIds.push(user.id);

      const res = await request(app)
        .post("/api/app/auth/login")
        .send({ email: user.email, password: TEST_PASSWORD });

      expect(res.body.data.user).not.toHaveProperty("password");
    });

    it("gives the same answer for a wrong password and an unknown account", async () => {
      const user = await createTestUser();
      createdUserIds.push(user.id);

      const wrongPassword = await request(app)
        .post("/api/app/auth/login")
        .send({ email: user.email, password: "NotThePassword1" });
      const unknownAccount = await request(app)
        .post("/api/app/auth/login")
        .send({ email: uniqueEmail(), password: TEST_PASSWORD });

      // Differing status or wording here is an account-enumeration oracle.
      expect(wrongPassword.status).toBe(httpStatus.UNAUTHORIZED);
      expect(unknownAccount.status).toBe(httpStatus.UNAUTHORIZED);
      expect(wrongPassword.body.message).toBe(unknownAccount.body.message);
    });

    it("locks the account after repeated failures", async () => {
      const user = await createTestUser();
      createdUserIds.push(user.id);

      let final;
      for (let i = 0; i < config.AUTH.MAX_LOGIN_ATTEMPTS + 1; i++) {
        final = await request(app)
          .post("/api/app/auth/login")
          .send({ email: user.email, password: "WrongPassword1" });
        if (final.status !== httpStatus.UNAUTHORIZED) break;
      }

      expect(final!.status).not.toBe(httpStatus.UNAUTHORIZED);
      expect(final!.body.message).toMatch(/lock/i);
    });
  });

  describe("session endpoints", () => {
    /**
     * A logged-in native client: login with a PKCE challenge, then trade the
     * authorization code for bearer tokens.
     *
     * These specs want tokens in hand, which is the native shape. A browser
     * login returns none (docs/decisions.md §28) — the cookie path is
     * covered by "works end to end on cookies alone" in
     * `auth.token-exchange.test.ts`.
     */
    const loginFresh = async () => {
      const user = await createTestUser();
      createdUserIds.push(user.id);
      const result = await nativeLogin(app, user.email);

      expect(result.status).toBe(httpStatus.OK);

      return { user, token: result.access!, refreshToken: result.refresh! };
    };

    it("GET /api/app/auth/self returns the caller", async () => {
      const { user, token } = await loginFresh();
      const res = await request(app)
        .get("/api/app/auth/self")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(httpStatus.OK);
      expect(res.body.data.user.email).toBe(user.email);
    });

    it("GET /api/app/auth/self rejects a missing or bogus token", async () => {
      await request(app).get("/api/app/auth/self").expect(httpStatus.UNAUTHORIZED);
      await request(app)
        .get("/api/app/auth/self")
        .set("Authorization", "Bearer nonsense")
        .expect(httpStatus.UNAUTHORIZED);
    });

    it("refreshes and then logs out", async () => {
      const { refreshToken } = await loginFresh();

      await request(app)
        .post("/api/app/auth/refresh")
        .send({ refreshToken })
        .expect(httpStatus.OK);

      await request(app)
        .post("/api/app/auth/logout")
        .send({ refreshToken })
        .expect(httpStatus.OK);
    });
  });

  describe("POST /api/app/auth/forgot-password", () => {
    it("answers identically for a known and an unknown address", async () => {
      const user = await createTestUser();
      createdUserIds.push(user.id);

      const known = await request(app)
        .post("/api/app/auth/forgot-password")
        .send({ email: user.email });
      const unknown = await request(app)
        .post("/api/app/auth/forgot-password")
        .send({ email: uniqueEmail() });

      // A 404 for unknown addresses would turn this into an enumeration
      // oracle, which the rate limiters on this route only slow down.
      expect(known.status).toBe(httpStatus.OK);
      expect(unknown.status).toBe(httpStatus.OK);
      expect(known.body.message).toBe(unknown.body.message);
    });

    it("never issues a token for an address with no account", async () => {
      const res = await request(app)
        .post("/api/app/auth/forgot-password")
        .send({ email: uniqueEmail() });

      expect(res.body.data).toBeUndefined();
    });

    it("returns the link outside production only", async () => {
      const user = await createTestUser();
      createdUserIds.push(user.id);

      const res = await request(app)
        .post("/api/app/auth/forgot-password")
        .send({ email: user.email });

      // NODE_ENV is "test" here. In production this branch is skipped and the
      // link is emailed instead — returning a live reset token to an
      // unauthenticated caller is account takeover.
      expect(config.ENV).not.toBe("production");
      expect(res.body.data.resetPasswordLink).toEqual(expect.any(String));
    });
  });

  describe("password reset round trip", () => {
    it("resets the password, and the token cannot be reused", async () => {
      const user = await createTestUser();
      createdUserIds.push(user.id);

      const forgot = await request(app)
        .post("/api/app/auth/forgot-password")
        .send({ email: user.email });
      const token = new URL(forgot.body.data.resetPasswordLink).searchParams.get("token")!;

      // The token goes in the BODY. It used to be a query parameter, which
      // put a live account-takeover credential into morgan's `:url`, into
      // `errorHandler`'s `originalUrl`, and into the access log of every
      // proxy in front of this API.
      await request(app)
        .post("/api/app/auth/reset-password")
        .send({ token, password: "BrandNewPass9" })
        .expect(httpStatus.OK);

      await request(app)
        .post("/api/app/auth/login")
        .send({ email: user.email, password: "BrandNewPass9" })
        .expect(httpStatus.OK);

      const replay = await request(app)
        .post("/api/app/auth/reset-password")
        .send({ token, password: "YetAnother9" });

      expect(replay.status).toBeGreaterThanOrEqual(400);
    });
  });
});
