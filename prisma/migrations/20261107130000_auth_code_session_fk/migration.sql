-- `auth_codes.session_id` becomes a foreign key again.
--
-- The previous migration dropped it so that the statement claiming a code
-- could also write the id of a session that did not exist yet. That turned
-- out to be the bug rather than the fix: a concurrent replay could read the
-- id, find no row to revoke, and the winner would then insert an active
-- session that nothing ever revoked. The window had moved, not closed.
--
-- The session is now created BEFORE the code is claimed, which means this
-- column can only ever name a row that exists. The constraint is what turns
-- that from a convention into a guarantee: write the two in the wrong order
-- again and every redemption fails loudly here, instead of silently leaving a
-- replayed code with nothing to revoke.
--
-- ON DELETE SET NULL, not CASCADE: when the nightly sweep deletes a session,
-- the code's record of having been redeemed must outlive it, or a replayed
-- code would look unused. It also disowns the session for free in the one
-- case that needs it — a redemption that claims the code and then fails on
-- the verifier deletes the session it had speculatively created.

ALTER TABLE "auth_codes"
  ADD CONSTRAINT "auth_codes_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "sessions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
