import httpStatus from "http-status";
import { OAuth2Client } from "google-auth-library";
import config from "../config/config";
import ApiError from "../utils/api-error";
import { compareHash } from "../utils/hash";
import * as userService from "./user.service";
import { User } from "@prisma/client";

export const loginUserWithEmailAndPassword = async (
  email: string,
  password: string
) => {
  const user = await userService.getUserByEmail(email);

  const isValid = user && (await compareHash(password, user.password));

  if (!isValid) {
    throw new ApiError(
      httpStatus.UNAUTHORIZED,
      "The email or password you entered is incorrect. Please try again."
    );
  }

  return user;
};

/**
 * Login with Google OAuth token
 * @param idToken - Google ID token
 * @returns Promise<User>
 */
export const loginWithGoogle = async (idToken: string): Promise<User> => {
  const oAuth2Client = new OAuth2Client(config.socialLogin.google.clientId);
  const ticket = await oAuth2Client.verifyIdToken({
    idToken,
    audience: config.socialLogin.google.clientId,
  });

  const payload = ticket.getPayload();
  const email = payload?.email;
  const email_verified = payload?.email_verified;

  if (!email || !email_verified) {
    throw new ApiError(httpStatus.UNAUTHORIZED, "Google authentication failed");
  }

  const user = await userService.getUserByEmail(email);
  if (!user) {
    throw new ApiError(httpStatus.UNAUTHORIZED, "This user does not exist");
  }

  return user;
};
