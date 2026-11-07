import express, { Express } from "express";
import request from "supertest";
import httpStatus from "http-status";
import { Role } from "@prisma/client";
import app from "../../src/app";
import buildAuthRouter from "../../src/routes/app/auth.routes";
import { authController } from "../../src/controllers";
import * as userService from "../../src/services/user.service";
import {
  errorConverter,
  errorHandler,
} from "../../src/middlewares/error.middleware";
import config from "../../src/config/config";
import bcrypt from "bcryptjs";
import { hashToken } from "../../src/utils/hash";
import * as tokenService from "../../src/services/token.service";
import { cookieTokens } from "../helpers/auth";
import {
  prisma,
  assertDatabaseReachable,
  createTestUser,
  cleanupUsers,
  disconnect,
  TEST_PASSWORD,
} from "../helpers/db";

/**
 * Defects found in review, pinned end to end so they cannot come back.
 *
 * Each block states the bug it is guarding, because none of these are
 * obvious from the assertion alone.
 */
describe("auth hardening", () => {
  const createdUserIds: string[] = [];

  const newStaff = async (
    role: Role = Role.STAFF,
    overrides: Record<string, unknown> = {},
  ) => {
    const user = await createTestUser(role, overrides);
    createdUserIds.push(user.id);
    return user;
  };

  const login = (email: string, password = TEST_PASSWORD) =>
    request(app).post("/api/app/auth/login").send({ email, password });

  beforeAll(async () => {
    await assertDatabaseReachable();
  });

  afterAll(async () => {
    await cleanupUsers(createdUserIds);
    await disconnect();
  });

  describe("a request with no body", () => {
    /**
     * Express 5 leaves `req.body` undefined for a request that sent none.
     * `validate` passed that straight to Joi, which reports no error for an
     * absent object — so every `required()` field was unenforced and the
     * handler then died on `req.body.email`, answering 500 with a raw
     * TypeError in the response.
     */
    const bodyless = (path: string) => request(app).post(path);

    it.each([
      ["/api/app/auth/login"],
      ["/api/app/auth/forgot-password"],
      ["/api/app/auth/google"],
    ])("%s answers 400, not 500", async (path) => {
      const res = await bodyless(path);
      expect(res.status).toBe(httpStatus.BAD_REQUEST);
    });

    it("names the missing field instead of leaking a TypeError", async () => {
      const res = await bodyless("/api/app/auth/forgot-password");

      expect(res.body.message).toMatch(/email/i);
      expect(JSON.stringify(res.body)).not.toMatch(/TypeError|undefined/);
    });

    it("answers 400 for a body no parser claimed", async () => {
      // The other route to `req.body === undefined`: a Content-Type that
      // `express.json()` ignores, so nothing ever populates the body.
      const res = await request(app)
        .post("/api/app/auth/login")
        .set("Content-Type", "text/plain")
        .send("email=ada@example.com");

      expect(res.status).toBe(httpStatus.BAD_REQUEST);
    });

    it("still accepts a well-formed body", async () => {
      const user = await newStaff();
      await login(user.email).expect(httpStatus.OK);
    });
  });

  describe("what the database stores", () => {
    /**
     * Reset JWTs and refresh tokens were written verbatim, so read access
     * to the rows — a leaked backup, a query log, a screenshot of Prisma
     * Studio — yielded directly replayable credentials for every user.
     */
    it("stores a digest of the refresh token, not the token", async () => {
      const user = await newStaff();
      const res = await login(user.email).expect(httpStatus.OK);

      // Read out of the httpOnly cookie, because a browser login no longer
      // puts tokens in the body at all (docs/decisions.md §28). The cookie
      // is where the browser's copy lives, so it is the right thing to
      // compare the stored digest against.
      const refreshToken = cookieTokens(res).refresh!;
      expect(refreshToken).toEqual(expect.any(String));

      const sessions = await prisma.session.findMany({
        where: { userId: user.id },
      });

      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.refreshToken).not.toBe(refreshToken);
      expect(sessions[0]!.refreshToken).toBe(hashToken(refreshToken));
      expect(sessions[0]!.refreshToken).toMatch(/^[0-9a-f]{64}$/);
    });

    it("stores a digest of the reset token, not the token", async () => {
      const user = await newStaff();
      const res = await request(app)
        .post("/api/app/auth/forgot-password")
        .send({ email: user.email })
        .expect(httpStatus.OK);

      const link = res.body.data.resetPasswordLink as string;
      const token = new URL(link).searchParams.get("token")!;

      const rows = await prisma.token.findMany({ where: { userId: user.id } });

      expect(rows).toHaveLength(1);
      expect(rows[0]!.token).not.toBe(token);
      expect(rows[0]!.token).toBe(hashToken(token));
    });

    it("holds nothing that parses as a JWT", async () => {
      // The property that actually matters, stated directly: no row in
      // either table is a credential someone could replay.
      const user = await newStaff();
      await login(user.email).expect(httpStatus.OK);
      await request(app)
        .post("/api/app/auth/forgot-password")
        .send({ email: user.email });

      const [sessions, tokens] = await Promise.all([
        prisma.session.findMany({ where: { userId: user.id } }),
        prisma.token.findMany({ where: { userId: user.id } }),
      ]);

      for (const stored of [
        ...sessions.map((s) => s.refreshToken),
        ...tokens.map((t) => t.token),
      ]) {
        expect(stored.split(".")).toHaveLength(1);
      }
    });

    it("still lets the real token refresh a session", async () => {
      // Hashing is only correct if every read path hashes too.
      const user = await newStaff();
      const res = await login(user.email).expect(httpStatus.OK);

      await request(app)
        .post("/api/app/auth/refresh")
        .send({ refreshToken: cookieTokens(res).refresh })
        .expect(httpStatus.OK);
    });

    it("still lets the real token reset a password", async () => {
      const user = await newStaff();
      const forgot = await request(app)
        .post("/api/app/auth/forgot-password")
        .send({ email: user.email })
        .expect(httpStatus.OK);

      const token = new URL(
        forgot.body.data.resetPasswordLink as string,
      ).searchParams.get("token")!;

      await request(app)
        .post("/api/app/auth/reset-password")
        .send({ token, password: "N3wPassw0rd" })
        .expect(httpStatus.OK);

      await login(user.email, "N3wPassw0rd").expect(httpStatus.OK);
    });
  });

  describe("the login lockout", () => {
    /**
     * `loginAttempts` was a lifetime total that only a successful login
     * reset. So once an account had been locked the counter stayed at the
     * maximum, and the first wrong password after the lock expired locked
     * it again — forever, since the only thing that cleared the counter was
     * a login the lockout prevented.
     */
    const MAX = config.AUTH.MAX_LOGIN_ATTEMPTS;
    const WINDOW_MS = config.AUTH.LOCK_TIME_MINUTES * 60 * 1000;

    it("does not re-lock immediately after a lock expires", async () => {
      // THE REGRESSION. The account was locked, the lock has since expired,
      // and the stale counter is still at the maximum.
      const user = await newStaff(Role.STAFF, {
        loginAttempts: MAX,
        lockUntil: new Date(Date.now() - 60_000),
        lastFailedLoginAt: new Date(Date.now() - WINDOW_MS - 60_000),
      });

      const res = await login(user.email, "wrong-password");

      expect(res.status).toBe(httpStatus.UNAUTHORIZED);
      const after = await prisma.user.findUnique({ where: { id: user.id } });
      expect(after!.lockUntil).toBeNull();
      expect(after!.loginAttempts).toBe(1);
    });

    it("forgets failures older than the window", async () => {
      const user = await newStaff(Role.STAFF, {
        loginAttempts: MAX - 1,
        lastFailedLoginAt: new Date(Date.now() - WINDOW_MS - 1000),
      });

      await login(user.email, "wrong-password").expect(httpStatus.UNAUTHORIZED);

      const after = await prisma.user.findUnique({ where: { id: user.id } });
      expect(after!.loginAttempts).toBe(1);
      expect(after!.lockUntil).toBeNull();
    });

    it("still locks when failures are inside the window", async () => {
      const user = await newStaff(Role.STAFF, {
        loginAttempts: MAX - 1,
        lastFailedLoginAt: new Date(),
      });

      const res = await login(user.email, "wrong-password");

      expect(res.status).toBe(httpStatus.TOO_MANY_REQUESTS);
      const after = await prisma.user.findUnique({ where: { id: user.id } });
      expect(after!.lockUntil!.getTime()).toBeGreaterThan(Date.now());
    });

    it("records when the failure happened", async () => {
      const user = await newStaff();
      await login(user.email, "wrong-password").expect(httpStatus.UNAUTHORIZED);

      const after = await prisma.user.findUnique({ where: { id: user.id } });
      expect(after!.lastFailedLoginAt).toBeInstanceOf(Date);
    });

    it("clears the counter on a successful login", async () => {
      const user = await newStaff(Role.STAFF, {
        loginAttempts: 3,
        lastFailedLoginAt: new Date(),
      });

      await login(user.email).expect(httpStatus.OK);

      const after = await prisma.user.findUnique({ where: { id: user.id } });
      expect(after!.loginAttempts).toBe(0);
      expect(after!.lastFailedLoginAt).toBeNull();
    });

    it("is lifted by a password reset", async () => {
      // Resetting is the documented way out of a lockout. Without this the
      // user completes the whole email round-trip, sets a new password and
      // is still answered 429 until the lock ages out.
      const user = await newStaff(Role.STAFF, {
        loginAttempts: MAX,
        lockUntil: new Date(Date.now() + WINDOW_MS),
        lastFailedLoginAt: new Date(),
      });

      const forgot = await request(app)
        .post("/api/app/auth/forgot-password")
        .send({ email: user.email })
        .expect(httpStatus.OK);
      const token = new URL(
        forgot.body.data.resetPasswordLink as string,
      ).searchParams.get("token")!;

      await request(app)
        .post("/api/app/auth/reset-password")
        .send({ token, password: "N3wPassw0rd" })
        .expect(httpStatus.OK);

      const after = await prisma.user.findUnique({ where: { id: user.id } });
      expect(after!.loginAttempts).toBe(0);
      expect(after!.lockUntil).toBeNull();

      await login(user.email, "N3wPassw0rd").expect(httpStatus.OK);
    });
  });

  describe("the lockout counter under concurrency", () => {
    /**
     * THE REGRESSION. The counter was read off the row this process had
     * already fetched, incremented in JavaScript, and written back. N wrong
     * passwords arriving together therefore all read the same value and all
     * wrote the same `value + 1`: the counter advanced by one, not by N.
     *
     * That is the difference between a lockout and no lockout. An attacker
     * guessing serially trips MAX after MAX attempts; one firing fifty
     * guesses per round burned a single attempt per round and could keep
     * going indefinitely — against precisely the automated, parallel attack
     * the lockout exists to stop.
     *
     * Postgres now does the arithmetic: a conditional reset for a stale
     * window, `increment` otherwise.
     */
    const MAX = config.AUTH.MAX_LOGIN_ATTEMPTS;

    /** Fire `count` wrong passwords at once and ignore how each one failed. */
    const burst = async (email: string, count: number): Promise<void> => {
      await Promise.all(
        Array.from({ length: count }, () =>
          login(email, "definitely-not-the-password").then(
            () => undefined,
            () => undefined,
          ),
        ),
      );
    };

    it("counts every attempt in a simultaneous burst", async () => {
      const user = await newStaff(Role.STAFF, {
        loginAttempts: 0,
        lockUntil: null,
        lastFailedLoginAt: null,
      });

      // One below MAX, so nothing short-circuits on an account that locked
      // partway through and the count is unambiguous.
      const size = MAX - 1;
      await burst(user.email, size);

      const after = await prisma.user.findUnique({ where: { id: user.id } });
      expect(after!.loginAttempts).toBe(size);
    });

    it("locks when a simultaneous burst reaches the maximum", async () => {
      // The attack this makes impossible: MAX guesses in one round, all of
      // which used to cost a single attempt between them.
      const user = await newStaff(Role.STAFF, {
        loginAttempts: 0,
        lockUntil: null,
        lastFailedLoginAt: null,
      });

      await burst(user.email, MAX);

      const after = await prisma.user.findUnique({ where: { id: user.id } });
      expect(after!.loginAttempts).toBeGreaterThanOrEqual(MAX);
      expect(after!.lockUntil).not.toBeNull();
      expect(after!.lockUntil!.getTime()).toBeGreaterThan(Date.now());
    });

    it("refuses the next attempt after a burst has locked it", async () => {
      // The count being right only matters if the lock it produces holds.
      const user = await newStaff(Role.STAFF, {
        loginAttempts: 0,
        lockUntil: null,
        lastFailedLoginAt: null,
      });

      await burst(user.email, MAX);

      // The correct password, refused, because the account is locked.
      await login(user.email).expect(httpStatus.TOO_MANY_REQUESTS);
    });

    it("still resets a stale counter rather than incrementing it", async () => {
      // The sliding window has to survive the change: the reset branch is
      // now a conditional UPDATE, and getting its predicate backwards would
      // turn every stale failure into an increment.
      const WINDOW_MS = config.AUTH.LOCK_TIME_MINUTES * 60 * 1000;
      const user = await newStaff(Role.STAFF, {
        loginAttempts: MAX - 1,
        lockUntil: null,
        lastFailedLoginAt: new Date(Date.now() - WINDOW_MS - 60_000),
      });

      await burst(user.email, 1);

      const after = await prisma.user.findUnique({ where: { id: user.id } });
      expect(after!.loginAttempts).toBe(1);
      expect(after!.lockUntil).toBeNull();
    });
  });

  describe("the email-verification gate", () => {
    /**
     * `meetsEmailVerificationPolicy` was fully specified and called by
     * nothing, while constants.ts, user.prisma and prisma/seed.ts all
     * described a control that therefore did not exist.
     *
     * It is wired now, behind a flag that is OFF by default — nothing sends
     * a verification email yet, so enabling it unconditionally would lock
     * everyone out with no way back in.
     */
    const withGate = async (on: boolean, run: () => Promise<void>) => {
      const previous = config.AUTH.REQUIRE_EMAIL_VERIFICATION;
      config.AUTH.REQUIRE_EMAIL_VERIFICATION = on;
      try {
        await run();
      } finally {
        config.AUTH.REQUIRE_EMAIL_VERIFICATION = previous;
      }
    };

    it("lets an unverified account in while the gate is off", async () => {
      const user = await newStaff();
      expect(user.emailVerifiedAt).toBeNull();

      await withGate(false, async () => {
        await login(user.email).expect(httpStatus.OK);
      });
    });

    it("refuses an unverified account once the gate is on", async () => {
      const user = await newStaff();

      await withGate(true, async () => {
        const res = await login(user.email);

        // 403, not 401: the credentials were right. Re-sending them will
        // not help, which is what a 401 invites a client to do.
        expect(res.status).toBe(httpStatus.FORBIDDEN);
        expect(res.body.message).toMatch(/verify/i);
      });
    });

    it("admits a verified account with the gate on", async () => {
      const user = await newStaff(Role.STAFF, { emailVerifiedAt: new Date() });

      await withGate(true, async () => {
        await login(user.email).expect(httpStatus.OK);
      });
    });

    it("exempts ADMIN, which is never stamped", async () => {
      const admin = await newStaff(Role.ADMIN);
      expect(admin.emailVerifiedAt).toBeNull();

      await withGate(true, async () => {
        await login(admin.email).expect(httpStatus.OK);
      });
    });

    it("does not consume a login attempt when it refuses", async () => {
      // The password was correct, so this is not a failed attempt and must
      // not count toward a lockout.
      const user = await newStaff();

      await withGate(true, async () => {
        await login(user.email).expect(httpStatus.FORBIDDEN);
      });

      const after = await prisma.user.findUnique({ where: { id: user.id } });
      expect(after!.loginAttempts).toBe(0);
    });
  });
  describe("email is one mailbox whatever the casing", () => {
    /**
     * `users.email` is a case-sensitive unique index and nothing lowercased
     * on the way in, so `Ada@Shop.example` and `ada@shop.example` were two
     * accounts for one mailbox. Confirmed against a running instance: both
     * registrations succeeded, and the owner could then not log in with the
     * casing they remembered.
     *
     * The knock-ons are what make it worth pinning rather than tidying.
     * `forgot-password` for a casing that misses answers the deliberately
     * generic 200 and sends nothing — indistinguishable, from outside, from
     * a reset that worked. And `config/google-client.ts` lowercases the
     * address it reads out of the ID token, so a mixed-case row can never be
     * matched or linked by Google sign-in at all.
     */
    const mixed = (local: string) => `${local}-${Date.now()}@Example.COM`;

    // `/register` is not mounted on the real `app` outside development
    // (src/routes/app/index.ts), so the two registration specs below build a
    // router with the switch forced on — the same approach, and for the same
    // reason, as `auth.routes.test.ts`.
    const registrationApp: Express = express();
    registrationApp.use(express.json());
    registrationApp.use(
      "/api/app/auth",
      buildAuthRouter({ allowSelfRegistration: true }),
    );
    registrationApp.use(errorConverter, errorHandler);

    it("refuses a second registration that differs only in case", async () => {
      const email = mixed("Case");

      const first = await request(registrationApp)
        .post("/api/app/auth/register")
        .send({
          firstName: "Ada",
          lastName: "L",
          email,
          password: TEST_PASSWORD,
        })
        .expect(httpStatus.CREATED);
      createdUserIds.push(first.body.data.user.id);

      const second = await request(registrationApp)
        .post("/api/app/auth/register")
        .send({
          firstName: "Ada",
          lastName: "L",
          email: email.toLowerCase(),
          password: TEST_PASSWORD,
        });

      expect(second.status).toBe(httpStatus.BAD_REQUEST);
    });

    it("stores the address folded, whatever was sent", async () => {
      const email = mixed("Stored");

      const res = await request(registrationApp)
        .post("/api/app/auth/register")
        .send({
          firstName: "Ada",
          lastName: "L",
          email,
          password: TEST_PASSWORD,
        })
        .expect(httpStatus.CREATED);
      createdUserIds.push(res.body.data.user.id);

      const row = await prisma.user.findUnique({
        where: { id: res.body.data.user.id },
      });
      expect(row!.email).toBe(email.toLowerCase());
    });

    it("logs in whichever casing the user types", async () => {
      const user = await newStaff();

      await login(user.email.toUpperCase()).expect(httpStatus.OK);
      await login(
        user.email.replace(/^./, (c) => c.toUpperCase()),
      ).expect(httpStatus.OK);
    });

    it("sends a reset link for a casing that does not match the row", async () => {
      // The silent failure: a generic 200 either way, so the only way to
      // tell "we sent it" from "we found nobody" is the link itself.
      const user = await newStaff();

      const res = await request(app)
        .post("/api/app/auth/forgot-password")
        .send({ email: user.email.toUpperCase() })
        .expect(httpStatus.OK);

      expect(res.body.data?.resetPasswordLink).toEqual(expect.any(String));

      const rows = await prisma.token.findMany({ where: { userId: user.id } });
      expect(rows).toHaveLength(1);
    });
  });

  describe("the reset token is not in the URL", () => {
    /**
     * It used to be: `POST /auth/reset-password?token=<jwt>`. morgan's
     * format is `:method :url :status` and `:url` is `originalUrl`, and
     * `errorHandler` logs `originalUrl` too — so every reset wrote a live
     * account-takeover credential to stdout, to the log aggregator, and to
     * the access log of every proxy and CDN in front of this API. The
     * browser also puts the full URL in `Referer`.
     */
    const startReset = async () => {
      const user = await newStaff();
      const forgot = await request(app)
        .post("/api/app/auth/forgot-password")
        .send({ email: user.email })
        .expect(httpStatus.OK);

      return {
        user,
        token: new URL(
          forgot.body.data.resetPasswordLink as string,
        ).searchParams.get("token")!,
      };
    };

    it("accepts the token in the body", async () => {
      const { user, token } = await startReset();

      await request(app)
        .post("/api/app/auth/reset-password")
        .send({ token, password: "B0dyPassw0rd" })
        .expect(httpStatus.OK);

      await login(user.email, "B0dyPassw0rd").expect(httpStatus.OK);
    });

    it("refuses the token in the query string", async () => {
      const { user, token } = await startReset();

      const res = await request(app)
        .post(`/api/app/auth/reset-password?token=${encodeURIComponent(token)}`)
        .send({ password: "Qu3ryPassw0rd" });

      // 400, because `token` is now a required body field that was not sent.
      // The point is that the old call shape cannot keep working quietly:
      // a client left on it has to be changed rather than go on logging the
      // credential.
      expect(res.status).toBe(httpStatus.BAD_REQUEST);

      await login(user.email, "Qu3ryPassw0rd").expect(httpStatus.UNAUTHORIZED);
    });
  });
  describe("two logins in the same second", () => {
    /**
     * A refresh token used to be a pure function of `(sub, type, iat, exp)`,
     * and `iat`/`exp` are whole seconds — so two tokens minted for one user
     * inside the same second were byte-identical. `sessions.refresh_token`
     * is a unique index on the digest of that value, so the second login
     * died on a unique constraint and the user got a 409 Conflict.
     *
     * Not a contrived race: a double-submitted login form does it, and so
     * does signing in on a phone and a laptop at the same moment. The fix is
     * a `jti` nonce on every token type that gets stored.
     */
    it("both succeed and produce two distinct sessions", async () => {
      const user = await newStaff();

      const [first, second] = await Promise.all([
        login(user.email),
        login(user.email),
      ]);

      expect(first.status).toBe(httpStatus.OK);
      expect(second.status).toBe(httpStatus.OK);
      expect(cookieTokens(first).refresh).not.toBe(
        cookieTokens(second).refresh,
      );

      const sessions = await prisma.session.findMany({
        where: { userId: user.id },
      });
      expect(sessions).toHaveLength(2);
    });

    it("two reset tokens minted back to back are two tokens", async () => {
      // Same root cause on the other stored token type. `tokens.token` has
      // no unique index, so this one never threw — it quietly wrote two rows
      // holding the same digest, which makes "the token cannot be reused"
      // mean something other than what it says.
      //
      // Called through the service rather than over HTTP on purpose: two
      // requests only collide if they land in the same whole second, so an
      // HTTP version of this passes vacuously whenever they do not. Two
      // in-process calls leave no room for that.
      const user = await newStaff();

      const [first, second] = [
        await tokenService.generateResetPasswordToken(user.id),
        await tokenService.generateResetPasswordToken(user.id),
      ];

      expect(first.resetPasswordToken).not.toBe(second.resetPasswordToken);

      const rows = await prisma.token.findMany({ where: { userId: user.id } });
      expect(new Set(rows.map((r) => r.token)).size).toBe(rows.length);
    });
  });
  describe("the password work factor", () => {
    /**
     * `hashString` hard-coded a cost of 8 — roughly 2016-era, and 16x cheaper
     * to attack than 12. It is now `BCRYPT_ROUNDS` (default 12, Joi floor 10).
     *
     * Raising that number does nothing on its own. A bcrypt string carries
     * its own cost, so every account created before the change keeps the old
     * one for life, and the fix would protect only accounts that did not
     * exist yet. A successful login is the single moment the plaintext is in
     * hand, so it is the only moment the upgrade can happen.
     */
    const costOf = (hash: string): number =>
      Number(/^\$2[aby]\$(\d{2})\$/.exec(hash)![1]);

    /** An account whose password was stored under the old cost of 8. */
    const legacyUser = async () => {
      const user = await newStaff();
      await prisma.user.update({
        where: { id: user.id },
        data: { password: await bcrypt.hash(TEST_PASSWORD, 8) },
      });
      return user;
    };

    it("re-hashes a weak password on a successful login", async () => {
      const user = await legacyUser();

      const before = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(costOf(before.password)).toBe(8);

      await login(user.email).expect(httpStatus.OK);

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(costOf(after.password)).toBe(config.AUTH.BCRYPT_ROUNDS);

      // The upgrade must not change what the password IS.
      await login(user.email).expect(httpStatus.OK);
    });

    it("leaves the row alone when a login is refused", async () => {
      // A wrong password proves nothing, so there is nothing to re-hash
      // from — and writing to the row on a failed attempt would be a side
      // effect an attacker controls.
      const user = await legacyUser();

      await login(user.email, "WrongPassw0rd").expect(httpStatus.UNAUTHORIZED);

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(costOf(after.password)).toBe(8);
    });

    it("does not re-hash a password already at the configured cost", async () => {
      // `createTestUser` hashes through `hashString`, so this one starts
      // current. The digest must be byte-identical afterwards: a needless
      // re-hash is a write on every login of every account, forever.
      const user = await newStaff();
      const before = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });

      await login(user.email).expect(httpStatus.OK);

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(after.password).toBe(before.password);
    });

    it("stores new accounts at the configured cost", async () => {
      const user = await newStaff();
      const row = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });

      expect(costOf(row.password)).toBe(config.AUTH.BCRYPT_ROUNDS);
    });
  });
  describe("refresh re-checks the account, not just the session", () => {
    /**
     * `POST /auth/refresh` looked up the session, looked up the user, and
     * minted a new access token. It applied none of the gates the login
     * paths apply — so an account locked by brute-force protection went on
     * issuing access tokens from the refresh token it already held, for that
     * token's full seven days. The lockout closed the front door and left
     * this one open.
     */
    // Re-declared locally: the lockout and verification blocks above scope
    // their own copies, and reaching into another describe for them would
    // couple two independent sets of specs.
    const MAX = config.AUTH.MAX_LOGIN_ATTEMPTS;
    const WINDOW_MS = config.AUTH.LOCK_TIME_MINUTES * 60 * 1000;

    const withGate = async (on: boolean, run: () => Promise<void>) => {
      const previous = config.AUTH.REQUIRE_EMAIL_VERIFICATION;
      config.AUTH.REQUIRE_EMAIL_VERIFICATION = on;
      try {
        await run();
      } finally {
        config.AUTH.REQUIRE_EMAIL_VERIFICATION = previous;
      }
    };

    const refreshWith = (refreshToken: string) =>
      request(app).post("/api/app/auth/refresh").send({ refreshToken });

    const loggedIn = async (role: Role = Role.STAFF) => {
      const user = await newStaff(role);
      const res = await login(user.email).expect(httpStatus.OK);
      return { user, refreshToken: cookieTokens(res).refresh! };
    };

    it("refuses while the account is locked", async () => {
      const { user, refreshToken } = await loggedIn();

      // Works before the lock, so the assertion after it is about the lock
      // and not about something that never worked.
      await refreshWith(refreshToken).expect(httpStatus.OK);

      await prisma.user.update({
        where: { id: user.id },
        data: {
          loginAttempts: MAX,
          lockUntil: new Date(Date.now() + WINDOW_MS),
          lastFailedLoginAt: new Date(),
        },
      });

      const res = await refreshWith(refreshToken);

      expect(res.status).toBe(httpStatus.TOO_MANY_REQUESTS);
      expect(res.body.message).toMatch(/locked/i);
    });

    it("works again once the lock expires", async () => {
      // The refresh token is not burnt by being refused — a lockout is
      // temporary, and the session outlives it.
      const { user, refreshToken } = await loggedIn();

      await prisma.user.update({
        where: { id: user.id },
        data: { lockUntil: new Date(Date.now() + WINDOW_MS) },
      });
      await refreshWith(refreshToken).expect(httpStatus.TOO_MANY_REQUESTS);

      await prisma.user.update({
        where: { id: user.id },
        data: { lockUntil: new Date(Date.now() - 1000) },
      });

      await refreshWith(refreshToken).expect(httpStatus.OK);
    });

    it("applies the email-verification gate too", async () => {
      // Same reasoning as the lockout: a gate that only the login route
      // honours is a gate with a documented way around it.
      const { refreshToken } = await loggedIn();

      await withGate(true, async () => {
        const res = await refreshWith(refreshToken);
        expect(res.status).toBe(httpStatus.FORBIDDEN);
      });
    });

    it("still lets an unlocked, verified account through", async () => {
      const { refreshToken } = await loggedIn();

      await refreshWith(refreshToken).expect(httpStatus.OK);
    });
  });

  describe("updateUserById cannot be handed a column", () => {
    /**
     * It took `Partial<User>` and spread it into `prisma.user.update` — the
     * exact shape `createUser` carries an explicit input type to avoid. No
     * route reached it with client data, so nothing was exploitable; what
     * made it worth closing is that `validations/user.validation.ts` already
     * holds unwired `updateUser` and `updateUserRole` schemas keyed on
     * `:userId`. The first route wired to one would have inherited the
     * ability to set `role`, `emailVerifiedAt` or `googleId` from a request
     * body, and the call site would have looked perfectly ordinary.
     *
     * The interface now names what may be written. These specs cast through
     * `unknown` to pass what a JavaScript caller — or a `req.body` — could
     * still hand it at runtime, because a compile-time type alone is not a
     * control.
     */
    type LooseUpdate = Parameters<typeof userService.updateUserById>[1];
    const loose = (body: Record<string, unknown>): LooseUpdate =>
      body as unknown as LooseUpdate;

    it("ignores emailVerifiedAt", async () => {
      // A claim about a mailbox round-trip that never happened. Only
      // `markEmailVerified` may assert it.
      const user = await newStaff(Role.STAFF);

      await userService.updateUserById(
        user.id,
        loose({ firstName: "Ada", emailVerifiedAt: new Date() }),
      );

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(after.emailVerifiedAt).toBeNull();
      expect(after.firstName).toBe("Ada");
    });

    it("ignores googleId", async () => {
      // Linking an account to a Google identity is `linkGoogleId`, which
      // owns the uniqueness check that goes with it. Set here, it would be
      // an unchecked takeover of whoever signs in with that Google account.
      const user = await newStaff(Role.STAFF);

      await userService.updateUserById(
        user.id,
        loose({ googleId: `stolen-${Date.now()}` }),
      );

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(after.googleId).toBeNull();
    });

    it("ignores an id, rather than rewriting the primary key", async () => {
      const user = await newStaff(Role.STAFF);

      await userService.updateUserById(
        user.id,
        loose({ id: "11111111-1111-1111-1111-111111111111" }),
      );

      expect(
        await prisma.user.findUnique({ where: { id: user.id } }),
      ).not.toBeNull();
    });

    it("still lets role through, which is deliberate", async () => {
      // Promotion is a real operation. The gate is `auth("manage:users")`
      // plus a schema on the route — somewhere a reader can see it — not an
      // accident of this signature.
      const user = await newStaff(Role.STAFF);

      await userService.updateUserById(user.id, { role: Role.ADMIN });

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(after.role).toBe(Role.ADMIN);
    });

    it("still clears a lockout, zeroes and nulls included", async () => {
      // The field-by-field build tests `!== undefined`, not truthiness, and
      // this is why: `loginAttempts: 0`, `lockUntil: null` and
      // `lastFailedLoginAt: null` are exactly what a completed password
      // reset writes. A truthy check would drop all three and leave the
      // account locked after a successful reset.
      const user = await newStaff(Role.STAFF, {
        loginAttempts: config.AUTH.MAX_LOGIN_ATTEMPTS,
        lockUntil: new Date(Date.now() + 60_000),
        lastFailedLoginAt: new Date(),
      });

      await userService.updateUserById(user.id, {
        loginAttempts: 0,
        lockUntil: null,
        lastFailedLoginAt: null,
      });

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(after.loginAttempts).toBe(0);
      expect(after.lockUntil).toBeNull();
      expect(after.lastFailedLoginAt).toBeNull();
    });

    it("still folds an email it is given", async () => {
      const user = await newStaff(Role.STAFF);
      const address = `Mixed-Case-${Date.now()}@Example.COM`;

      await userService.updateUserById(user.id, { email: address });

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(after.email).toBe(address.trim().toLowerCase());
    });

    it("still hashes a password it is given", async () => {
      const user = await newStaff(Role.STAFF);

      await userService.updateUserById(user.id, { password: "N3wPassw0rd" });

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(after.password).not.toBe("N3wPassw0rd");
      expect(await bcrypt.compare("N3wPassw0rd", after.password)).toBe(true);
    });
  });

  describe("createUser cannot be handed a role", () => {
    /**
     * `createUser` took a `User` and spread it into Prisma — every column,
     * `role` among them. Nothing was exploitable, because the only caller is
     * `POST /auth/register` and its schema denies unknown keys. But the
     * guard lived two layers up in that schema, and
     * `validations/user.validation.ts` already carries unwired `createUser`
     * and `inviteUser` schemas that DO accept `role`: the first admin or
     * invite route wired to one of those would have passed a client-supplied
     * role straight through to the database.
     *
     * It now takes an explicit input type, and the registration controller
     * names its four fields, so the escalation is unrepresentable rather
     * than merely rejected. docs/decisions.md §3 asks for exactly this.
     */
    const registrationApp: Express = express();
    registrationApp.use(express.json());
    registrationApp.use(
      "/api/app/auth",
      buildAuthRouter({ allowSelfRegistration: true }),
    );
    registrationApp.use(errorConverter, errorHandler);

    const registerBody = (extra: Record<string, unknown> = {}) => ({
      firstName: "Ada",
      lastName: "L",
      email: `role-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
      password: TEST_PASSWORD,
      ...extra,
    });

    it("defaults a registration to STAFF", async () => {
      const res = await request(registrationApp)
        .post("/api/app/auth/register")
        .send(registerBody())
        .expect(httpStatus.CREATED);
      createdUserIds.push(res.body.data.user.id);

      const row = await prisma.user.findUniqueOrThrow({
        where: { id: res.body.data.user.id },
      });
      expect(row.role).toBe(Role.STAFF);
    });

    it("rejects a role in the request body", async () => {
      // The outer guard, still doing its job. The spec below is the one that
      // matters, because it holds when this one is relaxed.
      const res = await request(registrationApp)
        .post("/api/app/auth/register")
        .send(registerBody({ role: Role.ADMIN }));

      expect(res.status).toBe(httpStatus.BAD_REQUEST);
    });

    it("ignores a role even when validation lets one past", async () => {
      // The real assertion: a router with NO schema on the register route,
      // standing in for the looser schema a future invite or admin route
      // would bring. The controller names its fields, so `role` has nowhere
      // to go — the database decides, and it decides STAFF.
      const unvalidated: Express = express();
      unvalidated.use(express.json());
      unvalidated.post("/register", authController.register);
      unvalidated.use(errorConverter, errorHandler);

      const res = await request(unvalidated)
        .post("/register")
        .send(registerBody({ role: Role.ADMIN }))
        .expect(httpStatus.CREATED);
      createdUserIds.push(res.body.data.user.id);

      const row = await prisma.user.findUniqueOrThrow({
        where: { id: res.body.data.user.id },
      });
      expect(row.role).toBe(Role.STAFF);
    });

    it("still creates an ADMIN when the caller asks the service directly", async () => {
      // Not a hole: granting ADMIN is now a line of code at a call site a
      // reader can see, rather than a field that arrived in a body.
      const user = await userService.createUser({
        email: `direct-${Date.now()}@example.com`,
        password: TEST_PASSWORD,
        firstName: "Ada",
        lastName: "L",
        role: Role.ADMIN,
      });
      createdUserIds.push(user.id);

      expect(user.role).toBe(Role.ADMIN);
    });
  });
});
