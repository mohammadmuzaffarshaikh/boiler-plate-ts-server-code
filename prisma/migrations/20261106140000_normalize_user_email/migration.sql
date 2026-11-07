-- Fold every stored address to lower case, once.
--
-- `users.email` is a case-sensitive unique index, and nothing lowercased on
-- the way in. `Ada@Shop.example` and `ada@shop.example` were therefore two
-- accounts for one mailbox: the second registration succeeded, the owner
-- could not log in with the casing they remembered, and `forgot-password`
-- answered its deliberately-generic 200 while sending nothing, because the
-- lookup missed. Google sign-in lowercases the address it reads out of the ID
-- token, so it could never match or link such a row either.
--
-- The application now normalises at every write and every lookup
-- (`src/utils/normalize-email.ts`). This migration brings the rows that were
-- written before that into line, so the two agree.
--
-- No schema change. A CHECK constraint (`email = lower(email)`) would make
-- the invariant unbreakable, and was deliberately left out: Prisma's schema
-- language cannot express CHECK, so one added by hand here shows up as drift
-- on the next `prisma migrate dev` and invites a reset. If it is ever added,
-- add it with a matching entry in the schema's `@@map`-level documentation
-- and expect to answer the drift prompt.

-- Refuse rather than guess. Two rows differing only in case are two accounts
-- that a human has to merge or delete — picking one here would silently
-- destroy whoever lost the coin toss, and the unique index would reject the
-- UPDATE anyway, with a message naming an index instead of the problem.
DO $$
DECLARE
  duplicates text;
BEGIN
  SELECT string_agg(folded, ', ')
    INTO duplicates
    FROM (
      SELECT lower(btrim(email)) AS folded
        FROM "users"
       GROUP BY lower(btrim(email))
      HAVING count(*) > 1
    ) d;

  IF duplicates IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot normalise user emails: % already exists under more than one casing. Merge or delete the duplicate rows, then re-run this migration.',
      duplicates;
  END IF;
END
$$;

UPDATE "users"
   SET "email" = lower(btrim("email"))
 WHERE "email" <> lower(btrim("email"));
