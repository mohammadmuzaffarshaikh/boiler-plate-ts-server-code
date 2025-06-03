import passport from "passport";
import httpStatus from "http-status";
import ApiError from "../utils/api-error";
// import { authService } from "../services";
import { Request, Response, NextFunction } from "express";
import { roleRights } from "../config/role-rights";

// Extend Express Request to include user info
interface AuthRequest extends Request {
  user?: any; // Should ideally match your Prisma User type
  _user?: string; // User ID (UUID string)
  _org?: string;
  role?: string;
}

// Passport verification callback
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

    // Already checked org + user status in jwtVerify

    req.user = user;
    req._user = user.id;
    req._org = user.orgId;
    req.role = user.orgRole;

    if (requiredRights.length) {
      const rights = roleRights.get(user.orgRole); // use orgRole here
      if (!rights) {
        return reject(
          new ApiError(
            httpStatus.FORBIDDEN,
            `Role rights for ${user.orgRole} are undefined.`
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

// Middleware to authenticate using JWT
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

// Middleware for invited user token verification
// const verifyInvitedUserToken =
//   () => async (req: AuthRequest, res: Response, next: NextFunction) => {
//     try {
//       const token = req.headers.authorization?.split("Bearer ")[1];
//       if (!token) {
//         return next(
//           new ApiError(httpStatus.UNAUTHORIZED, "Authorization token is missing")
//         );
//       }
//       const user = await authService.verifyInvitedUser(token);
//       req.user = user;
//       req._user = user.id;
//       next();
//     } catch (error) {
//       next(error);
//     }
//   };

// Role check middleware
const checkRole = (requiredRoles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user || !requiredRoles.includes(req.user.role)) {
      return next(
        new ApiError(httpStatus.FORBIDDEN, "Forbidden: Access denied")
      );
    }
    next();
  };
};

export {
  auth,
  // verifyInvitedUserToken,
  checkRole,
  AuthRequest,
};
