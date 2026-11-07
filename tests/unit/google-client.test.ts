import httpStatus from "http-status";
import { TokenPayload } from "google-auth-library";
import config from "../../src/config/config";
import {
  isGoogleAuthConfigured,
  verifyGoogleIdToken,
} from "../../src/config/google-client";
import ApiError from "../../src/utils/api-error";
import {
  googlePayload,
  googleRejects,
  googleReturns,
  spyOnGoogleVerify,
} from "../helpers/google";

/**
 * What this API is willing to accept as proof of a Google identity.
 *
 * No network and no database. `verifyIdToken` does the signature, `aud`,
 * `iss` and `exp` checks inside google-auth-library against cached JWKS, so
 * there is nothing useful for us to re-test there — mocking it leaves exactly
 * the decisions this module owns, which are the ones that have historically
 * been got wrong elsewhere:
 *
 *   - `email_verified` is NOT checked by `verifyIdToken`. An unverified
 *     Google address that we trust is account takeover by anyone who can
 *     register that address with Google.
 *   - `sub`, not `email`, is the identity. An email can be changed and
 *     reassigned; `sub` cannot.
 *
 * `restoreMocks: true` in jest.config.ts tears every spy down before each
 * test, so each one installs its own.
 */

/** Shorthand for the shared builders, so the specs below read as prose. */
const payloadFor = (overrides: Partial<TokenPayload> = {}): TokenPayload =>
  googlePayload(overrides);
const mockVerify = googleReturns;
const mockVerifyRejects = googleRejects;

/** The ApiError a call rejected with, or a failure if it did not reject. */
const errorFrom = async (promise: Promise<unknown>): Promise<ApiError> => {
  try {
    await promise;
    throw new Error("expected the call to reject, but it resolved");
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }
};

/** The status an ApiError rejection carried, for terse assertions. */
const statusOf = async (promise: Promise<unknown>): Promise<number> =>
  (await errorFrom(promise)).statusCode;

describe("isGoogleAuthConfigured", () => {
  it("is true when a client ID is present", () => {
    expect(isGoogleAuthConfigured()).toBe(true);
  });
});

