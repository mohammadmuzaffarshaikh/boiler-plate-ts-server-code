import {
  Strategy as JwtStrategy,
  ExtractJwt,
  StrategyOptions,
  JwtFromRequestFunction,
} from "passport-jwt";
import { JwtPayload } from "jsonwebtoken";
import { Request } from "express";
import config from "./config";
import { tokenTypes, TokenType, Role } from "./constants";
import { COOKIE_NAMES } from "./cookies-option";

interface JwtPayloadExtended extends JwtPayload {
  sub: string;
  type: TokenType;
  role?: Role;
}

const cookieExtractor: JwtFromRequestFunction = (req: Request) => {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  return cookies?.[COOKIE_NAMES.access] ?? null;
};

const jwtOptions: StrategyOptions = {
  secretOrKey: config.JWT.SECRET,
  jwtFromRequest: ExtractJwt.fromExtractors([
    ExtractJwt.fromAuthHeaderAsBearerToken(),
    cookieExtractor,
  ]),
};

const jwtVerify = async (
  payload: JwtPayloadExtended,
  done: (error: any, user?: any, info?: any) => void
) => {
  try {
    if (payload.type !== tokenTypes.ACCESS) {
      return done(null, false, { message: "Invalid token type" });
    }
    return done(null, { id: payload.sub, role: payload.role });
  } catch (error) {
    return done(error, false);
  }
};

const jwtStrategy = new JwtStrategy(jwtOptions, jwtVerify);

export { jwtStrategy };
