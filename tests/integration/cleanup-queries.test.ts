import { Role, TokenTypes } from "@prisma/client";
import {
  prisma,
  assertDatabaseReachable,
  createTestUser,
  cleanupUsers,
  disconnect,
} from "../helpers/db";
import { deleteExpiredSessions } from "../../src/services/session.service";
import { deleteExpiredTokens } from "../../src/jobs/token-cleanup.job";

/**
 * The sweeps themselves, against a real database.
 *
 * `tests/unit/cron-schedule.test.ts` mocks `deleteExpiredTokens` and
 * `cleanupExpiredSessions` and asserts only that the wrapper schedules them
 * and catches what they throw. That leaves the queries uncovered — and these
 * are `deleteMany` calls that run unattended on a cron against the tables
 * holding every live credential.
 *
 * The failure that matters is an inverted predicate. `deleteExpiredSessions`
 * has an `OR` with an `isActive: false` arm; flip it and the sweep deletes
 * every *live* session instead, logs a cheerful count, and signs out the
 * entire staff on a timer. Nothing in the suite would have noticed.
 *
 * The positive cases — "it deletes what is expired" — are the easy half.
 * The specs that earn their place are the negative ones.
 */
describe("the cleanup sweeps", () => {
  const createdUserIds: string[] = [];

  const newUser = async () => {
    const user = await createTestUser(Role.STAFF);
    createdUserIds.push(user.id);
    return user;
  };

  const DAY_MS = 24 * 60 * 60 * 1000;

  const session = async (
    userId: string,
    fields: { isActive: boolean; expiresAt: Date; updatedAtDaysAgo?: number },
  ) => {
    const row = await prisma.session.create({
      data: {
        userId,
        refreshToken: `rt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        isActive: fields.isActive,
        expiresAt: fields.expiresAt,
      },
    });

    // `updatedAt` is `@updatedAt`, so Prisma owns it on every write and will
    // not accept a value. Backdating it needs raw SQL.
    if (fields.updatedAtDaysAgo !== undefined) {
      const when = new Date(Date.now() - fields.updatedAtDaysAgo * DAY_MS);
      await prisma.$executeRaw`
        UPDATE sessions SET updated_at = ${when} WHERE id = ${row.id}
      `;
    }

    return row;
  };

  const exists = async (id: string): Promise<boolean> =>
    (await prisma.session.findUnique({ where: { id } })) !== null;

  beforeAll(async () => {
    await assertDatabaseReachable();
  });

  afterAll(async () => {
    await cleanupUsers(createdUserIds);
    await disconnect();
  });

  describe("deleteExpiredSessions", () => {
    it("does NOT delete an active, unexpired session", async () => {
      // THE ONE THAT MATTERS. If the `OR` arms are ever inverted this is the
      // spec that fails, and it fails before the sweep reaches production
      // rather than after it has signed everybody out.
      const user = await newUser();
      const live = await session(user.id, {
        isActive: true,
        expiresAt: new Date(Date.now() + 7 * DAY_MS),
      });

      await deleteExpiredSessions();

      expect(await exists(live.id)).toBe(true);
    });

    it("does NOT delete a live session merely because it is old", async () => {
      // THE ONE THAT PINS THE `isActive: false` ARM SPECIFICALLY.
      //
      // The previous spec passes even with that boolean flipped, because its
      // session was written seconds ago. This one is unexpired, active, and
      // last written long outside the thirty-day window — the shape of every
      // session belonging to a user who has not signed in for a month. Flip
      // `isActive: false` to `true` and the sweep deletes exactly these.
      const user = await newUser();
      const oldButLive = await session(user.id, {
        isActive: true,
        expiresAt: new Date(Date.now() + 7 * DAY_MS),
        updatedAtDaysAgo: 31,
      });

      await deleteExpiredSessions();

      expect(await exists(oldButLive.id)).toBe(true);
    });

    it("does NOT delete a recently revoked session", async () => {
      // Revoked rows are kept for thirty days so a user's security page can
      // still show the sign-out. Sweeping them immediately throws that away.
      const user = await newUser();
      const revoked = await session(user.id, {
        isActive: false,
        expiresAt: new Date(Date.now() + 7 * DAY_MS),
        updatedAtDaysAgo: 2,
      });

      await deleteExpiredSessions();

      expect(await exists(revoked.id)).toBe(true);
    });

    it("deletes a session past its expiry", async () => {
      const user = await newUser();
      const expired = await session(user.id, {
        isActive: true,
        expiresAt: new Date(Date.now() - 60_000),
      });

      await deleteExpiredSessions();

      expect(await exists(expired.id)).toBe(false);
    });

    it("deletes a revoked session older than the thirty-day window", async () => {
      const user = await newUser();
      const stale = await session(user.id, {
        isActive: false,
        expiresAt: new Date(Date.now() + 7 * DAY_MS),
        updatedAtDaysAgo: 31,
      });

      await deleteExpiredSessions();

      expect(await exists(stale.id)).toBe(false);
    });

    it("keeps a revoked session one day inside the window", async () => {
      // The boundary, from the side that must survive.
      const user = await newUser();
      const justInside = await session(user.id, {
        isActive: false,
        expiresAt: new Date(Date.now() + 7 * DAY_MS),
        updatedAtDaysAgo: 29,
      });

      await deleteExpiredSessions();

      expect(await exists(justInside.id)).toBe(true);
    });

    it("returns how many it deleted", async () => {
      // The job logs this number. A count that does not match what was
      // removed is a log that lies about unattended work.
      const user = await newUser();
      await session(user.id, {
        isActive: true,
        expiresAt: new Date(Date.now() - 60_000),
      });
      await session(user.id, {
        isActive: true,
        expiresAt: new Date(Date.now() - 120_000),
      });
      const survivor = await session(user.id, {
        isActive: true,
        expiresAt: new Date(Date.now() + 7 * DAY_MS),
      });

      const count = await deleteExpiredSessions();

      expect(count).toBeGreaterThanOrEqual(2);
      expect(await exists(survivor.id)).toBe(true);
    });
  });

  describe("deleteExpiredTokens", () => {
    const token = async (userId: string, expires: Date) =>
      prisma.token.create({
        data: {
          userId,
          token: `tok-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          type: TokenTypes.RESET_PASSWORD,
          expires,
        },
      });

    it("deletes a token past its expiry", async () => {
      const user = await newUser();
      const expired = await token(user.id, new Date(Date.now() - 60_000));

      await deleteExpiredTokens();

      expect(
        await prisma.token.findUnique({ where: { id: expired.id } }),
      ).toBeNull();
    });

    it("does NOT delete a token that is still valid", async () => {
      // A reset link in somebody's inbox, deleted by the nightly sweep,
      // presents as "the link does not work" with nothing in the logs.
      const user = await newUser();
      const live = await token(user.id, new Date(Date.now() + 60 * 60_000));

      await deleteExpiredTokens();

      expect(
        await prisma.token.findUnique({ where: { id: live.id } }),
      ).not.toBeNull();
    });

    it("leaves another user's valid token alone", async () => {
      // `deleteMany` with a wrong or absent predicate empties the table.
      const [a, b] = [await newUser(), await newUser()];
      const aToken = await token(a.id, new Date(Date.now() + 60 * 60_000));
      const bToken = await token(b.id, new Date(Date.now() + 60 * 60_000));

      await deleteExpiredTokens();

      expect(await prisma.token.findUnique({ where: { id: aToken.id } })).not.toBeNull();
      expect(await prisma.token.findUnique({ where: { id: bToken.id } })).not.toBeNull();
    });
  });
});
