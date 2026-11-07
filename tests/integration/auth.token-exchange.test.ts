import { randomUUID } from "node:crypto";
import request from "supertest";
import { NextFunction, Request, Response } from "express";
import httpStatus from "http-status";
import { Role } from "@prisma/client";
import app from "../../src/app";
import { authController } from "../../src/controllers";
import ApiError from "../../src/utils/api-error";
import config from "../../src/config/config";
import { COOKIE_NAMES } from "../../src/config/cookies-option";
import { cookieValue } from "../helpers/auth";
import {
  deriveCodeChallenge,
  generateCodeVerifier,
} from "../../src/utils/pkce";
import { hashToken } from "../../src/utils/hash";
import {
  prisma,
  assertDatabaseReachable,
  createTestUser,
  cleanupUsers,
  disconnect,
  TEST_PASSWORD,
} from "../helpers/db";

/**
 * The native login handshake, end to end.
 *
 * THE BUG THIS REPLACES. `/auth/login` returned the access and refresh tokens
 * in the JSON body *and* set them as httpOnly cookies, so that browser
 * clients could use the cookies and non-browser clients the body. The second
 * half is what broke the first: any XSS in the admin SPA could read the login
 * response and take both credentials. `httpOnly` protected the cookie while
 * the same secret sat beside it where script could read it.
 *
 * The two cases are now separated at the door. A browser login sets cookies
 * and returns no tokens at all. A native login supplies a PKCE challenge,
 * gets a single-use authorization code, and trades it here.
 *
 * docs/decisions.md §28.
 */
