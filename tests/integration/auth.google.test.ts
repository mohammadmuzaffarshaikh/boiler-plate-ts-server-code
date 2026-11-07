import request from "supertest";
import httpStatus from "http-status";
import { cookieTokens } from "../helpers/auth";
import {
  deriveCodeChallenge,
  generateCodeVerifier,
} from "../../src/utils/pkce";
import { TokenPayload } from "google-auth-library";
import app from "../../src/app";
import { googlePayload, googleReturns } from "../helpers/google";
import {
  prisma,
  assertDatabaseReachable,
  createTestUser,
  cleanupUsers,
  disconnect,
} from "../helpers/db";

/**
 * `POST /api/app/auth/google`, end to end against a real Postgres.
 *
 * Only the Google round-trip is faked — `verifyIdToken` is stubbed, so no
 * request leaves the machine and no real credential is involved. Everything
 * after it is the real path: `resolveGoogleUser`, the lockout check, the
 * `googleId` link, the session row and the cookies.
 *
 * The rule this file pins hardest: **Google sign-in is a login method, never
 * a signup path.** `resolveGoogleUser` refuses an unknown address rather than
 * inserting one. With `POST /api/app/auth/register` mounted only in
 * development (docs/decisions.md §14), an endpoint here that created accounts
 * would be the one way left to mint a STAFF row in production, from nothing
 * but a Google account.
 *
 * This route lives under `/api/app`, so it signs in *staff*. Customer Google
 * sign-in is a storefront concern with its own principal and its own signing
 * secret — see §13 and §15. It does not exist.
 */
