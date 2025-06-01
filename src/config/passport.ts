import {
  Strategy as JwtStrategy,
  ExtractJwt,
  StrategyOptions,
} from "passport-jwt";
import { JwtPayload } from "jsonwebtoken";
import config from "./config";
import { tokenTypes } from "./token";
import { prisma } from "../utils/prisma-client";

// Define the extended JWT payload interface
interface JwtPayloadExtended extends JwtPayload {
  sub: string; // User ID
  type: string;
}

// JWT strategy options
const jwtOptions: StrategyOptions = {
  secretOrKey: config.jwt.secret,
  jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
};

// JWT verification function
const jwtVerify = async (
  payload: JwtPayloadExtended,
  done: (error: any, user?: any, info?: any) => void
): Promise<void> => {
  try {
    if (payload.type !== tokenTypes.ACCESS) {
      return done(null, false, { message: "Invalid token type" });
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
    });

    // Check if user exists and is active
    if (!user || user.status === "INACTIVE") {
      return done(null, false, { message: "User not found or inactive" });
    }

    // Return the user
    return done(null, user);
  } catch (error) {
    return done(error, false);
  }
};

// Create the strategy instance
const jwtStrategy = new JwtStrategy(jwtOptions, jwtVerify);

export { jwtStrategy };