describe("native login handshake", () => {
  const createdUserIds: string[] = [];

  const newStaff = async (role: Role = Role.STAFF) => {
    const user = await createTestUser(role);
    createdUserIds.push(user.id);
    return user;
  };

  /** A fresh verifier/challenge pair, as a client would generate one. */
  const pkce = () => {
    const verifier = generateCodeVerifier();
    return { verifier, challenge: deriveCodeChallenge(verifier) };
  };

  const nativeLogin = (email: string, challenge: string, password = TEST_PASSWORD) =>
    request(app).post("/api/app/auth/login").send({
      email,
      password,
      client: "native",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });

  const exchange = (code: string, codeVerifier: string) =>
    request(app).post("/api/app/auth/token-exchange").send({
      code,
      codeVerifier,
    });

  /** Enough of a Request for `captureRequestContext`. */
  const fakeRequest = () =>
    ({ headers: {}, ip: "127.0.0.1" }) as unknown as Request;

  const self = (token: string) =>
    request(app)
      .get("/api/app/auth/self")
      .set("Authorization", `Bearer ${token}`);

  beforeAll(async () => {
    await assertDatabaseReachable();
  });

  afterAll(async () => {
    await cleanupUsers(createdUserIds);
    await disconnect();
  });

  describe("a browser login", () => {
    it("returns no tokens in the body at all", async () => {
      const user = await newStaff();

      const res = await request(app)
        .post("/api/app/auth/login")
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(httpStatus.OK);

      // THE regression. All four of these were present before.
      expect(res.body.data.token).toBeUndefined();
      expect(res.body.data.refreshToken).toBeUndefined();
      expect(res.body.data.expires).toBeUndefined();
      expect(res.body.data.refreshExpires).toBeUndefined();

      // And nothing that merely looks like a JWT has crept in under another
      // name — this is the assertion that survives a field being renamed.
      expect(JSON.stringify(res.body)).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);

      expect(res.body.data.user.id).toBe(user.id);
    });

    it("still sets both httpOnly cookies", async () => {
      const user = await newStaff();

      const res = await request(app)
        .post("/api/app/auth/login")
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(httpStatus.OK);

      const cookies = res.headers["set-cookie"] as unknown as string[];
      const named = (name: string) =>
        cookies.find((c) => c.startsWith(`${name}=`));

      expect(named(COOKIE_NAMES.access)).toMatch(/HttpOnly/i);
      expect(named(COOKIE_NAMES.refresh)).toMatch(/HttpOnly/i);
    });

    it("is not issued an authorization code", async () => {
      // The code is the thing an XSS would want. A browser session must not
      // be handed one even though the endpoint can produce them.
      const user = await newStaff();

      const res = await request(app)
        .post("/api/app/auth/login")
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(httpStatus.OK);

      expect(res.body.data.authorizationCode).toBeUndefined();
      expect(await prisma.authCode.count({ where: { userId: user.id } })).toBe(
        0,
      );
    });

    it("cannot ask for one by smuggling a challenge", async () => {
      // `codeChallenge` is `forbidden` unless `client` is native, so a page
      // cannot opt itself into the shape that hands tokens to JavaScript.
      const user = await newStaff();
      const { challenge } = pkce();

      await request(app)
        .post("/api/app/auth/login")
        .send({
          email: user.email,
          password: TEST_PASSWORD,
          codeChallenge: challenge,
        })
        .expect(httpStatus.BAD_REQUEST);
    });

    it("works end to end on cookies alone", async () => {
      // The browser contract: log in, call an authenticated route, with no
      // token ever touching JavaScript.
      const user = await newStaff();
      const agent = request.agent(app);

      await agent
        .post("/api/app/auth/login")
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(httpStatus.OK);

      const me = await agent.get("/api/app/auth/self").expect(httpStatus.OK);
      expect(me.body.data.user.id).toBe(user.id);
    });
  });

  describe("a native login", () => {
    it("returns a code and no tokens", async () => {
      const user = await newStaff();
      const { challenge } = pkce();

      const res = await nativeLogin(user.email, challenge).expect(
        httpStatus.OK,
      );

      expect(res.body.data.authorizationCode).toEqual(expect.any(String));
      expect(res.body.data.token).toBeUndefined();
      expect(res.body.data.refreshToken).toBeUndefined();
    });

    it("sets no cookies", async () => {
      // A client with no cookie jar has no use for them, and handing out a
      // credential nobody asked for is how one ends up somewhere unexpected.
      const user = await newStaff();
      const { challenge } = pkce();

      const res = await nativeLogin(user.email, challenge).expect(
        httpStatus.OK,
      );

      expect(res.headers["set-cookie"]).toBeUndefined();
    });

    it("creates no session until the code is redeemed", async () => {
      // A code that is never traded must leave nothing behind but the row
      // the sweep collects.
      const user = await newStaff();
      const { challenge } = pkce();

      await nativeLogin(user.email, challenge).expect(httpStatus.OK);

      expect(await prisma.session.count({ where: { userId: user.id } })).toBe(
        0,
      );
    });

    it("stores the code as a digest, never the code", async () => {
      const user = await newStaff();
      const { challenge } = pkce();

      const res = await nativeLogin(user.email, challenge).expect(
        httpStatus.OK,
      );
      const code = res.body.data.authorizationCode as string;

      const row = await prisma.authCode.findFirstOrThrow({
        where: { userId: user.id },
      });

      expect(row.code).not.toBe(code);
      expect(row.code).toBe(hashToken(code));
      expect(row.code).toMatch(/^[0-9a-f]{64}$/);
    });

    it("refuses a malformed challenge before the password is spent", async () => {
      const user = await newStaff();

      await request(app)
        .post("/api/app/auth/login")
        .send({
          email: user.email,
          password: TEST_PASSWORD,
          client: "native",
          codeChallenge: "too-short",
        })
        .expect(httpStatus.BAD_REQUEST);
    });

    it("requires a challenge", async () => {
      const user = await newStaff();

      await request(app)
        .post("/api/app/auth/login")
        .send({
          email: user.email,
          password: TEST_PASSWORD,
          client: "native",
        })
        .expect(httpStatus.BAD_REQUEST);
    });
  });

  describe("redeeming the code", () => {
    it("returns both tokens and they work", async () => {
      const user = await newStaff();
      const { verifier, challenge } = pkce();

      const login = await nativeLogin(user.email, challenge).expect(
        httpStatus.OK,
      );
      const res = await exchange(
        login.body.data.authorizationCode,
        verifier,
      ).expect(httpStatus.OK);

      expect(res.body.data.token).toEqual(expect.any(String));
      expect(res.body.data.refreshToken).toEqual(expect.any(String));
      expect(res.body.data.user.id).toBe(user.id);

      await self(res.body.data.token).expect(httpStatus.OK);
    });

    it("creates exactly one session, recorded against the code", async () => {
      const user = await newStaff();
      const { verifier, challenge } = pkce();

      const login = await nativeLogin(user.email, challenge).expect(
        httpStatus.OK,
      );
      await exchange(login.body.data.authorizationCode, verifier).expect(
        httpStatus.OK,
      );

      const sessions = await prisma.session.findMany({
        where: { userId: user.id },
      });
      expect(sessions).toHaveLength(1);

      const row = await prisma.authCode.findFirstOrThrow({
        where: { userId: user.id },
      });
      expect(row.sessionId).toBe(sessions[0]!.id);
      expect(row.consumedAt).not.toBeNull();
    });

    it("gives the refresh token a working session", async () => {
      const user = await newStaff();
      const { verifier, challenge } = pkce();

      const login = await nativeLogin(user.email, challenge).expect(
        httpStatus.OK,
      );
      const tokens = await exchange(
        login.body.data.authorizationCode,
        verifier,
      ).expect(httpStatus.OK);

      const refreshed = await request(app)
        .post("/api/app/auth/refresh")
        .send({ refreshToken: tokens.body.data.refreshToken })
        .expect(httpStatus.OK);

      // Body-in, body-out: this caller proved it holds the credential
      // outside a cookie jar, so the reply belongs in the body.
      expect(refreshed.body.data.token).toEqual(expect.any(String));
      await self(refreshed.body.data.token).expect(httpStatus.OK);
    });
  });

  describe("refreshing mirrors how the caller authenticated", () => {
    /**
     * The hole this closes is the login hole wearing a different hat.
     *
     * If `/auth/refresh` put the new access token in the body for a
     * cookie-authenticated caller, an XSS would not need the login response
     * at all: it could simply POST to `/auth/refresh`, which the browser
     * obligingly authenticates with the httpOnly cookie, and read the token
     * out of the reply. Taking the tokens out of the login response and
     * leaving them in this one would have moved the problem, not fixed it.
     *
     * So the reply mirrors the request. Cookie in, cookie out and an empty
     * body. Body in, body out — that caller has already shown it holds the
     * credential outside a cookie jar.
     */
    it("a cookie-authenticated refresh returns no token in the body", async () => {
      const user = await newStaff();
      const agent = request.agent(app);

      await agent
        .post("/api/app/auth/login")
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(httpStatus.OK);

      const res = await agent
        .post("/api/app/auth/refresh")
        .send({})
        .expect(httpStatus.OK);

      expect(res.body.data.token).toBeUndefined();
      expect(res.body.data.expires).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);

      // The user is still returned — it is not a credential.
      expect(res.body.data.user.id).toBe(user.id);
    });

    it("but does set the refreshed access cookie", async () => {
      // The session has to actually be extended, or the browser path would
      // be quietly broken rather than quietly secure.
      const user = await newStaff();
      const agent = request.agent(app);

      await agent
        .post("/api/app/auth/login")
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(httpStatus.OK);

      const res = await agent
        .post("/api/app/auth/refresh")
        .send({})
        .expect(httpStatus.OK);

      expect(cookieValue(res, COOKIE_NAMES.access)).toEqual(expect.any(String));

      // And the agent, carrying the refreshed cookie, is still authenticated.
      await agent.get("/api/app/auth/self").expect(httpStatus.OK);
    });

    it("a body-authenticated refresh does return the token", async () => {
      const user = await newStaff();
      const { verifier, challenge } = pkce();

      const login = await nativeLogin(user.email, challenge).expect(
        httpStatus.OK,
      );
      const tokens = await exchange(
        login.body.data.authorizationCode,
        verifier,
      ).expect(httpStatus.OK);

      const res = await request(app)
        .post("/api/app/auth/refresh")
        .send({ refreshToken: tokens.body.data.refreshToken })
        .expect(httpStatus.OK);

      expect(res.body.data.token).toEqual(expect.any(String));
    });

    it("plants no access cookie on a body-authenticated caller", async () => {
      /**
       * The mirror used to be half a mirror: only the *body* copy was gated,
       * while `res.cookie` ran unconditionally. So a client that refreshed
       * with a body token had an access cookie set on it as well — and in any
       * context that shares a cookie jar with the admin SPA (a WebView, a
       * hybrid shell) that is the §28 exposure arriving through another door:
       * script in that context is thereafter authenticated automatically on
       * every route, without ever having read a token.
       *
       * A native client has no jar and never asked for one. Nothing should
       * come back but the tokens it requested.
       */
      const user = await newStaff();
      const { verifier, challenge } = pkce();

      const login = await nativeLogin(user.email, challenge).expect(
        httpStatus.OK,
      );
      const tokens = await exchange(
        login.body.data.authorizationCode,
        verifier,
      ).expect(httpStatus.OK);

      const res = await request(app)
        .post("/api/app/auth/refresh")
        .send({ refreshToken: tokens.body.data.refreshToken })
        .expect(httpStatus.OK);

      expect(res.body.data.token).toEqual(expect.any(String));
      expect(cookieValue(res, COOKIE_NAMES.access)).toBeUndefined();

      // Not just the access cookie — nothing at all was set.
      expect(res.headers["set-cookie"]).toBeUndefined();
    });

    it("clears no cookies when a body refresh is refused", async () => {
      // Clearing looks harmless, but in the WebView that shares a jar with
      // the admin SPA it logs that SPA out over a request that had nothing to
      // do with it. The jar belongs to whoever authenticated from it.
      const res = await request(app)
        .post("/api/app/auth/refresh")
        .send({ refreshToken: "not-a-real-refresh-token" })
        .expect(httpStatus.UNAUTHORIZED);

      expect(res.headers["set-cookie"]).toBeUndefined();
    });

    it("prefers the body when a client somehow has both", async () => {
      // A native client on a platform that silently keeps cookies would
      // otherwise be served the cookie branch and get an empty body back,
      // which looks like a server bug from the client's side.
      const user = await newStaff();
      const { verifier, challenge } = pkce();

      const login = await nativeLogin(user.email, challenge).expect(
        httpStatus.OK,
      );
      const tokens = await exchange(
        login.body.data.authorizationCode,
        verifier,
      ).expect(httpStatus.OK);

      const agent = request.agent(app);
      const other = await newStaff();
      await agent
        .post("/api/app/auth/login")
        .send({ email: other.email, password: TEST_PASSWORD })
        .expect(httpStatus.OK);

      const res = await agent
        .post("/api/app/auth/refresh")
        .send({ refreshToken: tokens.body.data.refreshToken })
        .expect(httpStatus.OK);

      expect(res.body.data.token).toEqual(expect.any(String));
      // And it answered for the body's session, not the cookie's.
      expect(res.body.data.user.id).toBe(user.id);
    });
  });

  describe("what redemption refuses", () => {
    it("a code that has already been spent", async () => {
      const user = await newStaff();
      const { verifier, challenge } = pkce();

      const login = await nativeLogin(user.email, challenge).expect(
        httpStatus.OK,
      );
      const code = login.body.data.authorizationCode as string;

      await exchange(code, verifier).expect(httpStatus.OK);
      await exchange(code, verifier).expect(httpStatus.UNAUTHORIZED);
    });

    it("and revokes the session the first redemption produced", async () => {
      // A code arriving twice means two parties hold it, and the FIRST
      // redemption is the one that cannot be trusted — it may have been the
      // attacker, with the real client arriving second. RFC 6749 §4.1.2 asks
      // for the tokens issued from that code to be revoked.
      const user = await newStaff();
      const { verifier, challenge } = pkce();

      const login = await nativeLogin(user.email, challenge).expect(
        httpStatus.OK,
      );
      const code = login.body.data.authorizationCode as string;

      const first = await exchange(code, verifier).expect(httpStatus.OK);
      await self(first.body.data.token).expect(httpStatus.OK);

      await exchange(code, verifier).expect(httpStatus.UNAUTHORIZED);

      // The session minted by the first redemption is gone, so whoever held
      // it has to start again with a password.
      await self(first.body.data.token).expect(httpStatus.UNAUTHORIZED);
    });

    it("a wrong verifier", async () => {
      const user = await newStaff();
      const { challenge } = pkce();
      const wrong = generateCodeVerifier();

      const login = await nativeLogin(user.email, challenge).expect(
        httpStatus.OK,
      );

      await exchange(login.body.data.authorizationCode, wrong).expect(
        httpStatus.UNAUTHORIZED,
      );
    });

    it("and burns the code, so there is exactly one guess", async () => {
      // The claim happens before the verifier is checked, deliberately. A
      // code-holder without the verifier gets one attempt, not as many as
      // fit inside the expiry window.
      const user = await newStaff();
      const { verifier, challenge } = pkce();

      const login = await nativeLogin(user.email, challenge).expect(
        httpStatus.OK,
      );
      const code = login.body.data.authorizationCode as string;

      await exchange(code, generateCodeVerifier()).expect(
        httpStatus.UNAUTHORIZED,
      );

      // Even the RIGHT verifier is now too late.
      await exchange(code, verifier).expect(httpStatus.UNAUTHORIZED);
    });

    it("a code that has expired", async () => {
      const user = await newStaff();
      const { verifier, challenge } = pkce();

      const login = await nativeLogin(user.email, challenge).expect(
        httpStatus.OK,
      );

      await prisma.authCode.updateMany({
        where: { userId: user.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await exchange(login.body.data.authorizationCode, verifier).expect(
        httpStatus.UNAUTHORIZED,
      );
    });

    it("a code nobody issued", async () => {
      await exchange(generateCodeVerifier(), generateCodeVerifier()).expect(
        httpStatus.UNAUTHORIZED,
      );
    });

    it("a malformed verifier, without touching the row", async () => {
      // Rejected at validation, so a short or wrongly-alphabetised verifier
      // cannot be used to burn somebody else's code.
      const user = await newStaff();
      const { verifier, challenge } = pkce();

      const login = await nativeLogin(user.email, challenge).expect(
        httpStatus.OK,
      );
      const code = login.body.data.authorizationCode as string;

      await exchange(code, "short").expect(httpStatus.BAD_REQUEST);

      // Still redeemable by its rightful owner.
      await exchange(code, verifier).expect(httpStatus.OK);
    });

    it("says the same thing however it failed", async () => {
      // Unknown, expired, replayed and mismatched all answer identically.
      // The caller is unauthenticated; telling them which one would be
      // answering a question only an attacker asks.
      const user = await newStaff();
      const { verifier, challenge } = pkce();

      const login = await nativeLogin(user.email, challenge).expect(
        httpStatus.OK,
      );
      const code = login.body.data.authorizationCode as string;

      const unknown = await exchange(generateCodeVerifier(), verifier);
      const mismatched = await exchange(code, generateCodeVerifier());
      const replayed = await exchange(code, verifier);

      const messages = [unknown, mismatched, replayed].map(
        (r) => r.body.message,
      );
      expect(new Set(messages).size).toBe(1);
    });

    it("an account locked between login and exchange", async () => {
      // A minute is short but it is not zero. The code proves a password was
      // accepted; it does not prove the account is still welcome.
      const user = await newStaff();
      const { verifier, challenge } = pkce();

      const login = await nativeLogin(user.email, challenge).expect(
        httpStatus.OK,
      );

      await prisma.user.update({
        where: { id: user.id },
        data: {
          lockUntil: new Date(
            Date.now() + config.AUTH.LOCK_TIME_MINUTES * 60 * 1000,
          ),
        },
      });

      await exchange(login.body.data.authorizationCode, verifier).expect(
        httpStatus.TOO_MANY_REQUESTS,
      );
    });

    it("a deleted account", async () => {
      const user = await newStaff();
      const { verifier, challenge } = pkce();

      const login = await nativeLogin(user.email, challenge).expect(
        httpStatus.OK,
      );

      await prisma.user.delete({ where: { id: user.id } });

      await exchange(login.body.data.authorizationCode, verifier).expect(
        httpStatus.UNAUTHORIZED,
      );
    });
  });

  describe("one code belongs to one login", () => {
    it("cannot be redeemed with another login's verifier", async () => {
      // The binding that makes an intercepted code useless: it is tied to a
      // secret the client chose before it had a code at all.
      const user = await newStaff();
      const first = pkce();
      const second = pkce();

      const login = await nativeLogin(user.email, first.challenge).expect(
        httpStatus.OK,
      );

      await exchange(
        login.body.data.authorizationCode,
        second.verifier,
      ).expect(httpStatus.UNAUTHORIZED);
    });

    it("two concurrent logins produce independent codes", async () => {
      const user = await newStaff();
      const a = pkce();
      const b = pkce();

      const [first, second] = await Promise.all([
        nativeLogin(user.email, a.challenge),
        nativeLogin(user.email, b.challenge),
      ]);

      expect(first.status).toBe(httpStatus.OK);
      expect(second.status).toBe(httpStatus.OK);

      const codeA = first.body.data.authorizationCode as string;
      const codeB = second.body.data.authorizationCode as string;
      expect(codeA).not.toBe(codeB);

      // Each opens with its own verifier and no other. Both halves: the
      // positive one used to be untested, because both lines used
      // `b.verifier` and the mismatch burned `codeA` before `a.verifier`
      // could be tried on it.
      await exchange(codeA, a.verifier).expect(httpStatus.OK);
      await exchange(codeB, a.verifier).expect(httpStatus.UNAUTHORIZED);
      await exchange(codeB, b.verifier).expect(httpStatus.UNAUTHORIZED);
    });
  });

  describe("a replay is detected after the code has expired", () => {
    /**
     * Redeemed rows are deliberately kept past their expiry — the schema, the
     * cleanup job and §28 all say so — because a consumed row is the only
     * thing that makes a replay visible. The check that reads them was
     * ordered behind the expiry test, so none of that retention did anything:
     * a consumed-but-expired row came back `invalid` and the controller's
     * revocation branch never ran.
     *
     * The timing is not exotic. The attacker redeems immediately; the real
     * client is the one that arrives late, because it is the one on a train.
     * A mobile handoff, a retry backoff or a cold resume past the 60-second
     * window was enough to let the attacker's session run its full term.
     */
    it("revokes the first session even when the replay arrives late", async () => {
      const user = await newStaff();
      const { verifier, challenge } = pkce();

      const login = await nativeLogin(user.email, challenge).expect(
        httpStatus.OK,
      );
      const code = login.body.data.authorizationCode;

      // The attacker gets there first and is given a working session.
      const stolen = await exchange(code, verifier).expect(httpStatus.OK);
      await self(stolen.body.data.token).expect(httpStatus.OK);

      // Now push the row past its expiry, which is what the clock would have
      // done while the real client was reconnecting.
      await prisma.authCode.update({
        where: { code: hashToken(code) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      // The real client arrives late with the same code.
      await exchange(code, verifier).expect(httpStatus.UNAUTHORIZED);

      // THE regression: the attacker's session must be dead. Before the fix
      // this still returned 200, for the whole refresh lifetime.
      await self(stolen.body.data.token).expect(httpStatus.UNAUTHORIZED);
    });

    it("still reports an unredeemed expired code as simply invalid", async () => {
      // The reordering must not turn every expired code into a replay — a
      // code that was never used has no session behind it and nothing to
      // revoke, and saying \"replayed\" in the log would be a false alarm.
      const user = await newStaff();
      const { verifier, challenge } = pkce();

      const login = await nativeLogin(user.email, challenge).expect(
        httpStatus.OK,
      );
      const code = login.body.data.authorizationCode;

      await prisma.authCode.update({
        where: { code: hashToken(code) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await exchange(code, verifier).expect(httpStatus.UNAUTHORIZED);

      const row = await prisma.authCode.findUnique({
        where: { code: hashToken(code) },
      });
      expect(row?.consumedAt).toBeNull();
      expect(row?.sessionId).toBeNull();
    });
  });

  describe("a claimed code always names a session that exists", () => {
    /**
     * This is the replay defence's load-bearing invariant, and it took three
     * tries to get right. The loser of a redemption race revokes the session
     * the winner produced, so it has to be able to find a row.
     *
     *   1. `sessionId` written by a follow-up UPDATE after the session
     *      INSERT — a loser landing between the two read null.
     *   2. `sessionId` written by the claim, session still created after —
     *      the loser read the right id and revoked nothing, because the row
     *      it named did not exist yet. The window moved rather than closing,
     *      and it was wider: it spanned two more awaited round trips.
     *   3. Session created first, then claimed. A loser's claim waits on the
     *      winner's row lock, and the winner took that lock only after its
     *      INSERT had committed.
     *
     * So: by the time a code carries a session id, that session is real.
     */
    it("has inserted the session before the claim records it", async () => {
      const { findRedeemableCode, claimAuthCode, issueAuthCode } = await import(
        "../../src/services/auth-code.service"
      );
      const { issueAuthSession } = await import(
        "../../src/services/session.service"
      );

      const user = await newStaff();
      const verifier = generateCodeVerifier();
      const { code } = await issueAuthCode(
        user.id,
        deriveCodeChallenge(verifier),
      );

      const found = await findRedeemableCode(code);
      expect(found.ok).toBe(true);

      const sessionId = randomUUID();
      await issueAuthSession(user, fakeRequest(), sessionId);

      const claimed = await claimAuthCode(found.authCode!, verifier, sessionId);
      expect(claimed.ok).toBe(true);

      const row = await prisma.authCode.findUnique({
        where: { code: hashToken(code) },
      });
      expect(row?.sessionId).toBe(sessionId);
      expect(row?.consumedAt).not.toBeNull();

      // THE assertion. Version 2 of this code passed everything above and
      // failed this: the id was on the row while the session was still three
      // awaits away from existing.
      const session = await prisma.session.findUnique({
        where: { id: sessionId },
      });
      expect(session).not.toBeNull();
      expect(session?.isActive).toBe(true);
    });

    it("hands the loser of a race an id it can actually revoke", async () => {
      const { findRedeemableCode, claimAuthCode, issueAuthCode } = await import(
        "../../src/services/auth-code.service"
      );
      const { issueAuthSession } = await import(
        "../../src/services/session.service"
      );

      const user = await newStaff();
      const verifier = generateCodeVerifier();
      const { code } = await issueAuthCode(
        user.id,
        deriveCodeChallenge(verifier),
      );

      const found = await findRedeemableCode(code);
      const authCode = found.authCode!;

      const redeem = async () => {
        const sessionId = randomUUID();
        await issueAuthSession(user, fakeRequest(), sessionId);
        return { sessionId, result: await claimAuthCode(authCode, verifier, sessionId) };
      };

      const [a, b] = await Promise.all([redeem(), redeem()]);

      const winner = a.result.ok ? a : b;
      const loser = a.result.ok ? b : a;

      expect(winner.result.ok).toBe(true);
      expect(loser.result.ok).toBe(false);
      expect(loser.result.ok === false && loser.result.reason).toBe("replayed");

      // The id the loser is handed must be the winner's, and it must name a
      // row — otherwise the revocation it is about to attempt is a no-op.
      const claimedId = loser.result.authCode?.sessionId;
      expect(claimedId).toBe(winner.sessionId);
      await expect(
        prisma.session.findUnique({ where: { id: claimedId! } }),
      ).resolves.not.toBeNull();
    });

    it("disowns the session when the verifier turns out to be wrong", async () => {
      // The code stays burned — that is the point of claiming first — but it
      // must not keep pointing at a session that is about to be thrown away,
      // or the next replay reports revoking something that was never real.
      const { findRedeemableCode, claimAuthCode, issueAuthCode } = await import(
        "../../src/services/auth-code.service"
      );
      const { issueAuthSession } = await import(
        "../../src/services/session.service"
      );

      const user = await newStaff();
      const { code } = await issueAuthCode(
        user.id,
        deriveCodeChallenge(generateCodeVerifier()),
      );

      const found = await findRedeemableCode(code);
      const sessionId = randomUUID();
      await issueAuthSession(user, fakeRequest(), sessionId);

      const claimed = await claimAuthCode(
        found.authCode!,
        generateCodeVerifier(),
        sessionId,
      );
      expect(claimed.ok === false && claimed.reason).toBe("mismatch");

      const row = await prisma.authCode.findUnique({
        where: { code: hashToken(code) },
      });
      expect(row?.consumedAt).not.toBeNull();
      expect(row?.sessionId).toBeNull();
    });
  });

  describe("the database enforces the ordering", () => {
    it("cannot be claimed for a session that does not exist", async () => {
      /**
       * The deterministic half of the invariant. The race spec below can only
       * catch a wrong ordering some of the time — it reproduced at about one
       * run in twelve — so the guarantee is delegated to the database: a
       * foreign key on `auth_codes.session_id`.
       *
       * Reverse the ordering in the controller and this is what happens, on
       * every single redemption rather than on an unlucky one.
       */
      const { findRedeemableCode, claimAuthCode, issueAuthCode } = await import(
        "../../src/services/auth-code.service"
      );

      const user = await newStaff();
      const verifier = generateCodeVerifier();
      const { code } = await issueAuthCode(
        user.id,
        deriveCodeChallenge(verifier),
      );

      const found = await findRedeemableCode(code);

      await expect(
        claimAuthCode(found.authCode!, verifier, randomUUID()),
      ).rejects.toThrow();

      // And the code is untouched, so the rightful client can still use it.
      const row = await prisma.authCode.findUnique({
        where: { code: hashToken(code) },
      });
      expect(row?.consumedAt).toBeNull();
    });
  });

  describe("two clients redeeming one code at the same time", () => {
    /**
     * The end-to-end version of the invariant above, over HTTP, because the
     * bug it covers was invisible at the service level: the service calls
     * all returned what they should while the session the winner went on to
     * create was never revoked.
     *
     * Repeated, because a race that fails one time in twelve passes a single
     * run eleven times out of twelve.
     */
    it("leaves neither party with a working session", async () => {
      const user = await newStaff();

      for (let attempt = 0; attempt < 8; attempt += 1) {
        const { verifier, challenge } = pkce();
        const login = await nativeLogin(user.email, challenge).expect(
          httpStatus.OK,
        );
        const code = login.body.data.authorizationCode as string;

        const [first, second] = await Promise.all([
          exchange(code, verifier),
          exchange(code, verifier),
        ]);

        const statuses = [first.status, second.status].sort();
        expect(statuses).toEqual([httpStatus.OK, httpStatus.UNAUTHORIZED]);

        const won = first.status === httpStatus.OK ? first : second;

        // THE regression. The winner's session must be revoked by the loser's
        // replay — every time, not most times.
        await self(won.body.data.token).expect(httpStatus.UNAUTHORIZED);
      }
    });

    it("leaves no session rows behind for the refused attempt", async () => {
      // The losing request creates a session before it claims, and has to
      // delete it again. A row per failed redemption would be a slow leak in
      // the highest-churn path in the API.
      const user = await newStaff();
      const { verifier, challenge } = pkce();

      const login = await nativeLogin(user.email, challenge).expect(
        httpStatus.OK,
      );
      const code = login.body.data.authorizationCode as string;

      await Promise.all([exchange(code, verifier), exchange(code, verifier)]);

      // One session: the winner's, now revoked. Not two.
      const sessions = await prisma.session.findMany({
        where: { userId: user.id },
      });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.isActive).toBe(false);
    });

    it("leaves no session behind when the verifier is wrong", async () => {
      const user = await newStaff();
      const { challenge } = pkce();

      const login = await nativeLogin(user.email, challenge).expect(
        httpStatus.OK,
      );

      await exchange(
        login.body.data.authorizationCode,
        generateCodeVerifier(),
      ).expect(httpStatus.UNAUTHORIZED);

      const sessions = await prisma.session.count({
        where: { userId: user.id },
      });
      expect(sessions).toBe(0);
    });
  });

  describe("a native login with an unusable challenge is refused", () => {
    /**
     * `nativeChallenge` re-checks the challenge rather than trusting the Joi
     * schema, which is right — but it used to express \"no\" by returning
     * `undefined`, and `undefined` is also how it says \"this is a browser\".
     * So the refusal fell through to the browser branch and the caller was
     * answered 200, with two Set-Cookie headers it has no jar for and no
     * authorization code: a live session it could neither use nor revoke,
     * wearing the shape of success.
     *
     * The route's schema rejects a malformed challenge first, so this is
     * reached by calling the handler directly — which is also the only way to
     * test a backstop whose whole purpose is to hold when the thing in front
     * of it has been removed.
     */
    const callLogin = (body: Record<string, unknown>) =>
      new Promise<{ error?: ApiError; status?: number; cookies: string[] }>(
        (resolve, reject) => {
          const cookies: string[] = [];
          let status: number | undefined;

          const res = {
            cookie: (name: string) => {
              cookies.push(name);
              return res;
            },
            status: (code: number) => {
              status = code;
              return res;
            },
            send: () => resolve({ status, cookies }),
          } as unknown as Response;

          const req = {
            body,
            headers: {},
            ip: "127.0.0.1",
          } as unknown as Request;

          authController.loginUserWithEmailAndPassword(
            req,
            res,
            ((err: unknown) =>
              err instanceof ApiError
                ? resolve({ error: err, cookies })
                : reject(err)) as NextFunction,
          );
        },
      );

    it("throws 400 instead of quietly issuing a browser session", async () => {
      const user = await newStaff();

      const result = await callLogin({
        email: user.email,
        password: TEST_PASSWORD,
        client: "native",
        codeChallenge: "not-a-valid-s256-challenge",
      });

      expect(result.error?.statusCode).toBe(httpStatus.BAD_REQUEST);

      // THE regression. Before the fix this resolved 200 with both cookies.
      expect(result.status).toBeUndefined();
      expect(result.cookies).toEqual([]);
    });

    it("refuses a native login with no challenge at all", async () => {
      const user = await newStaff();

      const result = await callLogin({
        email: user.email,
        password: TEST_PASSWORD,
        client: "native",
      });

      expect(result.error?.statusCode).toBe(httpStatus.BAD_REQUEST);
      expect(result.cookies).toEqual([]);
    });

    it("creates no session for a refused native login", async () => {
      // A 400 that still left a session row behind would be the same bug
      // wearing a different status code.
      const user = await newStaff();

      await callLogin({
        email: user.email,
        password: TEST_PASSWORD,
        client: "native",
        codeChallenge: "still-not-valid",
      });

      const sessions = await prisma.session.count({
        where: { userId: user.id },
      });
      expect(sessions).toBe(0);
    });

    it("a browser login is untouched by the stricter check", async () => {
      // The guard must not have been tightened into rejecting the common
      // path: no `client` at all still means browser, and still works.
      const user = await newStaff();

      const res = await request(app)
        .post("/api/app/auth/login")
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(httpStatus.OK);

      expect(cookieValue(res, COOKIE_NAMES.access)).toEqual(expect.any(String));
      expect(res.body.data.authorizationCode).toBeUndefined();
    });
  });

  describe("the expiry sweep", () => {
    it("collects codes past their expiry and leaves live ones", async () => {
      const user = await newStaff();
      const live = pkce();
      const dead = pkce();

      await nativeLogin(user.email, dead.challenge).expect(httpStatus.OK);
      await prisma.authCode.updateMany({
        where: { userId: user.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await nativeLogin(user.email, live.challenge).expect(httpStatus.OK);

      const { deleteExpiredAuthCodes } = await import(
        "../../src/services/auth-code.service"
      );
      await deleteExpiredAuthCodes();

      const remaining = await prisma.authCode.findMany({
        where: { userId: user.id },
      });
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });
  });
});
