import httpStatus from "http-status";
import { User } from "@prisma/client";
import config from "../config/config";
import { GoogleProfile, verifyGoogleIdToken } from "../config/google-client";
import { prisma } from "../config/prisma-client";
import ApiError from "../utils/api-error";
import { compareHash, hashString, needsRehash } from "../utils/hash";
import { meetsEmailVerificationPolicy } from "../utils/email-verification";
import * as userService from "./user.service";

const minutesUntil = (date: Date) =>
  Math.max(1, Math.ceil((date.getTime() - Date.now()) / 60000));

/**
 * Reject a login against a locked account.
 *
 * Shared by every login path so a lockout earned by password guessing cannot
 * be sidestepped by signing in another way.
 */
const assertAccountNotLocked = (user: User): void => {
  if (user.lockUntil && user.lockUntil > new Date()) {
    throw new ApiError(
      httpStatus.TOO_MANY_REQUESTS,
      `Account is locked. Try again in ${minutesUntil(user.lockUntil)} minute(s).`
    );
  }
};

/**
 * Refuse a login from an account that has not proven its mailbox.
 *
 * Gated on `AUTH_REQUIRE_EMAIL_VERIFICATION`, which is OFF by default.
 * Nothing sends a verification email yet, so switching it on today would
 * lock out every account with no way to get back in. The wiring exists, and
 * is tested, so the flag is the only thing standing between here and the
 * control that `config/constants`, `user.prisma` and `prisma/seed.ts` all
 * describe. ADMIN is exempt by policy — see `isEmailVerificationRequired`.
 *
 * 403 rather than 401: the credentials were correct. Re-sending them will
 * not help, which is exactly what 401 would invite a client to do.
 */
const assertEmailVerificationPolicy = (user: User): void => {
  if (!config.AUTH.REQUIRE_EMAIL_VERIFICATION) return;
  if (meetsEmailVerificationPolicy(user)) return;

  throw new ApiError(
    httpStatus.FORBIDDEN,
    "Please verify your email address before signing in.",
  );
};

/**
 * Re-hash a password that was stored under a weaker work factor.
 *
 * Raising `BCRYPT_ROUNDS` does nothing to the rows that already exist — a
 * bcrypt string carries its own cost, so an account created when the factor
 * was 8 keeps cost 8 for life. A successful login is the only moment the
 * plaintext is in hand, so it is the only moment the upgrade can happen.
 *
 * Deliberately best-effort. The caller has already proven the password; if
 * the rewrite fails (a lost connection, a row deleted underneath us) the
 * login must still succeed, and the next login will try again. Letting this
 * throw would turn an optimisation into an outage.
 */
const upgradePasswordHash = async (user: User, password: string): Promise<void> => {
  if (!needsRehash(user.password)) return;

  try {
    await prisma.user.update({
      where: { id: user.id },
      data: { password: await hashString(password) },
    });
  } catch {
    // Next login retries. Nothing the caller can act on.
  }
};

/**
 * Every check that decides whether an account may hold a live session,
 * independent of how it proved itself.
 *
 * Exists because `POST /auth/refresh` did none of them. It looked up the
 * session, looked up the user, and minted a new access token — so an account
 * locked by brute-force protection went on issuing access tokens from a
 * refresh token it already held, for the refresh token's full seven days.
 * The lockout stopped the front door and left the side one open.
 *
 * The two login paths still call the primitives directly rather than this,
 * because they need the lock check BEFORE the password comparison (so a
 * locked account is refused without a bcrypt round) and the verification
 * check after. Refresh has no such ordering, so it takes both at once.
 */
export const assertAccountMayAuthenticate = (user: User): void => {
  assertAccountNotLocked(user);
  assertEmailVerificationPolicy(user);
};

/** Clear a pending lockout counter after a successful login. No-op if clean. */
const clearLoginAttempts = async (user: User): Promise<User> => {
  if (user.loginAttempts === 0 && !user.lockUntil && !user.lastFailedLoginAt) {
    return user;
  }

  return prisma.user.update({
    where: { id: user.id },
    data: { loginAttempts: 0, lockUntil: null, lastFailedLoginAt: null },
  });
};

/**
 * Resolve the local account behind a verified Google identity.
 *
 * Matches on `googleId` first, falling back to email so an account that
 * registered with a password can link on its first Google sign-in.
 *
 * Accounts are never created here — an unknown email is rejected.
 */
const resolveGoogleUser = async (profile: GoogleProfile): Promise<User> => {
  const linked = await userService.getUserByGoogleId(profile.googleId);

  if (linked) {
    return linked;
  }

  const byEmail = await userService.getUserByEmail(profile.email);

  if (!byEmail) {
    throw new ApiError(
      httpStatus.FORBIDDEN,
      `No account found for ${profile.email}. Please register first.`
    );
  }

  // First Google sign-in for an existing account — link it.
  return userService.linkGoogleId(byEmail.id, profile.googleId);
};

/**
 * Authenticate a user from a Google ID token.
 *
 * Mirrors `loginUserWithEmailAndPassword`: returns the User row and leaves
 * token issuance, session creation and cookies to the caller.
 *
 * @param idToken - The raw ID token from Google Identity Services
 * @returns The authenticated user
 */
