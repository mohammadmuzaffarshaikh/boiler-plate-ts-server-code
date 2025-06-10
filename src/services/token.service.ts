import httpStatus from "http-status";
import jwt from "jsonwebtoken";
import moment from "moment";
import config from "../config/config";
import { tokenTypes } from "../config/token";
import { prisma } from "../utils/prisma-client";
import ApiError from "../utils/api-error";
import { TokenTypes } from "@prisma/client/default";

// JWT payload shape
interface TokenPayload {
  sub: string; // user ID
  org: string;
  iat: number; // issued at (unix)
  exp: number; // expires at (unix)
  type: string; // token type (e.g. ACCESS)
}

/**
 * Generate a JWT token
 * @param userId - The user ID to encode as `sub`
 * @param orgId - The organization ID to encode as `org`
 * @param expires - Expiry moment object (defaults to 1 hour from now)
 * @param type - Token type (e.g. "ACCESS", "REFRESH")
 * @param secret - Secret key (default = config.jwt.secret)
 * @returns Signed JWT string
 */
export const generateToken = (
  userId: string,
  orgId: string,
  expires: moment.Moment = moment().add(1, "hour"),
  type: string,
  secret: string = config.jwt.secret
): string => {
  const payload: TokenPayload = {
    sub: userId,
    org: orgId,
    iat: moment().unix(),
    exp: expires.unix(),
    type,
  };

  return jwt.sign(payload, secret);
};

/**
 * Save a token to db
 * @param userId - The user ID to encode as `sub`
 * @param orgId - The organization ID to encode as `org`
 * @param expires - Expiry date
 * @param type - Token type (e.g. "REFRESH", "RESET_PASSWORD")
 * @param token - token to store
 * @returns void
 */
export const saveToken = async (
  userId: string,
  token: string,
  expires: Date,
  type: TokenTypes,
  orgId?: string
) => {
  await prisma.token.create({
    data: {
      token,
      expires,
      type,
      user: { connect: { id: userId } },
      ...(orgId && { organization: { connect: { id: orgId } } }),
    },
  });
};

/**
 * Fetch all tokens from db related to user or type or organization
 * @param userId - The user ID to encode as `sub`
 * @param organizationId - The organization ID to encode as `org`
 * @param type - Token type (e.g. "REFRESH", "RESET_PASSWORD")
 * @returns Array of all tokens from db related to user and type
 */
export const getTokens = async (
  userId?: string,
  type?: TokenTypes,
  organizationId?: string
) => {
  return prisma.token.findMany({
    where: {
      ...(userId && { userId }),
      ...(type && { type }),
      ...(organizationId && { organizationId }),
    },
  });
};

/**
 * Generate an access token and its expiry time
 * @param userId - The user ID
 * @param orgId - The organization ID
 * @returns Access token and expiry date
 */
export const generateAuthTokens = async (userId: string, orgId: string) => {
  const accessTokenExpires = moment().add(
    config.jwt.accessExpirationMinutes,
    "minutes"
  );

  const accessToken = generateToken(
    userId,
    orgId,
    accessTokenExpires,
    tokenTypes.ACCESS
  );

  return {
    token: accessToken,
    expires: accessTokenExpires.toDate(),
  };
};

/**
 * Generate an refresh token and its expiry time
 * @param userId - The user ID
 * @param orgId - The organization ID
 * @returns Refresh token and expiry date
 */
export const generateRefreshTokens = async (userId: string, orgId: string) => {
  const refreshTokenExpires = moment().add(
    config.jwt.refreshExpirationMinutes,
    "minutes"
  );

  const refreshToken = generateToken(
    userId,
    orgId,
    refreshTokenExpires,
    tokenTypes.REFRESH
  );

  await saveToken(
    userId,
    refreshToken,
    refreshTokenExpires.toDate(),
    tokenTypes.REFRESH,
    orgId
  );

  return {
    refreshToken,
    refreshExpires: refreshTokenExpires.toDate(),
  };
};

/**
 * Validate stored tokens, don't use this function for access or MFA tokens
 * @param token - The token
 * @param type - The token type
 * @returns token if valid, otherwise throws an error
 */
export const validateStoredToken = async (token: string, type: TokenTypes) => {
  let payload: TokenPayload;

  try {
    payload = jwt.verify(token, config.jwt.secret) as TokenPayload;
  } catch {
    throw new ApiError(httpStatus.UNAUTHORIZED, "Invalid or expired token.");
  }

  const tokens = await getTokens(
    payload.sub.toString(),
    type,
    payload.org?.toString()
  );

  const matchedToken = tokens.find((tk) => tk.token === token);
  if (!matchedToken) {
    throw new ApiError(httpStatus.UNAUTHORIZED, "Invalid or expired token.");
  }

  return matchedToken;
};

/**
 * Delete expired tokens from the database
 * @returns void
 */
export const deleteExpiredTokens = async () => {
  await prisma.token.deleteMany({
    where: {
      expires: { lt: new Date() },
    },
  });
};
