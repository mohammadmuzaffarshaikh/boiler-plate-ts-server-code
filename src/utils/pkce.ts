import crypto from "node:crypto";

/**
 * PKCE (RFC 7636), S256 only.
 *
 * The client invents a high-entropy `code_verifier` BEFORE it logs in, sends
 * only `base64url(sha256(verifier))` with the login, and must produce the
 * verifier to redeem the authorization code it gets back. An intercepted code
 * is then useless on its own — whoever holds it cannot produce the preimage.
 *
 * PKCE was designed for mobile apps whose redirect went through a custom URL
 * scheme any other app on the device could register. The exposure here is
 * different but the same shape: the code travels in a response body, through
 * whatever HTTP stack the native client uses, and must survive being seen.
 *
 * **What PKCE does not do.** It is not a defence against an attacker running
 * code *inside* the legitimate client, because such an attacker has the
 * verifier too. That case is handled upstream instead: a browser login is
 * never issued a code at all (docs/decisions.md §28), so there is nothing in
 * the page for an XSS to take.
 */

/** RFC 7636 §4.1: 43–128 characters of the unreserved set. */
const MIN_VERIFIER_LENGTH = 43;
const MAX_VERIFIER_LENGTH = 128;

/**
 * `[A-Z] / [a-z] / [0-9] / "-" / "." / "_" / "~"` — ALPHA, DIGIT and the four
 * unreserved punctuation characters, exactly as the RFC lists them.
 *
 * Anchored `^...$` and deliberately WITHOUT the `m` flag, which is the part
 * to keep. Without `m`, JavaScript's `$` matches only at the very end of the
 * input, so `"abc\n"` is refused. Adding `m` would make `^` and `$` match at
 * every line boundary and a verifier with an embedded newline would pass.
 *
 * (A note for anyone porting this, because an earlier version of this comment
 * had it backwards: it is Python and Perl whose `$` matches *before* a
 * trailing newline by default. JavaScript's does not.)
 */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]+$/;

/** base64url: the base64 alphabet with `-_` for `+/`, and no `=` padding. */
const CHALLENGE_PATTERN = /^[A-Za-z0-9\-_]+$/;

/** `sha256` as base64url is always 43 characters: ceil(32 bytes / 3) * 4 - 1. */
const S256_CHALLENGE_LENGTH = 43;

/**
 * Whether a string is a well-formed challenge for the S256 method.
 *
 * Checked at login rather than only at redemption, so a client that is
 * sending something unusable finds out while it still has a password in hand
 * — not a minute later holding a code it can never redeem.
 */
export const isValidCodeChallenge = (challenge: string): boolean =>
  challenge.length === S256_CHALLENGE_LENGTH &&
  CHALLENGE_PATTERN.test(challenge);

/**
 * Whether a verifier is well-formed per RFC 7636 §4.1.
 *
 * The length floor is the security property, not a formality: 43 base64url
 * characters is 256 bits of entropy if the client generated them properly,
 * and a shorter verifier is one a code-holder could search.
 */
export const isValidCodeVerifier = (verifier: string): boolean =>
  verifier.length >= MIN_VERIFIER_LENGTH &&
  verifier.length <= MAX_VERIFIER_LENGTH &&
  VERIFIER_PATTERN.test(verifier);

/** `base64url(sha256(verifier))`, the S256 transformation of RFC 7636 §4.2. */
export const deriveCodeChallenge = (verifier: string): string =>
  crypto.createHash("sha256").update(verifier, "ascii").digest("base64url");

/**
 * Whether `verifier` is the preimage of `challenge`.
 *
 * Compared with `timingSafeEqual`, not `===`. The challenge is not a secret —
 * it is published at login — so a timing leak here is far less interesting
 * than one on a password. It is constant-time anyway because the cost of
 * being wrong about that is total, the cost of being right is nothing, and
 * the next person to copy this function will not re-derive the argument.
 *
 * `timingSafeEqual` throws on a length mismatch rather than returning false,
 * so the lengths are compared first. That comparison is not constant-time and
 * does not need to be: the length of a sha256 digest is a constant.
 *
 * A malformed verifier is rejected before any of that, so the function cannot
 * be used to confirm a challenge against a one-character string.
 */
export const verifyCodeChallenge = (
  verifier: string,
  challenge: string
): boolean => {
  if (!isValidCodeVerifier(verifier)) return false;

  const expected = Buffer.from(deriveCodeChallenge(verifier), "utf8");
  const actual = Buffer.from(challenge, "utf8");

  if (expected.length !== actual.length) return false;

  return crypto.timingSafeEqual(expected, actual);
};

/**
 * A verifier, for a client that has no PKCE library to hand.
 *
 * Not used by the server — it exists for the specs and for the documentation
 * example, so that neither invents its own and quietly gets the alphabet
 * wrong. 32 random bytes as base64url is 43 characters, which is the RFC's
 * floor and 256 bits of entropy.
 */
export const generateCodeVerifier = (): string =>
  crypto.randomBytes(32).toString("base64url");