export const loginUserWithGoogle = async (idToken: string): Promise<User> => {
  const profile = await verifyGoogleIdToken(idToken);
  const user = await resolveGoogleUser(profile);

  assertAccountNotLocked(user);

  const active = await clearLoginAttempts(user);

  // Google has asserted the mailbox — `verifyGoogleIdToken` throws outright
  // when `email_verified` is false, so reaching here is itself the proof the
  // schema's `emailVerifiedAt` comment describes. Stamped on every Google
  // login rather than only on first link, so accounts linked before this
  // existed get backfilled on their next sign-in instead of staying
  // permanently unverified.
  const verified = await userService.markEmailVerified(active);

  // Reached only after `verifyGoogleIdToken` accepted `email_verified`, and
  // after the stamp above, so this always passes. Applied anyway so every
  // login path goes through the same gate and a future provider that does
  // not assert verification cannot quietly skip it.
  assertEmailVerificationPolicy(verified);

  return verified;
};

export const loginUserWithEmailAndPassword = async (
  email: string,
  password: string
): Promise<User> => {
  const user = await userService.getUserByEmail(email);

  if (!user) {
    throw new ApiError(
      httpStatus.UNAUTHORIZED,
      "The email or password you entered is incorrect. Please try again."
    );
  }

  assertAccountNotLocked(user);

  const isValid = await compareHash(password, user.password);

  if (!isValid) {
    // A SLIDING WINDOW, not a lifetime total.
    //
    // The counter used to accumulate forever: only a successful login ever
    // reset it. That produced two bugs. Ten typos spread over a year locked
    // the account; and once an account had been locked the counter stayed
    // at the maximum, so the first wrong password after the lock expired
    // re-locked it immediately — permanently, with no way out but a
    // successful login the lockout itself prevented.
    //
    // The window is LOCK_TIME_MINUTES, the same span as the penalty, which
    // makes the post-lock reset automatic: by the time a lock expires its
    // window has expired too, so the count starts again from zero.
    const windowMs = config.AUTH.LOCK_TIME_MINUTES * 60 * 1000;
    const now = new Date();
    const windowStart = new Date(now.getTime() - windowMs);

    // COUNTED IN THE DATABASE, NOT IN THIS PROCESS.
    //
    // This used to read `user.loginAttempts` off the row fetched above and
    // write back `value + 1`. N wrong passwords arriving together all read
    // the same value and all write the same `value + 1`, so the counter
    // advanced by one instead of by N. An attacker firing fifty guesses per
    // round burned a single attempt per round and never reached
    // MAX_LOGIN_ATTEMPTS — the lockout was effectively disabled for exactly
    // the parallel, automated attack it exists to stop.
    //
    // Two statements, both of which let Postgres do the arithmetic:
    //
    // 1. Reset to 1 if the previous failure is outside the window. The
    //    predicate is part of the UPDATE, so under a concurrent write
    //    Postgres re-evaluates it against the committed row rather than the
    //    one this process read. The second caller therefore sees a fresh
    //    `lastFailedLoginAt`, matches nothing, and falls through to (2).
    //
    // 2. Otherwise `increment`, which is `login_attempts = login_attempts + 1`
    //    in SQL and cannot lose a write however many callers race.
    const reset = await prisma.user.updateMany({
      where: {
        id: user.id,
        OR: [
          { lastFailedLoginAt: null },
          { lastFailedLoginAt: { lt: windowStart } },
        ],
      },
      data: {
        loginAttempts: 1,
        lastFailedLoginAt: now,
        // `null`, not `user.lockUntil`. Reaching here means no lock is in
        // force — `assertAccountNotLocked` threw otherwise — so any value
        // still sitting in the column is an expired one worth clearing.
        lockUntil: null,
      },
    });

    let nextAttempts = 1;

    if (reset.count === 0) {
      const incremented = await prisma.user.update({
        where: { id: user.id },
        data: {
          loginAttempts: { increment: 1 },
          lastFailedLoginAt: now,
          lockUntil: null,
        },
        select: { loginAttempts: true },
      });
      nextAttempts = incremented.loginAttempts;
    }

    const shouldLock = nextAttempts >= config.AUTH.MAX_LOGIN_ATTEMPTS;

    // Applied as its own write, because the count it depends on is only
    // known after the database has done the counting. Two racing callers
    // that both cross the threshold both set a lock, which is the same
    // outcome as one of them doing it.
    if (shouldLock) {
      await prisma.user.update({
        where: { id: user.id },
        data: { lockUntil: new Date(Date.now() + windowMs) },
      });
    }

    if (shouldLock) {
      throw new ApiError(
        httpStatus.TOO_MANY_REQUESTS,
        `Too many failed attempts. Account locked for ${config.AUTH.LOCK_TIME_MINUTES} minutes.`
      );
    }

    throw new ApiError(
      httpStatus.UNAUTHORIZED,
      "The email or password you entered is incorrect. Please try again."
    );
  }

  assertEmailVerificationPolicy(user);

  // After the gates, not before: an account that is not allowed in should
  // not have its row written to as a side effect of a refused login.
  await upgradePasswordHash(user, password);

  return clearLoginAttempts(user);
};
