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
  org: string; // Organization ID
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
) => {
  try {
    if (payload.type !== tokenTypes.ACCESS) {
      return done(null, false, { message: "Invalid token type" });
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        organizations: {
          where: { organizationId: payload.org },
          include: {
            organization: true,
          },
        },
      },
    });

    if (!user) {
      return done(null, false, { message: "User not found" });
    }

    const userOrg = user.organizations[0];

    if (!userOrg) {
      return done(null, false, { message: "User has no organization." });
    }

    const org = userOrg.organization;

    if (userOrg.status !== "ACTIVE" || org.status !== "ACTIVE") {
      return done(null, false, { message: "User or Organization is inactive" });
    }

    // Attach org context to user
    const userWithContext = {
      ...user,
      orgId: org.id,
      orgRole: userOrg.role,
      orgStatus: org.status,
    };

    return done(null, userWithContext);
  } catch (error) {
    return done(error, false);
  }
};

// Create the strategy instance
const jwtStrategy = new JwtStrategy(jwtOptions, jwtVerify);

export { jwtStrategy };
