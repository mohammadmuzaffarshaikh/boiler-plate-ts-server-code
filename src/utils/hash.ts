import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import config from "../config/config";

/**
 * Hash a password.
 *
 * The work factor comes from `BCRYPT_ROUNDS` (default 12, floor 10) rather
 * than being written here. It used to be a hard-coded 8 — roughly 2016-era,
 * and 16x cheaper to attack than 12 — which is the kind of number that is
 * only ever revisited if it is somewhere a reader looks.
 *
 * NOTE ON THE LIBRARY. This is `bcryptjs`, a pure-JavaScript implementation,
 * so a given cost is several times slower here than the same cost in a native
 * bcrypt — while an attacker cracking offline uses an optimised native or GPU
 * implementation and pays none of that overhead. Our slowness therefore buys
 * no extra resistance; it is paid on every login for nothing. Swapping to a
 * native binding, or to argon2id, is recorded as open in docs/decisions.md.
 *
 * @param text - The plain text to hash
 * @param saltRounds - Override the configured work factor. For tests and
 *                     migration tooling; application code should not pass it.
 */
export const hashString = async (
  text: string,
  saltRounds: number = config.AUTH.BCRYPT_ROUNDS
): Promise<string> => {
  return await bcrypt.hash(text, saltRounds);
};

/**
 * Whether a stored hash was produced with a weaker work factor than the one
 * configured now.
 *
 * A bcrypt string carries its own cost (`$2b$08$...`), so raising
 * `BCRYPT_ROUNDS` does not invalidate existing hashes — and does not improve
 * them either. Every account that existed before the change keeps its old
 * cost forever unless something rehashes it, which is why raising the number
 * on its own is a change that looks like a fix and is not one.
 *
 * `auth.service` calls this after a successful password comparison, which is
 * the only moment the plaintext is in hand to rehash from.
 *
 * Returns false for anything unparseable. A corrupt row is a problem for
 * `compareHash` to fail on, not something to rewrite on the strength of a
 * guess.
 */
export const needsRehash = (hash: string): boolean => {
  // `$2b$12$<22-char salt><31-char digest>` — field 3 is the cost, zero-padded.
  const match = /^\$2[aby]\$(\d{2})\$/.exec(hash);
  if (!match) return false;

  return Number(match[1]) < config.AUTH.BCRYPT_ROUNDS;
};

/**
 * Compare a plain string with a hashed string
 * @param {string} text - The raw string to verify
 * @param {string} hash - The hashed string to compare against
 * @returns {Promise<boolean>}
 */
export const compareHash = async (
  text: string,
  hash: string
): Promise<boolean> => {
  return await bcrypt.compare(text, hash);
};

/**
 * Fingerprint a token for storage, so the database never holds a usable
 * credential.
 *
 * Reset JWTs and refresh tokens used to be written verbatim. Anything that
 * yields a read of those rows — a leaked backup, a verbose query log, a
 * screenshot of Prisma Studio, a future SQL injection — then hands over
 * working reset links and refresh tokens for every user, with no signing key
 * required. Storing a digest makes a stolen row inert.
 *
 * SHA-256 and NOT bcrypt, deliberately. bcrypt is the right answer for
 * passwords because they are low-entropy and guessable, and its cost is what
 * makes guessing expensive. These are 200+ character signed JWTs: there is
 * nothing to guess, so the only property needed is a fast, deterministic,
 * one-way mapping. It has to be deterministic because both lookups are exact
 * matches on an indexed column (`token`, `refreshToken`) — a per-row salt
 * would force a full table scan and bcrypt-compare of every row.
 */
export const hashToken = (token: string): string =>
  crypto.createHash("sha256").update(token).digest("hex");
