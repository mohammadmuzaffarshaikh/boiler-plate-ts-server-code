import httpStatus from "http-status";
import jwt from "jsonwebtoken";
import moment from "moment";
import config from "../config/config";
import { tokenTypes, TokenType, Role } from "../config/constants";
import { prisma } from "../utils/prisma-client";
import ApiError from "../utils/api-error";
import { TokenTypes } from "@prisma/client";

export interface TokenPayload {
  sub: string;
  role?: Role;
  iat: number;
  exp: number;
  type: TokenType;
}

const sign = (
  userId: string,
  expires: moment.Moment,
  type: TokenType,
  extra: { role?: Role } = {},
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

export const generateAccessToken = (userId: string, role: Role) => {
  const expires = moment().add(
    config.JWT.ACCESS_EXPIRATION_MINUTES,
    "minutes"
  );
  const token = sign(userId, expires, tokenTypes.ACCESS, { role });
  return { token, expires: expires.toDate() };
};

export const generateRefreshToken = (userId: string) => {
  const expires = moment().add(
    config.JWT.REFRESH_EXPIRATION_MINUTES,
    "minutes"
  );
  const token = sign(userId, expires, tokenTypes.REFRESH);
  return { token, expires: expires.toDate() };
};

export const generateResetPasswordToken = async (userId: string) => {
  const expires = moment().add(
    config.JWT.RESET_PASSWORD_EXPIRATION_MINUTES,
    "minutes"
  );
  const token = sign(userId, expires, tokenTypes.RESET_PASSWORD);

  await prisma.token.create({
    data: {
      token,
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
    where: { token, type, userId: payload.sub.toString() },
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
