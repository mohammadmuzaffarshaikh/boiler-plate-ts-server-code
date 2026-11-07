import { Prisma, Role } from "@prisma/client";
import Joi from "joi";
import config from "../src/config/config";
import { prisma, connectDatabase, disconnectDatabase } from "../src/config/prisma-client";
import { hashString } from "../src/utils/hash";
import { normalizeEmail } from "../src/utils/normalize-email";
import { password as passwordRule } from "../src/validations/custom.validation";

/**
 * Seed, in two shapes.
 *
 * **Development** — one account per role, fixed passwords, printed to stdout.
 * Idempotent by upsert: re-running updates the existing rows rather than
 * failing on the unique email, so it is safe after a `migrate reset`.
 *
 * **Production** — the first ADMIN and nothing else, from
 * `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`, password never printed.
 *
 * The production path exists because there was otherwise no way to create a
 * production account at all: `/auth/register` is mounted only in development
 * (docs/decisions.md §14), there is no invite route yet (§3), and this script
 * used to refuse to run against NODE_ENV=production outright. A fresh deploy
 * had zero users and no way to make one.
 */

interface SeedUser {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  role: Role;
}

const SEED_USERS: SeedUser[] = [
  {
    // Folded, because this one is the only seed address that comes from the
    // environment. `users.email` is case-sensitive, so a SEED_ADMIN_EMAIL
    // written with a capital would upsert a second admin row beside the one
    // the application's own lookups — which normalise — can ever find.
    email: normalizeEmail(process.env.SEED_ADMIN_EMAIL ?? "admin@example.com"),
    password: process.env.SEED_ADMIN_PASSWORD ?? "Admin12345",
    firstName: "Test",
    lastName: "Admin",
    role: Role.ADMIN,
  },
  // A non-admin account, so the difference between the two staff roles is
  // something you can actually log in as: STAFF may upload and delete any
  // file but holds no `manage:users` or `access:admin_panel`.
  //
  // There is no customer here. `users` is the staff table; a shopper seeded
  // into it would be a staff account wearing the wrong label. Customers get
  // their own table and their own seed when that table exists
  // (docs/decisions.md §2).
  {
    email: "staff@example.com",
    password: "Staff12345",
    firstName: "Test",
    lastName: "Staff",
    role: Role.STAFF,
  },
];

/**
 * Credentials for the production bootstrap.
 *
 * Validated here and NOT in `src/config/config.ts`, deliberately. Nothing but
 * this script reads them, and putting them in the application's boot schema
 * would mean a typo in a seed-only variable refuses to start the API — a
 * running service taken down by a value it never reads.
 *
 * The password rule is imported from `validations/custom.validation` rather
 * than restated, so the first admin cannot be given a password the app would
 * reject from anybody else.
 */
const adminCredentialsSchema = Joi.object({
  SEED_ADMIN_EMAIL: Joi.string()
    .required()
    // tlds off for the same reason EMAIL_FROM_ADDRESS turns them off in
    // config.ts: the bundled IANA list rejects internal and newly delegated
    // domains, and goes stale with the package.
    .email({ tlds: { allow: false } }),
  SEED_ADMIN_PASSWORD: Joi.string().required().custom(passwordRule),
});

/**
 * Create the first production ADMIN, once.
 *
 * `create`, not `upsert`, and that is the whole design. An upsert here would
 * rewrite the live admin's password to whatever is in the environment every
 * time the seed ran — and `db:seed` is exactly the kind of command that ends
 * up in a deploy script. That turns a routine redeploy into a silent
 * credential rollback, undoing a password the owner had since changed.
 *
 * So: it creates the account if it is absent, and leaves it completely alone
 * if it is not. Re-running is safe and does nothing.
 */
const seedProductionAdmin = async (): Promise<void> => {
  const { value, error } = adminCredentialsSchema
    .prefs({ errors: { label: "key" } })
    .validate({
      SEED_ADMIN_EMAIL: process.env.SEED_ADMIN_EMAIL,
      SEED_ADMIN_PASSWORD: process.env.SEED_ADMIN_PASSWORD,
    });

  if (error) {
    throw new Error(
      `Refusing to seed: ${error.message}. Bootstrapping production needs ` +
        "SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD set to the first " +
        "administrator's credentials.",
    );
  }

  // Folded before both the lookup and the write, because `users.email` is a
  // case-sensitive unique index: an address written with a capital would
  // create a second admin row that none of the application's own lookups —
  // which all normalise — could ever find.
  const email = normalizeEmail(value.SEED_ADMIN_EMAIL as string);
  const password = await hashString(value.SEED_ADMIN_PASSWORD as string);

  try {
    await prisma.user.create({
      // `emailVerifiedAt` stays null, as in the development path above.
      // ADMIN is exempt from the verification gate; stamping the column
      // would assert a round-trip that never happened.
      data: { email, password, role: Role.ADMIN },
    });
    // The password is NOT printed. Production stdout goes to a log
    // aggregator, and this one is a live credential.
    console.log(`Created the first ADMIN: ${email}`);
    console.log(
      "Its password is the value of SEED_ADMIN_PASSWORD. Change it after " +
        "first sign-in, and remove the variable from the environment.",
    );
  } catch (err) {
    // Lost a race, or simply ran twice. Either way the account exists and is
    // not this script's to touch.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      console.log(`ADMIN ${email} already exists — left untouched.`);
      return;
    }
    throw err;
  }
};

const seed = async (): Promise<void> => {
  // Same bounded retry and real round-trip the server uses, so a seed run
  // against a database that is still starting waits instead of failing, and
  // one against a dead database says so plainly.
  await connectDatabase();

  if (config.ENV === "production") {
    await seedProductionAdmin();
    return;
  }

  console.log("Seeding development accounts (email / password):");

  for (const user of SEED_USERS) {
    const password = await hashString(user.password);

    // `emailVerifiedAt` is deliberately left null, including for the admin.
    // ADMIN is exempt from the verification *gate* (see config/constants),
    // but stamping the column would assert a round-trip that never happened
    // — the schema comment on that field is explicit about this.
    await prisma.user.upsert({
      where: { email: user.email },
      update: {
        password,
        role: user.role,
        firstName: user.firstName,
        lastName: user.lastName,
      },
      create: {
        email: user.email,
        password,
        role: user.role,
        firstName: user.firstName,
        lastName: user.lastName,
      },
    });

    console.log(
      `  ${user.role.padEnd(8)} ${user.email.padEnd(24)} ${user.password}`,
    );
  }
};

// Run only when invoked as a script (`pnpm db:seed`), never on import.
// Without this guard a spec that imports `seedProductionAdmin` to test it
// would seed the developer's own database as a side effect of loading the
// module — and the production branch is exactly the one worth testing.
if (require.main === module) {
  seed()
    .then(() => console.log("Done."))
    .catch((err) => {
      console.error("Seed failed:", err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => disconnectDatabase());
}

export { seed, seedProductionAdmin, adminCredentialsSchema };
