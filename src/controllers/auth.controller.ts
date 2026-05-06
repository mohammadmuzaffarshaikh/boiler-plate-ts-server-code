import httpStatus from "http-status";
import catchAsync from "../utils/catch-async";
import pick from "../utils/pick";
import { Request, Response } from "express";
import {
  authService,
  userService,
  tokenService,
  sessionService,
} from "../services";
import {
  getCookieOptions,
  COOKIE_NAMES,
} from "../config/cookies-option";
import { tokenTypes } from "../config/constants";
import ApiError from "../utils/api-error";
import config from "../config/config";

const setAuthCookies = (
  res: Response,
  tokens: {
    access: { token: string; expires: Date };
    refresh: { token: string; expires: Date };
  }
) => {
  res.cookie(
    COOKIE_NAMES.access,
    tokens.access.token,
    getCookieOptions(tokens.access.expires)
  );
  res.cookie(
    COOKIE_NAMES.refresh,
    tokens.refresh.token,
    getCookieOptions(tokens.refresh.expires)
  );
};

const clearAuthCookies = (res: Response) => {
  const options = getCookieOptions();
  res.clearCookie(COOKIE_NAMES.access, options);
  res.clearCookie(COOKIE_NAMES.refresh, options);
};

const register = catchAsync(async (req: Request, res: Response) => {
  const existing = await userService.getUserByEmail(req.body.email);
  if (existing) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "User already exists with this email"
    );
  }

  const user = await userService.createUser(req.body);

  res.status(httpStatus.CREATED).send({
    status: "success",
    message:
      "Your registration was successful. You may now log in to access the application.",
    data: {
      user: pick(user, ["id", "email", "firstName", "lastName", "role"]),
    },
  });
});

const loginUserWithEmailAndPassword = catchAsync(
  async (req: Request, res: Response) => {
    const user = await authService.loginUserWithEmailAndPassword(
      req.body?.email || "",
      req.body?.password
    );

    const access = tokenService.generateAccessToken(user.id, user.role);
    const refresh = tokenService.generateRefreshToken(user.id);

    const ctx = sessionService.captureRequestContext(req);
    await sessionService.createSession({
      userId: user.id,
      refreshToken: refresh.token,
      expiresAt: refresh.expires,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      deviceInfo: ctx.deviceInfo,
    });

    setAuthCookies(res, { access, refresh });

    res.status(httpStatus.OK).send({
      status: "success",
      message: "Login successful. Welcome back!",
      data: {
        user: pick(user, ["id", "email", "firstName", "lastName", "role"]),
        token: access.token,
        expires: access.expires,
      },
    });
  }
);

const forgotPassword = catchAsync(async (req: Request, res: Response) => {
  const user = await userService.getUserByEmail(req.body.email);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, "User not found.");
  }

  const { resetPasswordToken, expires } =
    await tokenService.generateResetPasswordToken(user.id);

  const resetPasswordLink = `${config.SITE_URL}/reset-password?token=${resetPasswordToken}`;

  res.status(httpStatus.OK).send({
    status: "success",
    message: `Password reset link sent to your email if the user exists. Link will expire in ${expires.getHours()} hours.`,
    data: {
      resetPasswordLink,
      expires,
    },
  });
});

const resetPassword = catchAsync(async (req: Request, res: Response) => {
  const { token } = req.query;
  const { password } = req.body;

  const resetToken = await tokenService.validateStoredToken(
    token?.toString() || "",
    tokenTypes.RESET_PASSWORD
  );

  if (resetToken.expires < new Date()) {
    throw new ApiError(httpStatus.UNAUTHORIZED, "Reset token has expired.");
  }

  const user = await userService.getUserById(resetToken.userId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, "User not found.");
  }

  await userService.updateUserById(user.id, { password });
  await tokenService.deleteTokens(user.id, tokenTypes.RESET_PASSWORD);
  await sessionService.revokeAllForUser(user.id);

  res.status(httpStatus.OK).send({
    status: "success",
    message: "Password has been reset successfully.",
  });
});

const handleRefreshToken = catchAsync(async (req: Request, res: Response) => {
  const refreshTk =
    req.cookies?.[COOKIE_NAMES.refresh] || req.body?.refreshToken;
  if (!refreshTk) {
    throw new ApiError(httpStatus.UNAUTHORIZED, "Refresh token is missing.");
  }

  const session = await sessionService.findActiveByRefreshToken(refreshTk);
  if (!session || !session.isActive || session.expiresAt < new Date()) {
    clearAuthCookies(res);
    throw new ApiError(
      httpStatus.UNAUTHORIZED,
      "Session expired. Please log in again."
    );
  }

  const payload = tokenService.verifyJwt(refreshTk);
  if (payload.type !== tokenTypes.REFRESH) {
    throw new ApiError(httpStatus.UNAUTHORIZED, "Invalid token type.");
  }

  const user = await userService.getUserById(session.userId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, "User not found.");
  }

  const access = tokenService.generateAccessToken(user.id, user.role);
  res.cookie(
    COOKIE_NAMES.access,
    access.token,
    getCookieOptions(access.expires)
  );

  await sessionService.touchLastActivity(session.id);

  res.status(httpStatus.OK).send({
    status: "success",
    message: "Refresh token is valid.",
    data: {
      user: pick(user, ["id", "email", "firstName", "lastName", "role"]),
      token: access.token,
      expires: access.expires,
    },
  });
});

const logout = catchAsync(async (req: Request, res: Response) => {
  const refreshTk =
    req.cookies?.[COOKIE_NAMES.refresh] || req.body?.refreshToken;
  if (refreshTk) {
    await sessionService.revokeSession(refreshTk);
  }
  clearAuthCookies(res);

  res.status(httpStatus.OK).send({
    status: "success",
    message: "Logged out successfully.",
  });
});

const self = catchAsync(async (req: Request, res: Response) => {
  const user = (req as Request & { user?: { id: string } }).user;
  if (!user?.id) {
    throw new ApiError(httpStatus.UNAUTHORIZED, "Please authenticate.");
  }
  const fresh = await userService.getUserById(user.id);
  if (!fresh) {
    throw new ApiError(httpStatus.NOT_FOUND, "User not found.");
  }
  res.status(httpStatus.OK).send({
    status: "success",
    data: {
      user: pick(fresh, ["id", "email", "firstName", "lastName", "role"]),
    },
  });
});

export {
  register,
  loginUserWithEmailAndPassword,
  forgotPassword,
  resetPassword,
  handleRefreshToken,
  logout,
  self,
};
