import express, { Express, RequestHandler, Request, Response } from "express";
import passport from "passport";
import request from "supertest";
import httpStatus from "http-status";
import { Role, User } from "@prisma/client";
import { jwtStrategy } from "../../src/config/passport";
import { auth, requireSelf } from "../../src/middlewares/auth.middleware";
import {
  errorConverter,
  errorHandler,
} from "../../src/middlewares/error.middleware";
import {
  accessTokenWithRole,
  assertDatabaseReachable,
  cleanupUsers,
  createTestUser,
  disconnect,
} from "../helpers/db";

/**
 * Who is allowed to call what.
 *
 * WHY THIS IS AN INTEGRATION SPEC. It used to live in `tests/unit/` with a
 * comment explaining that no database was involved, because `jwtVerify` built
 * `req.user` from the token payload alone. That is no longer true: an access
 * token now carries a `sid` claim naming its `sessions` row, and the strategy
 * resolves it on every request so that logout and session revocation take
 * effect immediately (docs/decisions.md §5). A signed token with no live
 * session behind it is refused before any rights check runs, so the callers
 * here need real users and real sessions.
 *
 * What the spec is about has not changed. The rights matrix below is the
 * subject; the session is setup.
 *
 * THE REGRESSION THESE PIN:
 * `auth` used to carry an ownership exemption inside the rights check:
 *
 *     if (!hasRights && req.params.userId !== user.id) { reject(403) }
 *
 * Read it carefully — when the route named its parameter `userId` and the
 * value equalled the caller's own id, the condition was false and the request
 * was **allowed through with no rights at all**. It was meant to let an
 * account read its own profile. On a staff-management route it is
 * self-promotion to ADMIN, and `validations/user.validation.ts` already holds
 * unwired `updateUserRole` / `deactivateAndReactivateUser` schemas keyed on
 * exactly that parameter name.
 *
 * `users` is the staff table, so STAFF is now the least-privileged principal
 * that can hold a token for this API at all. The two specs at the bottom of
 * the first block cover what happens to a token signed with a role that no
 * longer exists, which is not hypothetical: CUSTOMER was removed from the
 * enum while access tokens carrying it were still inside their lifetime.
 */

passport.use("jwt", jwtStrategy);

let caller: User;
let other: User;

/** Set in `beforeAll`; the specs read them as route parameters. */
let CALLER: string;
let OTHER: string;

/**
 * A token for the caller carrying `role`, backed by a live session.
 *
 * The role is written into the token rather than taken from the row, because
 * two specs need a role the enum no longer has. The session is genuine either
 * way — a fabricated `sid` would be rejected by the strategy before
 * `roleRights` was ever consulted, which would prove the wrong thing.
 */
const tokenFor = (userId: string, role: Role): Promise<string> =>
  accessTokenWithRole(userId === CALLER ? caller : other, role);

/** An app whose single route is `PATCH /users/:userId/role`. */
const appWithRoute = (
  path: string,
  ...middleware: RequestHandler[]
): Express => {
  const app = express();
  app.use(passport.initialize());
  app.patch(path, ...middleware, (_req: Request, res: Response) => {
    res.status(httpStatus.OK).send({ reached: true });
  });
  app.use(errorConverter, errorHandler);
  return app;
};

beforeAll(async () => {
  await assertDatabaseReachable();
  caller = await createTestUser(Role.STAFF);
  other = await createTestUser(Role.STAFF);
  CALLER = caller.id;
  OTHER = other.id;
});

afterAll(async () => {
  // Sessions cascade with the user rows.
  await cleanupUsers([caller.id, other.id]);
  await disconnect();
});

