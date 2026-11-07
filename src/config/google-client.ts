import httpStatus from "http-status";
import { OAuth2Client } from "google-auth-library";
import config from "./config";
import logger from "./logger";
import ApiError from "../utils/api-error";

/**
 * The normalised identity we hand back to the rest of the app.
 *
 * Nothing outside this module should need to know Google's claim names, so
 * callers never deal with `sub`, `given_name` or the `email_verified` quirk.
 */
export interface GoogleProfile {
  googleId: string;
  email: string;
  firstName?: string;
  lastName?: string;
}

/**
 * Single shared OAuth2Client, created lazily.
 *
 * The client caches Google's public signing keys (JWKS), so verification is a
 * local signature check rather than a network round-trip per login. Sharing
 * one instance keeps that cache warm.
 */
class GoogleSingleton {
  private static instance: OAuth2Client;

  private constructor() {}

  public static getInstance(): OAuth2Client {
    if (!GoogleSingleton.instance) {
      GoogleSingleton.instance = new OAuth2Client();
    }

    return GoogleSingleton.instance;
  }
}

export const googleClient = GoogleSingleton.getInstance();

/** Google sign-in is opt-in: without a client ID the feature stays disabled. */
export const isGoogleAuthConfigured = (): boolean =>
  Boolean(config.GOOGLE.CLIENT_ID);

/**
 * Verify a Google ID token and return the identity it asserts.
 *
 * `verifyIdToken` checks the signature, `aud`, `exp` and `iss`. It does NOT
 * check `email_verified`, so we assert that here.
 *
 * @param idToken - The raw ID token ("credential") from Google Identity Services
 * @returns The normalised Google profile
 * @throws {ApiError} 501 when Google sign-in is not configured
 * @throws {ApiError} 401 when the token is invalid or the email is unverified
 */
export const verifyGoogleIdToken = async (
  idToken: string
): Promise<GoogleProfile> => {
  if (!isGoogleAuthConfigured()) {
    throw new ApiError(
      httpStatus.NOT_IMPLEMENTED,
      "Google sign-in is not configured."
    );
  }

  const invalidCredential = () =>
    new ApiError(httpStatus.UNAUTHORIZED, "Invalid Google credential");

  let payload;

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: config.GOOGLE.CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (error) {
    // Log the real reason; never leak library internals to the client.
    logger.warn(
      `[AUTH] Google token verification failed: ${(error as Error).message}`
    );
    throw invalidCredential();
  }

  if (!payload) {
    throw invalidCredential();
  }

  // Google documents `email_verified` as a boolean, but the REST tokeninfo
  // shape returns the string "true"; accept both so either source works.
  const emailVerified =
    (payload.email_verified as boolean | string | undefined) === true ||
    (payload.email_verified as boolean | string | undefined) === "true";

  if (!emailVerified) {
    throw new ApiError(
      httpStatus.UNAUTHORIZED,
      "Google email is not verified."
    );
  }

  const email = (payload.email ?? "").toLowerCase();

  // `sub` is the stable identifier: a Google account's email can change,
  // its `sub` cannot.
  if (!payload.sub || !email) {
    throw invalidCredential();
  }

  return {
    googleId: payload.sub,
    email,
    firstName: payload.given_name,
    lastName: payload.family_name,
  };
};
