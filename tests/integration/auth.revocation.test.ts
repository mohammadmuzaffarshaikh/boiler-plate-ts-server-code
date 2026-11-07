import request from "supertest";
import httpStatus from "http-status";
import jwt from "jsonwebtoken";
import { Role } from "@prisma/client";
import app from "../../src/app";
import config from "../../src/config/config";
import { tokenTypes } from "../../src/config/constants";
import {
  prisma,
  assertDatabaseReachable,
  createTestUser,
  cleanupUsers,
  disconnect,
  issueSessionFor,
  TEST_PASSWORD,
} from "../helpers/db";
import { nativeLogin } from "../helpers/auth";

/**
 * An access token can be taken away.
 *
 * THE BUG THESE PIN. `jwtVerify` used to build `req.user` from the signed
 * payload alone, with no lookup of any kind. A JWT is a claim nobody can
 * withdraw, so for the whole 30-minute lifetime of an access token:
 *
 *   - `POST /auth/logout` returned 200, flipped `sessions.is_active`, and the
 *     same bearer token kept working on `/auth/self` and `/files`
 *   - `revokeAllForUser` after a password reset did nothing to the tokens
 *     already in an attacker's hands — which is the one moment it is for
 *   - deleting a user left their token fully valid
 *
 * The fix is the `sid` claim: `token.service.generateAccessToken` writes the
 * session's id into the token and `config/passport.ts` resolves it on every
 * authenticated request, refusing a token whose session is gone, revoked or
 * expired. docs/decisions.md §5 records the trade — one primary-key lookup
 * per request, in exchange for revocation that takes effect at once.
 *
 * `/auth/self` is the probe throughout. It is mounted with a bare `auth()`,
 * so a 401 from it is the strategy talking and not a rights decision.
 */
