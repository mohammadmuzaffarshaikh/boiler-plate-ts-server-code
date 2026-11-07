import crypto from "node:crypto";
import { AuthCode } from "@prisma/client";
import config from "../config/config";
import { prisma } from "../config/prisma-client";
import { hashToken } from "../utils/hash";
import { verifyCodeChallenge } from "../utils/pkce";

/**
 * Single-use authorization codes for the native login handshake.
 *
 * `/auth/login` no longer returns bearer tokens in its body — see
 * docs/decisions.md §28. A native client logs in with a PKCE challenge, gets
 * one of these back, and trades it at `/auth/token-exchange` for an access
 * and refresh token. A browser login gets cookies and no code at all.
 */

/**
 * 32 bytes of CSPRNG as base64url — 256 bits, in 43 characters.
 *
 * Opaque, not a JWT. There is nothing for a client to read in it and nothing
 * for a server to trust without the database row, which is the point: a code
 * is only ever meaningful next to the row that records whether it has already
 * been used. A signed, self-describing code would be usable by anyone who
 * held it, which is exactly the property being removed.
 */
const generateCode = (): string => crypto.randomBytes(32).toString("base64url");

/**
 * Mint a code for a user who has just proved their identity.
 *
 * The row stores the digest, never the code — the same rule as
 * `sessions.refresh_token` and `tokens.token`.
 *
 * NO SESSION IS CREATED HERE. The session is minted at redemption, so a code
 * that is never redeemed leaves nothing behind but a row the sweep collects.
 * It also means the session's recorded IP, user agent and device come from
 * the request that will actually use it, rather than from the login.
 *
 * @param userId - The user the code authenticates
 * @param codeChallenge - base64url(sha256(verifier)), already format-checked
 * @returns The raw code, and when it expires
 */
export const issueAuthCode = async (
  userId: string,
  codeChallenge: string
): Promise<{ code: string; expiresAt: Date }> => {
  const code = generateCode();
  const expiresAt = new Date(
    Date.now() + config.AUTH.CODE_EXPIRATION_SECONDS * 1000
  );

  await prisma.authCode.create({
    data: {
      userId,
      code: hashToken(code),
      codeChallenge,
      expiresAt,
    },
  });

  return { code, expiresAt };
};

/** Why a redemption was refused. The caller decides what each one costs. */
export type AuthCodeFailure =
  /** No row for this digest, or it has expired. Indistinguishable on purpose. */
  | "invalid"
  /**
   * The row exists and has already been redeemed — whether or not it is also
   * past its expiry. A replay, and the one failure the caller must act on.
   */
  | "replayed"
  /** The row exists and is unused, but the verifier is not the preimage. */
  | "mismatch";

export type AuthCodeResult =
  | { ok: true; authCode: AuthCode }
  | { ok: false; reason: AuthCodeFailure; authCode?: AuthCode };

/**
 * Find a code and settle the cases that need no claim.
 *
 * Split from the claim because the caller has to create the session BEFORE
 * claiming — see `claimAuthCode` — and it cannot do that without knowing
 * which user the code belongs to.
 *
 * CONSUMED IS TESTED BEFORE EXPIRED, and that order is the whole reason
 * redeemed rows are kept past their expiry at all. Testing expiry first threw
 * the mechanism away: a code redeemed by an attacker at t+2s and presented by
 * the real client at t+70s — one mobile handoff, one cold app resume, one
 * retry backoff — came back "invalid", the caller's replay branch never ran,
 * and the session the attacker had just been given ran its full term. An
 * attacker is under no obligation to be punctual, and a late replay is the
 * one most worth catching. The detection window therefore runs until the
 * nightly sweep collects the row, not until the code expires.
 *
 * Expiry is checked here rather than in the `where` so that an expired row
 * can still be told apart from one that never existed in the logs — while the
 * caller is handed the same opaque "invalid" for both.
 */
export const findRedeemableCode = async (
  code: string
): Promise<AuthCodeResult> => {
  const existing = await prisma.authCode.findUnique({
    where: { code: hashToken(code) },
  });

  if (!existing) {
    return { ok: false, reason: "invalid" };
  }

  if (existing.consumedAt) {
    return { ok: false, reason: "replayed", authCode: existing };
  }

  if (existing.expiresAt <= new Date()) {
    return { ok: false, reason: "invalid" };
  }

  return { ok: true, authCode: existing };
};

