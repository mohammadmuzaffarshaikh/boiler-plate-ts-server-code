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
// Imported as a module, not through `services/index.ts`. The barrel also
// pulls in `auth.service` and with it the Google client, which this file has
// no business loading — and would make the import graph circular.
import * as sessionService from "../services/session.service";

interface JwtPayloadExtended extends JwtPayload {
  sub: string;
  type: TokenType;
  role?: Role;
  sid?: string;
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

/**
 * Resolve an access token to `req.user`.
 *
 * THIS READS THE DATABASE, exactly once, and that is a deliberate reversal of
 * what docs/decisions.md §5 used to say. The signature alone is not enough:
 * a signed JWT is a claim nobody can withdraw, so until the token expired,
 * logging out, resetting a password and revoking every session for a
 * compromised account were all no-ops. `POST /auth/logout` flipped
 * `sessions.is_active` and returned 200 while the same bearer token kept
 * working on every route for the rest of its 30 minutes.
 *
 * The binding is the `sid` claim minted in `token.service.generateAccessToken`
 * and looked up here. One primary-key probe per authenticated request buys
 * revocation that takes effect immediately; §5 records the trade in full.
 *
 * Three ways to fail, and all of them fail CLOSED:
 *
 *   - wrong token type — a refresh or reset token presented as an access one
 *   - no `sid` — a token minted before this existed, or by a code path that
 *     found a way not to bind one. Rejected rather than waved through,
 *     because "unbound" and "unrevocable" are the same thing. Tokens issued
 *     before this change stop working at deploy; they were unrevocable, so
 *     that is the point rather than a cost.
 *   - the session is gone, revoked, expired, or belongs to a different user
 *
 * `role` still comes from the token, not from this lookup. A role change
 * therefore still waits out the access-token lifetime — narrower than what
 * §5 used to describe, and recorded there.
 */
const jwtVerify = async (
  payload: JwtPayloadExtended,
  done: (error: any, user?: any, info?: any) => void
) => {
  try {
    if (payload.type !== tokenTypes.ACCESS) {
      return done(null, false, { message: "Invalid token type" });
    }

    if (!payload.sid) {
      return done(null, false, { message: "Token is not bound to a session" });
    }

    const session = await sessionService.findActiveSessionById(payload.sid);

    // The `userId` comparison is not redundant with the lookup. It pins the
    // token's subject to the session's owner, so a token can never be
    // accepted on the strength of somebody else's live session — and it is
    // what keeps `req.user.id` and the revocation check talking about the
    // same person.
    if (!session || session.userId !== payload.sub) {
      return done(null, false, { message: "Session is no longer valid" });
    }

    return done(null, {
      id: payload.sub,
      role: payload.role,
      sessionId: session.id,
    });
  } catch (error) {
    // A database failure must not read as a valid token. Passed as the
    // `error` argument rather than as `done(null, false)` so that
    // `verifyCallback` can tell "this credential is no good" apart from "we
    // could not find out" — the second is a 500 with a stack in the log, not
    // a 401 inviting the client to retry with the same token forever.
    return done(error, false);
  }
};

const jwtStrategy = new JwtStrategy(jwtOptions, jwtVerify);

export { jwtStrategy };