describe("access-token revocation", () => {
  const createdUserIds: string[] = [];

  const newStaff = async (role: Role = Role.STAFF) => {
    const user = await createTestUser(role);
    createdUserIds.push(user.id);
    return user;
  };

  const self = (token: string) =>
    request(app)
      .get("/api/app/auth/self")
      .set("Authorization", `Bearer ${token}`);

  /**
   * A logged-in native client.
   *
   * These specs are about revoking bearer tokens, so they need bearer tokens
   * — which is the native shape. A browser login returns none at all now
   * (docs/decisions.md §28); its cookies are covered in
   * `auth.token-exchange.test.ts`.
   */
  const login = async (email: string, password = TEST_PASSWORD) => {
    const result = await nativeLogin(app, email, password);

    expect(result.status).toBe(httpStatus.OK);

    return { access: result.access!, refresh: result.refresh! };
  };

  beforeAll(async () => {
    await assertDatabaseReachable();
  });

  afterAll(async () => {
    await cleanupUsers(createdUserIds);
    await disconnect();
  });

  describe("logout", () => {
    it("stops the access token it was issued with", async () => {
      const user = await newStaff();
      const { access, refresh } = await login(user.email);

      await self(access).expect(httpStatus.OK);

      await request(app)
        .post("/api/app/auth/logout")
        .send({ refreshToken: refresh })
        .expect(httpStatus.OK);

      // THE regression. This was 200 before the `sid` binding existed.
      await self(access).expect(httpStatus.UNAUTHORIZED);
    });

    it("works for a client that holds only the access token", async () => {
      // A non-browser client keeps the access token and nothing else: no
      // refresh cookie, and no `refreshToken` in the body. Logout used to
      // find no credential it recognised, revoke nothing, and answer 200.
      const user = await newStaff();
      const { access } = await login(user.email);

      await request(app)
        .post("/api/app/auth/logout")
        .set("Authorization", `Bearer ${access}`)
        .expect(httpStatus.OK);

      await self(access).expect(httpStatus.UNAUTHORIZED);
    });

    it("answers 200 for a token that will not verify", async () => {
      // Logging out must always succeed in clearing the client's state. A
      // 401 here leaves the caller holding the credential it was discarding.
      await request(app)
        .post("/api/app/auth/logout")
        .set("Authorization", "Bearer not.a.jwt")
        .expect(httpStatus.OK);
    });

    it("leaves this user's other sessions alone", async () => {
      const user = await newStaff();
      const first = await login(user.email);
      const second = await login(user.email);

      await request(app)
        .post("/api/app/auth/logout")
        .send({ refreshToken: first.refresh })
        .expect(httpStatus.OK);

      await self(first.access).expect(httpStatus.UNAUTHORIZED);
      await self(second.access).expect(httpStatus.OK);
    });
  });

  describe("revoking every session", () => {
    it("a password reset stops tokens already issued", async () => {
      // The reason `revokeAllForUser` is called on this path at all: a reset
      // is what somebody does when they believe their account is in someone
      // else's hands, and until now it left that someone else logged in.
      const user = await newStaff();
      const { access } = await login(user.email);
      await self(access).expect(httpStatus.OK);

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

      await self(access).expect(httpStatus.UNAUTHORIZED);
    });

    it("deleting the account takes effect at once", async () => {
      const user = await newStaff();
      const { access } = await login(user.email);
      await self(access).expect(httpStatus.OK);

      // `sessions` cascades from `users`, so the row the token names is gone
      // and the strategy has nothing to resolve.
      await prisma.user.delete({ where: { id: user.id } });

      await self(access).expect(httpStatus.UNAUTHORIZED);
    });
  });

  describe("what the strategy refuses", () => {
    it("a token carrying no session at all", async () => {
      // The shape of every access token minted before this change: signed
      // with the real secret, unexpired, and unrevocable. Accepting it
      // "because it verifies" would reopen the hole for the length of one
      // token lifetime, and leave a permanent bypass in the code.
      const user = await newStaff();
      const unbound = jwt.sign(
        {
          sub: user.id,
          role: user.role,
          type: tokenTypes.ACCESS,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 600,
        },
        config.JWT.SECRET,
      );

      await self(unbound).expect(httpStatus.UNAUTHORIZED);
    });

    it("a token naming somebody else's session", async () => {
      // The `session.userId !== payload.sub` check. Without it a token could
      // ride on any live session in the table, and `req.user.id` would name a
      // different person from the one whose revocation state was consulted.
      const mallory = await newStaff();
      const victim = await newStaff();
      await issueSessionFor(victim);
      const victimSession = await prisma.session.findFirstOrThrow({
        where: { userId: victim.id },
      });

      const borrowed = jwt.sign(
        {
          sub: mallory.id,
          role: mallory.role,
          type: tokenTypes.ACCESS,
          sid: victimSession.id,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 600,
        },
        config.JWT.SECRET,
      );

      await self(borrowed).expect(httpStatus.UNAUTHORIZED);
    });

    it("a token whose session has expired", async () => {
      const user = await newStaff();
      const { access } = await login(user.email);

      await prisma.session.updateMany({
        where: { userId: user.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await self(access).expect(httpStatus.UNAUTHORIZED);
    });
  });

  describe("refresh", () => {
    it("extends the session it was given rather than starting a new one", async () => {
      // A fresh `sid` here would strand the old row: "log out everywhere"
      // would then miss the session the user is actually holding.
      const user = await newStaff();
      const { refresh } = await login(user.email);

      const before = await prisma.session.count({ where: { userId: user.id } });

      const refreshed = await request(app)
        .post("/api/app/auth/refresh")
        .send({ refreshToken: refresh })
        .expect(httpStatus.OK);

      const after = await prisma.session.count({ where: { userId: user.id } });
      expect(after).toBe(before);

      const reissued = refreshed.body.data.token as string;
      await self(reissued).expect(httpStatus.OK);

      // And the reissued token is revocable by the same logout.
      await request(app)
        .post("/api/app/auth/logout")
        .send({ refreshToken: refresh })
        .expect(httpStatus.OK);

      await self(reissued).expect(httpStatus.UNAUTHORIZED);
    });
  });
});
