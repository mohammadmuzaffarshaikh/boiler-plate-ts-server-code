-- `users` is the staff table. Every row in it is somebody who works on the
-- business; shoppers get a table of their own. See docs/decisions.md §2.
--
-- Postgres cannot remove a value from an enum type in place, so the type is
-- rebuilt below. The UPDATE is the part `prisma migrate` will not write for
-- you: the `USING` cast fails outright on any surviving 'CUSTOMER' row, and
-- Prisma only emits a warning about it. Re-pointing those rows at STAFF is
-- the correct repair here rather than a data loss — a CUSTOMER row in a staff
-- table was never a shopper, it was a staff account carrying the default the
-- old schema happened to hand out.
UPDATE "users" SET "role" = 'STAFF' WHERE "role" = 'CUSTOMER';

-- AlterEnum
BEGIN;
CREATE TYPE "Role_new" AS ENUM ('STAFF', 'ADMIN');
ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "role" TYPE "Role_new" USING ("role"::text::"Role_new");
ALTER TYPE "Role" RENAME TO "Role_old";
ALTER TYPE "Role_new" RENAME TO "Role";
DROP TYPE "Role_old";
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'STAFF';
COMMIT;
