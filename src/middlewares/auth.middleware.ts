import passport from "passport";
import httpStatus from "http-status";
import ApiError from "../utils/api-error";
import { Request, Response, NextFunction } from "express";
import { roleRights, Role } from "../config/constants";

interface AuthRequest extends Request {
  user?: any;
  _user?: string;
  role?: Role;
}

const verifyCallback =
  (
    req: AuthRequest,
    resolve: Function,
    reject: Function,
    requiredRights: string[]
  ) =>
  async (err: any, user: any, info: any) => {
    // `err` is NOT the same thing as a rejected credential, and collapsing
    // the two used to be free: the JWT strategy could not throw, so this
    // branch was unreachable. It can now — `jwtVerify` resolves the token's
    // session against the database — and a Postgres outage answering every
    // request with "Please authenticate." is an incident that reads like a
    // client bug, with nothing in the log to say otherwise. Forwarded intact
    // so `errorConverter` gives it a 500 and `errorHandler` records the
    // stack. Still fails closed: no `req.user` is set either way.
    if (err) {
      return reject(err);
    }

    if (info || !user) {
      return reject(
        new ApiError(httpStatus.UNAUTHORIZED, "Please authenticate.")
      );
    }

    req.user = user;
    req._user = user.id;
    req.role = user.role;

    if (requiredRights.length) {
      const rights = roleRights.get(user.role);
      if (!rights) {
        return reject(
          new ApiError(
            httpStatus.FORBIDDEN,
            `Role rights for ${user.role} are undefined.`
          )
        );
      }

      // Rights are the whole decision. There is deliberately no exemption
      // here for "the caller owns this record" — see `requireSelf` below for
      // why that cannot live in this function.
      const hasRights = requiredRights.every((right) => rights.includes(right));
      if (!hasRights) {
        return reject(new ApiError(httpStatus.FORBIDDEN, "Forbidden"));
      }
    }

    resolve();
  };

const auth =
  (...requiredRights: string[]) =>
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    return new Promise<void>((resolve, reject) => {
      passport.authenticate(
        "jwt",
        { session: false },
        verifyCallback(req, resolve, reject, requiredRights)
      )(req, res, next);
    })
      .then(() => next())
      .catch((err) => next(err));
  };

/**
 * Require that the caller is acting on their own record.
 *
 * This replaces an implicit escape hatch that used to live inside `auth`:
 *
 * ```ts
 * if (!hasRights && req.params.userId !== user.id) { reject(403) }
 * ```
 *
 * That line skipped the rights check entirely whenever a route happened to
 * name its parameter `userId` and the value happened to equal the caller's
 * own id. It was written so a customer could read their own profile without
 * a dedicated right, and on the routes that existed at the time it was
 * harmless. It does not stay harmless:
 *
 *   PATCH /api/staff/:userId/role     → a STAFF could promote itself to ADMIN
 *   PATCH /api/staff/:userId/status   → and reactivate itself after dismissal
 *
 * Neither route exists yet, but `validations/user.validation.ts` already
 * carries `updateUserRole` and `deactivateAndReactivateUser` schemas keyed on
 * `:userId`, waiting to be wired up. A rule that silently grants privilege
 * based on a *parameter name* is invisible at the route definition, which is
 * the one place a reader looks to find out who may call something.
 *
 * So ownership is now opt-in and written where it applies:
 *
 * ```ts
 * router.get("/:userId", auth("read:own_profile"), requireSelf(), handler);
 * ```
 *
 * Both checks must pass: the role must hold the right AND the record must be
 * the caller's. Ownership can only ever narrow access here, never widen it.
 *
 * Mount it after `auth`, which is what populates `req.user`. If it is reached
 * without that, `req.user` is undefined and every request is rejected — the
 * safe direction to fail.
 *
 * @param param - Route parameter holding the user id. Defaults to `userId`.
 */
const requireSelf =
  (param = "userId") =>
  (req: AuthRequest, res: Response, next: NextFunction): void => {
    const callerId = req.user?.id;
    const target = req.params[param];

    if (!callerId || !target || target !== callerId) {
      return next(new ApiError(httpStatus.FORBIDDEN, "Forbidden"));
    }

    next();
  };

const checkRole = (requiredRoles: Role[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user || !requiredRoles.includes(req.user.role)) {
      return next(
        new ApiError(httpStatus.FORBIDDEN, "Forbidden: Access denied")
      );
    }
    next();
  };
};

export { auth, checkRole, requireSelf, AuthRequest };
