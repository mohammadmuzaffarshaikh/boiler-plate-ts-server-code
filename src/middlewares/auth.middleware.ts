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
    if (err || info || !user) {
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

      const hasRights = requiredRights.every((right) => rights.includes(right));
      if (!hasRights && req.params.userId !== user.id) {
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

export { auth, checkRole, AuthRequest };