describe("verifyGoogleIdToken", () => {
  describe("when Google sign-in is not configured", () => {
    // `config` is a plain object, so the switch can be flipped directly.
    // Spying on `isGoogleAuthConfigured` would not work: the module calls its
    // own local binding, not the export, so a spy on the export is never
    // reached.
    const CLIENT_ID = config.GOOGLE.CLIENT_ID;
    beforeEach(() => {
      config.GOOGLE.CLIENT_ID = undefined;
    });
    afterEach(() => {
      config.GOOGLE.CLIENT_ID = CLIENT_ID;
    });

    it("answers 501 rather than attempting verification", async () => {
      const verify = spyOnGoogleVerify();

      expect(await statusOf(verifyGoogleIdToken("any-token"))).toBe(
        httpStatus.NOT_IMPLEMENTED,
      );
      // 501 is "this server does not implement it", which is the truth —
      // and it must be decided before any work, so an unconfigured
      // deployment cannot be used to probe Google on someone's behalf.
      expect(verify).not.toHaveBeenCalled();
    });
  });

  describe("a well-formed, verified identity", () => {
    it("returns the normalised profile", async () => {
      mockVerify(payloadFor());

      await expect(verifyGoogleIdToken("good-token")).resolves.toEqual({
        googleId: "109876543210987654321",
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
      });
    });

    it("verifies against our own client ID as the audience", async () => {
      // Without `audience`, a token minted for an entirely different Google
      // application would verify here: the signature is Google's either way.
      // This is the check that makes the token ours.
      const verify = mockVerify(payloadFor());

      await verifyGoogleIdToken("good-token");

      expect(verify).toHaveBeenCalledWith({
        idToken: "good-token",
        audience: config.GOOGLE.CLIENT_ID,
      });
    });

    it("lowercases the email", async () => {
      // `getUserByEmail` is an exact-match lookup on a unique column, so a
      // mixed-case address from Google would miss the row it belongs to and
      // be reported as "no account found".
      mockVerify(payloadFor({ email: "Ada@Example.COM" }));

      const profile = await verifyGoogleIdToken("good-token");
      expect(profile.email).toBe("ada@example.com");
    });

    it("tolerates a missing name", async () => {
      // `given_name` and `family_name` are optional claims — a Google
      // account can have neither, and that is not a reason to refuse a login.
      mockVerify(
        payloadFor({ given_name: undefined, family_name: undefined }),
      );

      const profile = await verifyGoogleIdToken("good-token");
      expect(profile.firstName).toBeUndefined();
      expect(profile.lastName).toBeUndefined();
      expect(profile.googleId).toBe("109876543210987654321");
    });
  });

  describe("email_verified", () => {
    it("accepts the string \"true\" as well as the boolean", async () => {
      // Google documents a boolean, but the REST tokeninfo shape returns the
      // string. Treating "true" as falsy would reject every login arriving
      // that way; treating "false" as truthy would accept unverified ones.
      mockVerify(
        payloadFor({ email_verified: "true" as unknown as boolean }),
      );

      await expect(verifyGoogleIdToken("good-token")).resolves.toMatchObject({
        email: "ada@example.com",
      });
    });

    it.each([
      ["false (boolean)", false as unknown],
      ['"false" (string)', "false" as unknown],
      ["absent", undefined as unknown],
    ])("refuses an unverified address — %s", async (_label, value) => {
      // THE CHECK THIS MODULE EXISTS FOR. `verifyIdToken` does not do it.
      // An unverified address is one anybody can claim, and
      // `resolveGoogleUser` matches an existing account by email.
      mockVerify(payloadFor({ email_verified: value as boolean }));

      expect(await statusOf(verifyGoogleIdToken("good-token"))).toBe(
        httpStatus.UNAUTHORIZED,
      );
    });
  });

  describe("a payload we cannot use", () => {
    it("refuses a token with no subject", async () => {
      // `sub` is the only stable identifier. Without it there is nothing to
      // store in `googleId`, and the account would be keyed on email alone.
      mockVerify(payloadFor({ sub: undefined as unknown as string }));

      expect(await statusOf(verifyGoogleIdToken("good-token"))).toBe(
        httpStatus.UNAUTHORIZED,
      );
    });

    it("refuses a token with no email", async () => {
      mockVerify(payloadFor({ email: undefined }));

      expect(await statusOf(verifyGoogleIdToken("good-token"))).toBe(
        httpStatus.UNAUTHORIZED,
      );
    });

    it("refuses an empty payload", async () => {
      mockVerify(undefined);

      expect(await statusOf(verifyGoogleIdToken("good-token"))).toBe(
        httpStatus.UNAUTHORIZED,
      );
    });
  });

  describe("when the library rejects the token", () => {
    it("answers 401", async () => {
      mockVerifyRejects("Token used too late, 1699999999 > 1699999000");

      expect(await statusOf(verifyGoogleIdToken("expired-token"))).toBe(
        httpStatus.UNAUTHORIZED,
      );
    });

    it("never puts the library's message in the client-facing error", async () => {
      // google-auth-library is specific about *why* a token failed —
      // expired, wrong audience, bad signature. That distinction tells a
      // prober which of their guesses was closest, so it belongs in the log
      // (the module warns with it) and not in the response.
      mockVerifyRejects("Wrong recipient, payload audience != requiredAudience");

      await expect(verifyGoogleIdToken("foreign-token")).rejects.toMatchObject({
        statusCode: httpStatus.UNAUTHORIZED,
        message: "Invalid Google credential",
      });
    });

    it("gives the same message for an expired and a forged token", async () => {
      mockVerifyRejects("Token used too late");
      const expired = await errorFrom(verifyGoogleIdToken("a"));

      jest.restoreAllMocks();
      mockVerifyRejects("Invalid token signature");
      const forged = await errorFrom(verifyGoogleIdToken("b"));

      expect(expired.message).toBe(forged.message);
      expect(expired.statusCode).toBe(forged.statusCode);
    });
  });
});