describe("auth — rights are the whole decision", () => {
  const app = appWithRoute("/users/:userId/role", auth("manage:users"));

  it("refuses STAFF promoting itself on its own :userId", async () => {
    // The exact shape of the old bypass: STAFF does not hold `manage:users`,
    // and the target id is the caller's own, so the removed exemption would
    // have waved this through with no rights at all.
    const res = await request(app)
      .patch(`/users/${CALLER}/role`)
      .set("Authorization", `Bearer ${await tokenFor(CALLER, Role.STAFF)}`)
      .send({ role: "ADMIN" });

    expect(res.status).toBe(httpStatus.FORBIDDEN);
    expect(res.body.message).toBe("Forbidden");
  });

  it("refuses a caller without the right on someone else's :userId", async () => {
    const res = await request(app)
      .patch(`/users/${OTHER}/role`)
      .set("Authorization", `Bearer ${await tokenFor(CALLER, Role.STAFF)}`)
      .send({ role: "ADMIN" });

    expect(res.status).toBe(httpStatus.FORBIDDEN);
  });

  it("admits a caller that actually holds the right", async () => {
    const res = await request(app)
      .patch(`/users/${OTHER}/role`)
      .set("Authorization", `Bearer ${await tokenFor(CALLER, Role.ADMIN)}`)
      .send({ role: "STAFF" });

    expect(res.status).toBe(httpStatus.OK);
    expect(res.body.reached).toBe(true);
  });

  it("rejects an unauthenticated request before any rights check", async () => {
    const res = await request(app).patch(`/users/${CALLER}/role`).send({});

    expect(res.status).toBe(httpStatus.UNAUTHORIZED);
    expect(res.body.message).toBe("Please authenticate.");
  });

  it("admits any authenticated caller when no rights are required", async () => {
    const open = appWithRoute("/users/:userId/role", auth());

    const res = await request(open)
      .patch(`/users/${OTHER}/role`)
      .set("Authorization", `Bearer ${await tokenFor(CALLER, Role.STAFF)}`)
      .send({});

    expect(res.status).toBe(httpStatus.OK);
  });

  // A role the enum no longer has. Not a hypothetical: CUSTOMER was dropped
  // when `users` became the staff table, and `role` is still read from the
  // token rather than from the row the strategy now looks up — so an access
  // token already issued with `role: "CUSTOMER"` keeps that role until it
  // expires. These two pin what such a token can and cannot do meanwhile.
  const RETIRED_ROLE = "CUSTOMER" as Role;

  it("refuses a token whose role has no rights entry at all", async () => {
    const res = await request(app)
      .patch(`/users/${CALLER}/role`)
      .set("Authorization", `Bearer ${await tokenFor(CALLER, RETIRED_ROLE)}`)
      .send({ role: "ADMIN" });

    // Fails closed, and says which role it could not resolve — the message
    // goes to an operator reading a log, and names nothing a caller did not
    // already put in their own token.
    expect(res.status).toBe(httpStatus.FORBIDDEN);
    expect(res.body.message).toBe("Role rights for CUSTOMER are undefined.");
  });

  it("still admits a retired role on a route that requires no rights", async () => {
    // Documenting a real gap rather than approving of it. `auth()` with an
    // empty rights list never looks the role up, so a stale CUSTOMER token
    // keeps working on GET /api/app/auth/self until it expires — or until
    // its session is revoked, which is now a thing anyone can do about it.
    // The structural fix is still the separate signing secret per principal
    // in docs/decisions.md §13, which makes a storefront token unusable
    // against this API rather than merely unprivileged.
    const open = appWithRoute("/users/:userId/role", auth());

    const res = await request(open)
      .patch(`/users/${CALLER}/role`)
      .set("Authorization", `Bearer ${await tokenFor(CALLER, RETIRED_ROLE)}`)
      .send({});

    expect(res.status).toBe(httpStatus.OK);
  });
});

describe("requireSelf — ownership narrows, never widens", () => {
  // `read:own_profile` is a right STAFF genuinely holds, so these isolate the
  // ownership check rather than re-testing the rights check.
  const app = appWithRoute(
    "/users/:userId/role",
    auth("read:own_profile"),
    requireSelf(),
  );

  it("admits the owner", async () => {
    const res = await request(app)
      .patch(`/users/${CALLER}/role`)
      .set("Authorization", `Bearer ${await tokenFor(CALLER, Role.STAFF)}`)
      .send({});

    expect(res.status).toBe(httpStatus.OK);
  });

  it("refuses someone else's record", async () => {
    const res = await request(app)
      .patch(`/users/${OTHER}/role`)
      .set("Authorization", `Bearer ${await tokenFor(CALLER, Role.STAFF)}`)
      .send({});

    expect(res.status).toBe(httpStatus.FORBIDDEN);
  });

  it("cannot rescue a caller who lacks the right", async () => {
    // The whole point of the change: ownership is ANDed with rights, so a
    // customer on their own id still fails a staff-only route.
    const guarded = appWithRoute(
      "/users/:userId/role",
      auth("manage:users"),
      requireSelf(),
    );

    const res = await request(guarded)
      .patch(`/users/${CALLER}/role`)
      .set("Authorization", `Bearer ${await tokenFor(CALLER, Role.STAFF)}`)
      .send({});

    expect(res.status).toBe(httpStatus.FORBIDDEN);
  });

  it("honours a custom parameter name", async () => {
    const custom = appWithRoute(
      "/accounts/:accountId",
      auth("read:own_profile"),
      requireSelf("accountId"),
    );

    const mine = await request(custom)
      .patch(`/accounts/${CALLER}`)
      .set("Authorization", `Bearer ${await tokenFor(CALLER, Role.STAFF)}`)
      .send({});
    expect(mine.status).toBe(httpStatus.OK);

    const theirs = await request(custom)
      .patch(`/accounts/${OTHER}`)
      .set("Authorization", `Bearer ${await tokenFor(CALLER, Role.STAFF)}`)
      .send({});
    expect(theirs.status).toBe(httpStatus.FORBIDDEN);
  });

  it("refuses when mounted without auth, rather than letting the request through", async () => {
    // `req.user` is undefined here. Failing closed matters because this is
    // the mistake a future route author is most likely to make.
    const unguarded = appWithRoute("/users/:userId/role", requireSelf());

    const res = await request(unguarded).patch(`/users/${CALLER}/role`).send({});

    expect(res.status).toBe(httpStatus.FORBIDDEN);
  });

  it("refuses when the named parameter is absent from the route", async () => {
    const mismatched = appWithRoute(
      "/users/:userId/role",
      auth("read:own_profile"),
      requireSelf("someOtherParam"),
    );

    const res = await request(mismatched)
      .patch(`/users/${CALLER}/role`)
      .set("Authorization", `Bearer ${await tokenFor(CALLER, Role.STAFF)}`)
      .send({});

    expect(res.status).toBe(httpStatus.FORBIDDEN);
  });
});
