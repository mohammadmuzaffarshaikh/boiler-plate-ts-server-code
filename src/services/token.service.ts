import crypto from "node:crypto";
import httpStatus from "http-status";
import jwt from "jsonwebtoken";
import moment from "moment";
import config from "../config/config";
import { tokenTypes, TokenType, Role } from "../config/constants";
import { prisma } from "../config/prisma-client";
import ApiError from "../utils/api-error";
import { hashToken } from "../utils/hash";
import { TokenTypes } from "@prisma/client";

export interface TokenPayload {
  sub: string;
  role?: Role;
  iat: number;
  exp: number;
  type: TokenType;

  /**
   * The `sessions` row this token belongs to. Present on ACCESS tokens only.
   *
   * This is what makes an access token revocable. Without it the token is a
   * self-contained claim that nothing can withdraw before it expires, so
   * logging out, resetting a password, or revoking every session for a
   * compromised account all had no effect for the rest of the token's
   * lifetime. `config/passport.ts` resolves this claim on every authenticated
   * request and refuses a token whose session is gone, revoked or expired.
   */
  sid?: string;

  /**
   * A nonce, on the token types that are STORED.
   *
   * Without it a token is a pure function of `(sub, type, iat, exp)`, and
   * `iat`/`exp` have one-second resolution — so two tokens minted for the
   * same user inside the same second are byte-identical. `sessions.refresh_token`
   * is a unique index on the digest of that value, which turned a perfectly
   * ordinary event into a 409: signing in from a second device, or a
   * double-submitted login form, failed on a unique constraint. Two reset
   * tokens issued in the same second likewise collapsed into one row.
   */
  jti?: string;
}

const sign = (
  userId: string,
  expires: moment.Moment,
  type: TokenType,
  extra: { role?: Role; sid?: string; jti?: string } = {},
  secret: string = config.JWT.SECRET
): string => {
  const payload: TokenPayload = {
    sub: userId,
    iat: moment().unix(),
    exp: expires.unix(),
    type,
    ...extra,
  };
  return jwt.sign(payload, secret);
};

/**
 * Mint an access token bound to a session.
 *
 * `sessionId` is REQUIRED, and deliberately has no default. It is the only
 * thing that makes the resulting token revocable, so a caller that cannot
 * name a session must not be able to produce a token by omitting it — the
 * compiler is a better place to catch that than a security review is. Both
 * callers already hold the row: `sessionService.issueAuthSession` creates it
 * first, and the refresh path looked it up to get here.
 */
export const generateAccessToken = (
  userId: string,
  role: Role,
  sessionId: string
) => {
  const expires = moment().add(
    config.JWT.ACCESS_EXPIRATION_MINUTES,
    "minutes"
  );
  const token = sign(userId, expires, tokenTypes.ACCESS, {
    role,
    sid: sessionId,
  });
  return { token, expires: expires.toDate() };
};

export const generateRefreshToken = (userId: string) => {
  const expires = moment().add(
    config.JWT.REFRESH_EXPIRATION_MINUTES,
    "minutes"
  );
  // `jti` is what makes two refresh tokens for the same user distinguishable
  // inside one second — see the claim's comment above. It is load-bearing:
  // `sessions.refresh_token` is unique on the digest.
  const token = sign(userId, expires, tokenTypes.REFRESH, {
    jti: crypto.randomUUID(),
  });
  return { token, expires: expires.toDate() };
};

export const generateResetPasswordToken = async (userId: string) => {
  const expires = moment().add(
    config.JWT.RESET_PASSWORD_EXPIRATION_MINUTES,
    "minutes"
  );
  const token = sign(userId, expires, tokenTypes.RESET_PASSWORD, {
    jti: crypto.randomUUID(),
  });

  await prisma.token.create({
    data: {
      // The digest, never the token. The caller gets the real one back to
      // put in the email; the row keeps only something to match it against.
      token: hashToken(token),
      expires: expires.toDate(),
      type: tokenTypes.RESET_PASSWORD,
      user: { connect: { id: userId } },
    },
  });

  return { resetPasswordToken: token, expires: expires.toDate() };
};

export const verifyJwt = (token: string): TokenPayload => {
  try {
    return jwt.verify(token, config.JWT.SECRET) as TokenPayload;
  } catch {
    throw new ApiError(httpStatus.UNAUTHORIZED, "Invalid or expired token.");
  }
};

export const validateStoredToken = async (token: string, type: TokenTypes) => {
  const payload = verifyJwt(token);

  const stored = await prisma.token.findFirst({
    where: { token: hashToken(token), type, userId: payload.sub.toString() },
  });

  if (!stored) {
    throw new ApiError(httpStatus.UNAUTHORIZED, "Invalid or expired token.");
  }

  return stored;
};

export const deleteTokens = async (userId: string, type: TokenTypes) => {
  await prisma.token.deleteMany({ where: { userId, type } });
};

export const deleteToken = async (id: string) => {
  await prisma.token.delete({ where: { id } });
};
