import jwt from "jsonwebtoken";
import moment from "moment";
import config from "../config/config";
import { tokenTypes } from "../config/token";

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
 * Generate an access token and its expiry time
 * @param userId - The user ID
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
