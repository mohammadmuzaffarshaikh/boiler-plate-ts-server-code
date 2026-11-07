-- Single-use authorization codes, traded for bearer tokens by native clients.
--
-- `/auth/login` returned the access and refresh tokens in the JSON body as
-- well as setting them as httpOnly cookies. The body copy hands any XSS in
-- the admin SPA both credentials directly — the flag protects the cookie and
-- the same secret is printed beside it where JavaScript can read it.
--
-- The body copy existed for clients with no cookie jar, so the two cases are
-- now separated: a browser login sets cookies and gets no tokens, and a
-- native login gets one of these codes and trades it at
-- `POST /api/app/auth/token-exchange`. docs/decisions.md §28.
--
-- This is a new table rather than new columns on `tokens`. That table holds
-- credentials mailed to a person — a reset link, a verification link — which
-- are long-lived, delivered out of band, and carry no PKCE challenge, no
-- consumption record and no session reference. Sharing it would mean four
-- columns that are null for every row but one `type`.

CREATE TABLE "auth_codes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    -- sha256 digest, never the code. Same rule as `sessions.refresh_token`
    -- and `tokens.token`: a leaked row must not be a usable credential.
    "code" TEXT NOT NULL,
    -- base64url(sha256(verifier)). S256 only; `plain` is not accepted,
    -- because it makes the challenge and the verifier the same string.
    "code_challenge" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    -- Set by a conditional update, which is the single-use guarantee.
    "consumed_at" TIMESTAMP(3),
    -- The session minted from this code. Lets a replay revoke what the first
    -- redemption produced, rather than leaving it running.
    "session_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_codes_pkey" PRIMARY KEY ("id")
);

-- Two rows holding one digest would be one code with two lifecycles.
CREATE UNIQUE INDEX "auth_codes_code_key" ON "auth_codes"("code");

CREATE INDEX "auth_codes_user_id_idx" ON "auth_codes"("user_id");

-- The expiry sweep. A row is written on every native login and is dead within
-- a minute, so this is the highest-churn table in the schema.
CREATE INDEX "auth_codes_expires_at_idx" ON "auth_codes"("expires_at");

ALTER TABLE "auth_codes"
  ADD CONSTRAINT "auth_codes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL, not CASCADE. When the nightly sweep deletes a session, this row's
-- record of having been redeemed has to outlive it — a row that vanished with
-- its session would let a replayed code look unused.
ALTER TABLE "auth_codes"
  ADD CONSTRAINT "auth_codes_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "sessions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
