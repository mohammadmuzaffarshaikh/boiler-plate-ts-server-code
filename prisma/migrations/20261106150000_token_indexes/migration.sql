-- Index the `tokens` table, which had nothing but its primary key.
--
-- All three queries that touch it were sequential scans, and all three get
-- slower with every row ever written:
--
--   * `validateStoredToken`  — findFirst on `token`, on every password reset
--   * `deleteTokens(userId, type)` — on every completed reset
--   * the nightly `expires < now` sweep — on the whole table
--
-- `sessions` already carries the equivalent indexes; this is `tokens` catching
-- up with it.

-- `token` is UNIQUE rather than merely indexed. The column holds a sha256
-- digest of a signed JWT, so two rows with the same digest are two rows
-- describing the same credential, and `validateStoredToken` would have had to
-- pick one of them arbitrarily.
--
-- That is only safe because every stored token now carries a random `jti`
-- (docs/decisions.md §20). Before that, a token was a pure function of
-- (sub, type, iat, exp) with whole-second resolution, so two resets requested
-- for one account inside the same second produced byte-identical tokens — and
-- this constraint would have turned the second one into a 500.
--
-- Any such pair already in the table is a duplicate of exactly that kind.
-- Keep one row per digest and drop the rest: they are indistinguishable as
-- credentials, so nothing is lost that was not already ambiguous, and a reset
-- token that goes missing costs its owner one more click on "forgot password".
DELETE FROM "tokens" a
      USING "tokens" b
      WHERE a."token" = b."token"
        AND a.ctid < b.ctid;

CREATE UNIQUE INDEX "tokens_token_key" ON "tokens"("token");

CREATE INDEX "tokens_user_id_type_idx" ON "tokens"("user_id", "type");

CREATE INDEX "tokens_expires_idx" ON "tokens"("expires");