describe("POST /api/app/auth/google", () => {
  const createdUserIds: string[] = [];
  const uniqueEmail = () =>
    `spec-google-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const uniqueSub = () =>
    `sub-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  beforeAll(async () => {
    await assertDatabaseReachable();
  });

  afterAll(async () => {
    await cleanupUsers(createdUserIds);
    await disconnect();
  });

  /**
   * Stand in for Google. `restoreMocks: true` tears this down before each
   * test, so it is installed per test rather than once in `beforeAll` — a
   * spy set up in `beforeAll` would be gone by the time the first test ran.
   */
  const googleSays = (overrides: Partial<TokenPayload>) =>
    googleReturns(googlePayload({ sub: uniqueSub(), ...overrides }));

  const signIn = () =>
    request(app).post("/api/app/auth/google").send({ idToken: "stub-token" });

  const newStaff = async (overrides = {}) => {
    const user = await createTestUser(undefined, overrides);
    createdUserIds.push(user.id);
    return user;
  };

  describe("validation", () => {
    it("rejects a request with no idToken", async () => {
      const res = await request(app).post("/api/app/auth/google").send({});
      expect(res.status).toBe(httpStatus.BAD_REQUEST);
    });

    it("rejects an unknown field rather than ignoring it", async () => {
      // `validate` refuses unknown keys. Worth pinning on this route in
      // particular: it is the one login path where the caller supplies a
      // structured credential, and a schema that quietly accepted extras is
      // how a `role` or `email` override gets smuggled in later.
      const res = await request(app)
        .post("/api/app/auth/google")
        .send({ idToken: "stub-token", email: "someone@example.com" });

      expect(res.status).toBe(httpStatus.BAD_REQUEST);
    });
  });

  describe("an address with no account", () => {
    it("is refused, and no account is created", async () => {
      const email = uniqueEmail();
      googleSays({ email });

      const res = await signIn();

      expect(res.status).toBe(httpStatus.FORBIDDEN);
      // The assertion that matters. A sign-in that inserted here would be
      // self-service staff creation with a Google account as the only
      // credential.
      await expect(
        prisma.user.findUnique({ where: { email } }),
      ).resolves.toBeNull();
    });

    it("says so plainly rather than pretending the credential was bad", async () => {
      // Deliberately NOT the vague answer the password path gives. There is
      // no enumeration concern here: the caller already proved to Google
      // that this mailbox is theirs, so telling them it has no account
      // reveals nothing they could not confirm by trying to register.
      googleSays({ email: uniqueEmail() });

      const res = await signIn();
      expect(res.body.message).toMatch(/no account found/i);
    });
  });

  describe("first Google sign-in for an existing account", () => {
    it("links the Google identity and issues a session", async () => {
      const user = await newStaff();
      const sub = uniqueSub();
      googleSays({ email: user.email, sub });

      const res = await signIn();

      expect(res.status).toBe(httpStatus.OK);

      // `signIn()` is a browser sign-in, so the session arrives as cookies
      // and the body carries no tokens — docs/decisions.md §28. The native
      // shape of this same route is covered below.
      expect(res.body.data.token).toBeUndefined();
      expect(res.body.data.refreshToken).toBeUndefined();
      expect(cookieTokens(res).access).toEqual(expect.any(String));

      const sessions = await prisma.session.findMany({
        where: { userId: user.id },
      });
      expect(sessions).toHaveLength(1);

      const linked = await prisma.user.findUnique({ where: { id: user.id } });
      expect(linked!.googleId).toBe(sub);
    });

    it("hands a native client an authorization code instead", async () => {
      // Google sign-in shares the login tail, so it has to offer both client
      // shapes or a mobile app cannot use it at all.
      const user = await newStaff();
      googleSays({ email: user.email });

      const verifier = generateCodeVerifier();
      const res = await request(app)
        .post("/api/app/auth/google")
        .send({
          idToken: "stub-token",
          client: "native",
          codeChallenge: deriveCodeChallenge(verifier),
          codeChallengeMethod: "S256",
        })
        .expect(httpStatus.OK);

      expect(res.body.data.authorizationCode).toEqual(expect.any(String));
      expect(res.headers["set-cookie"]).toBeUndefined();

      const exchanged = await request(app)
        .post("/api/app/auth/token-exchange")
        .send({
          code: res.body.data.authorizationCode,
          codeVerifier: verifier,
        })
        .expect(httpStatus.OK);

      expect(exchanged.body.data.token).toEqual(expect.any(String));
      expect(exchanged.body.data.user.id).toBe(user.id);
    });

    it("sets httpOnly cookies, like every other login path", async () => {
      const user = await newStaff();
      googleSays({ email: user.email });

      const res = await signIn();

      const cookies = res.headers["set-cookie"] as unknown as string[];
      expect(cookies.join(";")).toMatch(/HttpOnly/i);
    });

    it("never returns the password hash", async () => {
      const user = await newStaff();
      googleSays({ email: user.email });

      const res = await signIn();
      expect(res.body.data.user).not.toHaveProperty("password");
    });

    it("records a session row", async () => {
      const user = await newStaff();
      googleSays({ email: user.email });

      await signIn();

      const sessions = await prisma.session.count({
        where: { userId: user.id },
      });
      expect(sessions).toBeGreaterThan(0);
    });
  });

  describe("subsequent sign-ins", () => {
    it("matches on googleId, not email, once linked", async () => {
      // `sub` is the identity; a Google account's email address can change
      // and be reassigned. If this resolved by email it would miss the row
      // and report "no account found" the first time somebody changed their
      // Google address — or worse, attach to whoever inherited the old one.
      const sub = uniqueSub();
      const user = await newStaff({ googleId: sub });

      googleSays({ sub, email: "a-completely-different@example.com" });
      const res = await signIn();

      expect(res.status).toBe(httpStatus.OK);
      expect(res.body.data.user.id).toBe(user.id);
      expect(res.body.data.user.email).toBe(user.email);
    });
  });

  describe("email_verified", () => {
    it("refuses an unverified Google address", async () => {
      // The whole link-by-email behaviour above rests on this: an address
      // Google has not verified is one anybody can claim, and claiming a
      // staff member's address would hand over their account.
      const user = await newStaff();
      googleSays({ email: user.email, email_verified: false });

      const res = await signIn();

      expect(res.status).toBe(httpStatus.UNAUTHORIZED);
      const untouched = await prisma.user.findUnique({
        where: { id: user.id },
      });
      expect(untouched!.googleId).toBeNull();
    });
  });

  describe("email verification stamp", () => {
    it("stamps emailVerifiedAt on a Google login", async () => {
      // Reaching the success path *is* the proof: `verifyGoogleIdToken`
      // throws outright on an unverified address, so there is nothing left
      // to verify by email.
      const user = await newStaff();
      expect(user.emailVerifiedAt).toBeNull();

      googleSays({ email: user.email });
      await signIn();

      const stamped = await prisma.user.findUnique({ where: { id: user.id } });
      expect(stamped!.emailVerifiedAt).toBeInstanceOf(Date);
    });

    it("does not move an existing stamp", async () => {
      // The column is a record of when the round-trip completed. Re-stamping
      // on every login would turn it into "last verified login".
      const original = new Date("2026-01-01T00:00:00.000Z");
      const user = await newStaff({ emailVerifiedAt: original });

      googleSays({ email: user.email });
      await signIn();

      const after = await prisma.user.findUnique({ where: { id: user.id } });
      expect(after!.emailVerifiedAt!.toISOString()).toBe(
        original.toISOString(),
      );
    });
  });

  describe("the account lockout applies here too", () => {
    it("refuses a locked account instead of letting Google bypass it", async () => {
      // A lockout earned by password guessing must not be sidestepped by
      // signing in another way — otherwise the counter protects one door in
      // a building with two.
      const user = await newStaff({
        lockUntil: new Date(Date.now() + 60 * 60 * 1000),
      });
      googleSays({ email: user.email });

      const res = await signIn();

      expect(res.status).toBe(httpStatus.TOO_MANY_REQUESTS);
      expect(res.body.message).toMatch(/lock/i);
    });

    it("ignores an expired lock", async () => {
      const user = await newStaff({
        lockUntil: new Date(Date.now() - 60 * 1000),
      });
      googleSays({ email: user.email });

      await signIn().expect(httpStatus.OK);
    });

    it("clears a pending failure counter on success", async () => {
      const user = await newStaff({ loginAttempts: 2 });
      googleSays({ email: user.email });

      await signIn().expect(httpStatus.OK);

      const after = await prisma.user.findUnique({ where: { id: user.id } });
      expect(after!.loginAttempts).toBe(0);
    });
  });
});
