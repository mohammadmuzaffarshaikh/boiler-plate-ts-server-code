import { Role } from "@prisma/client";
import { prisma, assertDatabaseReachable, disconnect } from "../helpers/db";
import { compareHash } from "../../src/utils/hash";
import config from "../../src/config/config";
import { seed, seedProductionAdmin } from "../../prisma/seed";

/**
 * How a production deployment gets its first account.
 *
 * THE GAP THIS CLOSES. `/auth/register` is mounted only in development
 * (docs/decisions.md §14), the invite flow in §3 does not exist yet, and this
 * seed used to throw outright on NODE_ENV=production. A fresh production
 * database therefore had zero users and no supported way to create one —
 * nobody could sign in to the admin surface at all.
 *
 * Run against the real database rather than a mocked Prisma: what is being
 * asserted is the *row* that ends up in `users` — its role, its folded
 * email, its hashed password, and above all that a second run does not
 * rewrite it.
 */
describe("production admin bootstrap", () => {
  const createdEmails: string[] = [];

  const withEnv = async (
    vars: Record<string, string | undefined>,
    run: () => Promise<void>,
  ): Promise<void> => {
    const previous: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(vars)) {
      previous[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      await run();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  /** A fresh address per test, so no two tests share a row. */
  const uniqueEmail = (): string => {
    const email = `seed-admin-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}@example.test`;
    createdEmails.push(email);
    return email;
  };

  beforeAll(async () => {
    await assertDatabaseReachable();
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
    await disconnect();
  });

  describe("the account it creates", () => {
    it("creates an ADMIN that can be signed in as", async () => {
      const email = uniqueEmail();

      await withEnv(
        { SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: "Bootstr4pMe" },
        () => seedProductionAdmin(),
      );

      const user = await prisma.user.findUnique({ where: { email } });
      expect(user).not.toBeNull();
      expect(user?.role).toBe(Role.ADMIN);
    });

    it("stores the password hashed, and it verifies", async () => {
      const email = uniqueEmail();

      await withEnv(
        { SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: "Bootstr4pMe" },
        () => seedProductionAdmin(),
      );

      const user = await prisma.user.findUnique({ where: { email } });
      expect(user?.password).not.toBe("Bootstr4pMe");
      await expect(compareHash("Bootstr4pMe", user!.password)).resolves.toBe(
        true,
      );
    });

    it("folds the email, so the app's own lookups can find it", async () => {
      // `users.email` is a case-sensitive unique index. An address written
      // with a capital would create a row that every normalising lookup in
      // the application misses — the account exists and cannot be used.
      const email = uniqueEmail();

      await withEnv(
        {
          SEED_ADMIN_EMAIL: email.toUpperCase(),
          SEED_ADMIN_PASSWORD: "Bootstr4pMe",
        },
        () => seedProductionAdmin(),
      );

      expect(await prisma.user.findUnique({ where: { email } })).not.toBeNull();
    });

    it("leaves emailVerifiedAt null", async () => {
      // ADMIN is exempt from the verification gate, but stamping the column
      // would assert a round-trip that never happened.
      const email = uniqueEmail();

      await withEnv(
        { SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: "Bootstr4pMe" },
        () => seedProductionAdmin(),
      );

      const user = await prisma.user.findUnique({ where: { email } });
      expect(user?.emailVerifiedAt).toBeNull();
    });
  });

  describe("running it twice", () => {
    it("does not reset a password the owner has since changed", async () => {
      // THE REASON THIS IS `create` AND NOT `upsert`. `db:seed` is exactly
      // the kind of command that ends up in a deploy script, and an upsert
      // would roll the live admin's credential back to the environment value
      // on every redeploy — silently, and with the old password still sitting
      // in the deploy config.
      const email = uniqueEmail();

      await withEnv(
        { SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: "Bootstr4pMe" },
        () => seedProductionAdmin(),
      );

      // The owner signs in and changes it.
      const changed = await prisma.user.update({
        where: { email },
        data: { password: "$2b$12$changed-by-the-owner-not-the-seed" },
      });

      await withEnv(
        { SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: "Bootstr4pMe" },
        () => seedProductionAdmin(),
      );

      const after = await prisma.user.findUnique({ where: { email } });
      expect(after?.password).toBe(changed.password);
    });

    it("does not throw on the second run", async () => {
      const email = uniqueEmail();
      const vars = { SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: "Bootstr4pMe" };

      await withEnv(vars, () => seedProductionAdmin());
      await expect(withEnv(vars, () => seedProductionAdmin())).resolves.toBeUndefined();
    });

    it("does not create a second row", async () => {
      const email = uniqueEmail();
      const vars = { SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: "Bootstr4pMe" };

      await withEnv(vars, () => seedProductionAdmin());
      await withEnv(vars, () => seedProductionAdmin());

      const count = await prisma.user.count({ where: { email } });
      expect(count).toBe(1);
    });
  });

  describe("what it refuses", () => {
    it("refuses when the email is absent", async () => {
      await expect(
        withEnv(
          { SEED_ADMIN_EMAIL: undefined, SEED_ADMIN_PASSWORD: "Bootstr4pMe" },
          () => seedProductionAdmin(),
        ),
      ).rejects.toThrow(/SEED_ADMIN_EMAIL/);
    });

    it("refuses when the password is absent", async () => {
      await expect(
        withEnv(
          { SEED_ADMIN_EMAIL: uniqueEmail(), SEED_ADMIN_PASSWORD: undefined },
          () => seedProductionAdmin(),
        ),
      ).rejects.toThrow(/SEED_ADMIN_PASSWORD/);
    });

    it("refuses a password the app itself would reject", async () => {
      // The rule is imported from validations/custom.validation, so the
      // first admin cannot hold a credential the app would refuse from
      // anybody else.
      await expect(
        withEnv(
          { SEED_ADMIN_EMAIL: uniqueEmail(), SEED_ADMIN_PASSWORD: "short1" },
          () => seedProductionAdmin(),
        ),
      ).rejects.toThrow(/8 characters/);
    });

    it("refuses a password with no digit", async () => {
      await expect(
        withEnv(
          { SEED_ADMIN_EMAIL: uniqueEmail(), SEED_ADMIN_PASSWORD: "lettersonly" },
          () => seedProductionAdmin(),
        ),
      ).rejects.toThrow(/letter and 1 number/);
    });

    it("refuses an address that is not an address", async () => {
      await expect(
        withEnv(
          { SEED_ADMIN_EMAIL: "not-an-email", SEED_ADMIN_PASSWORD: "Bootstr4pMe" },
          () => seedProductionAdmin(),
        ),
      ).rejects.toThrow(/SEED_ADMIN_EMAIL/);
    });

    it("creates nothing when it refuses", async () => {
      const email = uniqueEmail();

      await expect(
        withEnv(
          { SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: "bad" },
          () => seedProductionAdmin(),
        ),
      ).rejects.toThrow();

      expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    });
  });

  describe("which branch production takes", () => {
    it("seeds the admin and not the fixed development accounts", async () => {
      // The development path writes staff@example.com with a hardcoded
      // password that it prints to stdout. That must not happen in
      // production.
      //
      // Asserted as "did not touch it" rather than "does not exist": the
      // integration suite shares one database, and a previous `pnpm db:seed`
      // may well have left the row there. Comparing `updatedAt` across the
      // call proves the development branch did not run, which is the actual
      // claim, and holds whether or not the row was there to begin with.
      const email = uniqueEmail();
      const staffBefore = await prisma.user.findUnique({
        where: { email: "staff@example.com" },
      });

      const previousEnv = config.ENV;
      config.ENV = "production";

      try {
        await withEnv(
          { SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: "Bootstr4pMe" },
          () => seed(),
        );
      } finally {
        config.ENV = previousEnv;
      }

      expect(await prisma.user.findUnique({ where: { email } })).not.toBeNull();

      const staffAfter = await prisma.user.findUnique({
        where: { email: "staff@example.com" },
      });
      expect(staffAfter?.updatedAt?.toISOString() ?? null).toBe(
        staffBefore?.updatedAt?.toISOString() ?? null,
      );
      expect(staffAfter?.password ?? null).toBe(staffBefore?.password ?? null);
    });
  });
});
