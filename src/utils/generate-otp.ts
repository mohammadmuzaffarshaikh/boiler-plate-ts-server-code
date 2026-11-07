import crypto from "node:crypto";
import moment, { Moment } from "moment";

/** Inclusive bounds of a six-digit code. */
const MIN = 100_000;
const MAX = 999_999;

/**
 * A one-time code and the moment it stops being valid.
 *
 * `crypto.randomInt`, NOT `Math.random()`.
 *
 * `Math.random()` is a non-cryptographic PRNG. V8 implements it with
 * xorshift128+ and generates values in batches of 64, so an attacker who
 * observes a handful of outputs can solve for the internal state and then
 * predict every code the process will produce afterwards — and, because the
 * batch is pre-computed, the ones it produced just before. For a code that
 * authorises a password reset or proves a mailbox, "predictable" and
 * "forgeable" are the same word. This was never exploitable here because
 * nothing calls this yet; it is fixed precisely because nothing calls it
 * yet, since this repo's job is to be copied into modules that will.
 *
 * `crypto.randomInt(min, max)` draws from the same CSPRNG as
 * `crypto.randomBytes` and is uniform over `[min, max)` — it rejects and
 * re-draws rather than taking a modulus, which is where the bias in
 * hand-rolled versions comes from.
 *
 * The code is returned as a `number`, which is what the column and the
 * existing specs expect. That rules out a leading zero by construction: the
 * range starts at 100000, so every code is six digits and `String(otp)` is
 * never short. A fixed-width input would otherwise reject a valid code.
 *
 * @param expiry - Minutes until the code expires. Defaults to 10.
 */
const generateOtp = (
  expiry: number = 10
): { otp: number; otpExpires: Moment } => {
  // `randomInt` is exclusive at the top, so MAX + 1 keeps 999999 reachable.
  const otp = crypto.randomInt(MIN, MAX + 1);
  const otpExpires = moment().add(expiry, "minutes");

  return { otp, otpExpires };
};

export default generateOtp;
