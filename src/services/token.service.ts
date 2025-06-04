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
  if (type === tokenTypes.INVITE_USER) {
    if (!orgId) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `For inviting user organization Id is required`
      );
    }
    await prisma.token.create({
      data: {
        token,
        expires,
        user: { connect: { id: userId } },
        type: tokenTypes.INVITE_USER,
        organization: { connect: { id: orgId } },
      },
    });
  } else {
    await prisma.token.create({
      data: {
        token,
        expires,
        user: { connect: { id: userId } },
        type,
      },
    });
  }
};

/**
 * Fetch all tokens from db related to user and type
 * @param userId - The user ID to encode as `sub`
 * @param organizationId - The organization ID to encode as `org`
 * @param type - Token type (e.g. "REFRESH", "RESET_PASSWORD")
 * @returns Array of all tokens from db related to user and type
 */
export const getTokens = async (
  userId: string,
  type: TokenTypes,
  organizationId?: string
) => {
  if (organizationId && type === tokenTypes.INVITE_USER) {
    return prisma.token.findMany({
      where: {
        userId,
        type,
        organizationId,
      },
    });
  } else {
    return prisma.token.findMany({
      where: {
        userId,
        type,
      },
    });
  }
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
    tokenTypes.REFRESH
  );

  return {
    refreshToken,
    refreshExpires: refreshTokenExpires.toDate(),
  };
};

/**
 * Validate tokens for MFA don't use this one
 * @param token - The token
 * @param type - The token type
 * @returns Refresh token and expiry date
 */
export const validateTokens = async (token: string, type: string) => {
  let payload;
  try {
    payload = jwt.verify(token, config.jwt.secret) as TokenPayload;
  } catch (err) {
    throw new ApiError(httpStatus.UNAUTHORIZED, "Invalid or expired token.");
  }

  if (type === tokenTypes.REFRESH || type === tokenTypes.RESET_PASSWORD) {
    const tokens = await getTokens(payload.sub?.toString(), type);
    const matchedToken = tokens.find((tk) => tk.token === token);
    if (!matchedToken) {
      throw new ApiError(
        httpStatus.UNAUTHORIZED,
        "Unauthorized access: Token not found."
      );
    }
    const now = new Date();

    return { expired: matchedToken.expires < now, matchedToken };
  } else if (type === tokenTypes.INVITE_USER) {
    const tokens = await getTokens(
      payload.sub?.toString() || "",
      type,
      payload.org.toString()
    );
    const matchedToken = tokens.find((tk) => tk.token === token);
    if (!matchedToken) {
      throw new ApiError(
        httpStatus.UNAUTHORIZED,
        "Unauthorized access: Token not found."
      );
    }
    const now = new Date();

    return { expired: matchedToken.expires < now, matchedToken };
  }
};
