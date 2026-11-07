import { Request } from "express";
import { Prisma, Role, User } from "@prisma/client";
import { prisma } from "../../src/config/prisma-client";
import { hashString } from "../../src/utils/hash";
import * as sessionService from "../../src/services/session.service";
import { generateAccessToken } from "../../src/services/token.service";

/**
 * Database helpers for the integration specs.
 *
 * Every spec creates its own rows with unique identifiers and removes them
 * afterwards, rather than truncating shared tables — so a run does not wipe
 * whatever is already in the development database, and two spec files cannot
 * destroy each other's fixtures.
 */

/** Fails with an actionable message instead of a Prisma stack trace. */
export const assertDatabaseReachable = async (): Promise<void> => {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    throw new Error(
      "Cannot reach the database. Integration tests need Postgres running " +
        "and the schema migrated:\n" +
        "  docker start boilerplate-pg   (or see tests/README.md)\n" +
        "  pnpm prisma:migrate\n" +
        `Original error: ${(err as Error).message.split("\n").pop()?.trim()}`,
      { cause: err },
    );
  }
};

export const TEST_PASSWORD = "TestPassw0rd";

/**
 * A password-login user of the given role, with a collision-proof address.
 *
 * Defaults to STAFF because STAFF is the least-privileged thing `users` can
 * hold — it is the staff table, and the lowest rung of it is the right
 * default for a spec that does not care. Shoppers are not an option here;
 * they are a different table entirely (docs/decisions.md §2).
 */
export const createTestUser = async (
  role: Role = Role.STAFF,
  overrides: Partial<Prisma.UserCreateInput> = {},
): Promise<User> =>
  prisma.user.create({
    data: {
      email: `spec-${role.toLowerCase()}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}@example.com`,
      password: await hashString(TEST_PASSWORD),
      firstName: "Spec",
      lastName: role,
      role,
      ...overrides,
    },
  });

/**
 * The smallest thing `captureRequestContext` will accept.
 *
 * It reads `req.headers["user-agent"]` and `req.ip` and nothing else, so a
 * spec that only needs tokens does not have to build a real request.
 */
const fakeRequest = (): Request =>
  ({ headers: {}, ip: "127.0.0.1" }) as unknown as Request;

/**
 * Log a user in without going through the login route.
 *
 * Since access tokens carry a `sid` claim that `config/passport.ts` resolves
 * against `sessions` on every request, `generateAccessToken` on its own no
 * longer produces a usable credential — there has to be a session row behind
 * it. Specs that just need "a token for this user" want this.
 */
export const issueSessionFor = async (user: User) =>
  sessionService.issueAuthSession(user, fakeRequest());

/** Shorthand for specs that need the access token and nothing else. */
export const accessTokenFor = async (user: User): Promise<string> =>
  (await issueSessionFor(user)).access.token;

/**
 * A token bound to a real, live session but carrying an arbitrary `role`.
 *
 * For the specs that cover a role the enum no longer has: CUSTOMER was
 * dropped when `users` became the staff table, and tokens carrying it were
 * still inside their lifetime. The session has to be genuine or the strategy
 * rejects the token before `roleRights` is ever consulted, which would prove
 * the wrong thing.
 */
export const accessTokenWithRole = async (
  user: User,
  role: Role,
): Promise<string> => {
  const { id } = await sessionService.createSession({
    userId: user.id,
    refreshToken: `spec-${user.id}-${Date.now()}-${Math.random()}`,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    ipAddress: null,
    userAgent: null,
    deviceInfo: {},
  });

  return generateAccessToken(user.id, role, id).token;
};

/** Remove rows created by a spec. Safe to call with ids that are already gone. */
export const cleanupUsers = async (ids: string[]): Promise<void> => {
  if (ids.length === 0) return;
  await prisma.file.deleteMany({ where: { uploadedById: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
};

export const cleanupFiles = async (ids: string[]): Promise<void> => {
  if (ids.length === 0) return;
  await prisma.file.deleteMany({ where: { id: { in: ids } } });
};

export const disconnect = async (): Promise<void> => {
  await prisma.$disconnect();
};

export { prisma };