/**
 * Claim a code, atomically, exactly once, for a session that already exists.
 *
 * THE SINGLE-USE GUARANTEE IS THE `updateMany` BELOW, and it is the reason
 * this is not written as read-then-check-then-write. Two requests arriving
 * together would both read `consumedAt: null`, both decide the code was
 * unused, and both mint a session. `updateMany` with `consumedAt: null` in
 * the `where` makes the database settle it: the condition and the write are
 * one statement, so exactly one caller sees `count === 1` and the other sees
 * zero. No transaction, no row lock held across application code.
 *
 * WHY THE SESSION MUST ALREADY EXIST. The loser of a race revokes the session
 * the winner produced, and to do that it has to find a row. Two earlier
 * versions could not guarantee one:
 *
 *   1. `sessionId` written by a follow-up UPDATE after the session INSERT —
 *      a loser landing between the two read `null` and revoked nothing.
 *   2. `sessionId` written by this claim, but with the session still created
 *      afterwards — a loser then read the right id and revoked nothing,
 *      because the row it named had not been inserted yet. The window moved;
 *      it did not close. Measured at roughly one redemption in twelve.
 *
 * Creating the session first closes it for good. A loser's `updateMany` waits
 * on the winner's row lock, so by the time it sees zero the winner's claim has
 * committed — and the winner's claim came after the winner's session INSERT.
 * The id it then reads always names a live row.
 *
 * `auth_codes.session_id` is a foreign key, so this is enforced rather than
 * merely intended: put the INSERT back after the claim and every redemption
 * fails here, loudly, instead of leaving one replay in twelve with nothing to
 * revoke. That is the whole reason the constraint was restored.
 *
 * The cost is a session created before the code is known to be good. The
 * caller deletes it on every failure below; nothing is ever handed out for it.
 *
 * Order of operations matters too. The code is claimed BEFORE the verifier is
 * checked, so a wrong verifier burns the code rather than leaving it for the
 * next guess. That is deliberate: an attacker who holds the code but not the
 * verifier gets one attempt, not unlimited ones. The cost is that a client
 * with a verifier bug has to log in again, which is the correct direction to
 * be wrong in.
 *
 * @param authCode - The row from `findRedeemableCode`
 * @param verifier - The PKCE verifier the caller presented
 * @param sessionId - An ALREADY CREATED session row, per the note above
 */
export const claimAuthCode = async (
  authCode: AuthCode,
  verifier: string,
  sessionId: string
): Promise<AuthCodeResult> => {
  const { count } = await prisma.authCode.updateMany({
    where: { id: authCode.id, consumedAt: null },
    data: { consumedAt: new Date(), sessionId },
  });

  if (count !== 1) {
    // `authCode` was read before the claim, so its `sessionId` is stale here
    // by definition. Re-read to get what the winner committed.
    const latest = await prisma.authCode.findUnique({
      where: { id: authCode.id },
    });

    return { ok: false, reason: "replayed", authCode: latest ?? authCode };
  }

  if (!verifyCodeChallenge(verifier, authCode.codeChallenge)) {
    // The code stays burned — that is the point of claiming first — but it
    // disowns the session, which the caller is about to delete. Leaving the
    // id behind would make `session_id` name a row that does not exist, and
    // the next replay would report revoking a session that was never real.
    await prisma.authCode.updateMany({
      where: { id: authCode.id },
      data: { sessionId: null },
    });

    return { ok: false, reason: "mismatch", authCode };
  }

  return { ok: true, authCode };
};

/**
 * Drop codes that are past their expiry.
 *
 * Highest-churn table in the schema: a row per native login, dead within a
 * minute. Redeemed rows are swept on the same schedule rather than
 * immediately — a consumed row is what makes a replay detectable, and it has
 * to outlive the code's own validity window to do that job.
 */
export const deleteExpiredAuthCodes = async (): Promise<number> => {
  const { count } = await prisma.authCode.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });

  return count;
};
