import httpStatus from "http-status";
import catchAsync from "../utils/catch-async";
import pick from "../utils/pick";
import { Request, Response } from "express";
import {
  authService,
  userService,
  tokenService,
  organizationService,
  userOrganizationService,
} from "../services";
import logger from "../config/logger";
import { getCookieOptions } from "../config/cookies-option";
import { tokenTypes } from "../config/token";
import ApiError from "../utils/api-error";

/**
 * Controllers for user registration and login.
 * Handles user registration, login with email and password,
 * and validation of incoming refresh tokens.
 */

const register = catchAsync(async (req: Request, res: Response) => {
  const { firstName, lastName, email } = req.body;
  const organization = await organizationService.createOrganization({
    name: `${firstName} ${lastName}'s Organization`,
    email,
    colorTheme: "zinc",
    status: "ACTIVE",
  });

  let user;
  try {
    user = await userService.getUserByEmail(email);

    if (!user) {
      user = await userService.createUser(req.body);

      await userOrganizationService.addUserOrganization({
        userId: user.id,
        organizationId: organization.id,
        isPrimary: true,
        status: "ACTIVE",
        role: "OWNER",
      });
    } else {
      await userOrganizationService.addUserOrganization({
        userId: user.id,
        organizationId: organization.id,
        isPrimary: false,
        status: "ACTIVE",
        role: "OWNER",
      });
    }
  } catch (error: any) {
    await organizationService.deleteOrganization(organization.id);
    logger.error(
      `Something went wrong while registering user. Error: ${error.message}`
    );
  }

  res.status(httpStatus.CREATED).send({
    status: "success",
    message:
      "Your registration was successful. You may now log in to access the application.",
    data: {
      user: pick(user, ["id", "email", "firstName", "lastName"]),
    },
  });
});

const loginUserWithEmailAndPassword = catchAsync(
  async (req: Request, res: Response) => {
    const user = await authService.loginUserWithEmailAndPassword(
      req.body?.email || "",
      req.body?.password
    );

    const { token, expires } = await tokenService.generateAuthTokens(
      user.id,
      user?.organizations[0].organization.id
    );

    const { refreshToken, refreshExpires } =
      await tokenService.generateRefreshTokens(
        user.id,
        user?.organizations[0].organization.id
      );

    const cookieOptions = getCookieOptions(refreshExpires);

    res.cookie("refreshTk", refreshToken, cookieOptions);

    res.status(httpStatus.OK).send({
      status: "success",
      message: "Login successful. Welcome back!",
      data: {
        user: pick(user, ["id", "email", "firstName", "lastName"]),
        token,
        expires,
        refreshToken, // For mobile applications
      },
    });
  }
);

const handleRefreshToken = catchAsync(async (req: Request, res: Response) => {
  const refreshTk = req.cookies.refreshTk || req.body.refreshTk; // Check for refresh token in cookies (web apps) or body (mobile apps)
  if (!refreshTk) {
    res.status(httpStatus.UNAUTHORIZED).send({
      status: "error",
      message: "Refresh token is missing.",
    });
  }

  const token = await tokenService.validateStoredToken(
    refreshTk,
    tokenTypes.REFRESH
  );

  if (token.expires < new Date()) {
    const cookieOptions = getCookieOptions();
    res.cookie("refreshTk", "", cookieOptions);

    throw new ApiError(httpStatus.UNAUTHORIZED, "Refresh token has expired.");
  }

  const user = await userService.getUserById(token.userId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, "User not found.");
  }

  const { token: accessToken, expires } = await tokenService.generateAuthTokens(
    user.id,
    token.organizationId || user.organizations[0].organization.id
  );

  res.status(httpStatus.OK).send({
    status: "success",
    message: "Refresh token is valid.",
    data: {
      user: pick(user, ["id", "email", "firstName", "lastName"]),
      token: accessToken,
      expires,
    },
  });
});

export { register, loginUserWithEmailAndPassword, handleRefreshToken };
