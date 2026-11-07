import { LoginTicket, TokenPayload } from "google-auth-library";
import { googleClient } from "../../src/config/google-client";

/**
 * Standing in for Google.
 *
 * `googleClient` is one shared `OAuth2Client` instance (see the singleton in
 * `src/config/google-client.ts`), and `verifyGoogleIdToken` calls the method
 * on that same object — so patching the property here is seen by the code
 * under test. No request leaves the machine and no real credential is needed.
 *
 * NOTE: `jest.config.ts` sets `restoreMocks: true`, which runs
 * `restoreAllMocks()` before **every** test. A spy installed in `beforeAll`
 * is therefore gone by the time the first test body runs. Install these per
 * test, or in `beforeEach`.
 */

/**
 * `verifyIdToken` is overloaded — a promise form and a callback form — and
 * jest resolves the overload to the callback one, leaving `mockResolvedValue`
 * typed `never`. Narrowing the spy to the promise form once, here, is what
 * keeps that cast out of every spec.
 */
export type GoogleVerifySpy = jest.SpyInstance<
  Promise<LoginTicket>,
  [{ idToken: string; audience?: string }]
>;

/** A bare spy, for asserting on the call without stubbing a result. */
export const spyOnGoogleVerify = (): GoogleVerifySpy =>
  jest.spyOn(googleClient, "verifyIdToken") as unknown as GoogleVerifySpy;

/** Verification succeeds, returning this payload (or none at all). */
export const googleReturns = (
  payload: TokenPayload | undefined,
): GoogleVerifySpy =>
  spyOnGoogleVerify().mockResolvedValue({
    getPayload: () => payload,
  } as LoginTicket);

/** Verification fails the way an expired, forged or foreign token does. */
export const googleRejects = (message: string): GoogleVerifySpy =>
  spyOnGoogleVerify().mockRejectedValue(new Error(message));

/**
 * A payload shaped like Google's, carrying only the claims this API reads.
 *
 * Verified by default: the unverified case is a deliberate override, so a
 * spec that forgets to think about `email_verified` gets the safe shape
 * rather than accidentally testing the dangerous one.
 */
export const googlePayload = (
  overrides: Partial<TokenPayload> = {},
): TokenPayload =>
  ({
    sub: "109876543210987654321",
    email: "ada@example.com",
    email_verified: true,
    given_name: "Ada",
    family_name: "Lovelace",
    ...overrides,
  }) as TokenPayload;
