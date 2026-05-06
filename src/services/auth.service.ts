import httpStatus from "http-status";
import { User } from "@prisma/client";
import config from "../config/config";
import ApiError from "../utils/api-error";
import { compareHash } from "../utils/hash";
import { prisma } from "../utils/prisma-client";
import * as userService from "./user.service";

const minutesUntil = (date: Date) =>
  Math.max(1, Math.ceil((date.getTime() - Date.now()) / 60000));

export const loginUserWithEmailAndPassword = async (
  email: string,
  password: string
): Promise<User> => {
  const user = await userService.getUserByEmail(email);

  if (!user) {
    throw new ApiError(
      httpStatus.UNAUTHORIZED,
      "The email or password you entered is incorrect. Please try again."
    );
  }

  if (user.lockUntil && user.lockUntil > new Date()) {
    throw new ApiError(
      httpStatus.TOO_MANY_REQUESTS,
      `Account is locked. Try again in ${minutesUntil(user.lockUntil)} minute(s).`
    );
  }

  const isValid = await compareHash(password, user.password);

  if (!isValid) {
    const nextAttempts = user.loginAttempts + 1;
    const shouldLock = nextAttempts >= config.AUTH.MAX_LOGIN_ATTEMPTS;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        loginAttempts: nextAttempts,
        lockUntil: shouldLock
          ? new Date(Date.now() + config.AUTH.LOCK_TIME_MINUTES * 60 * 1000)
          : user.lockUntil,
      },
    });

    if (shouldLock) {
      throw new ApiError(
        httpStatus.TOO_MANY_REQUESTS,
        `Too many failed attempts. Account locked for ${config.AUTH.LOCK_TIME_MINUTES} minutes.`
      );
    }

    throw new ApiError(
      httpStatus.UNAUTHORIZED,
      "The email or password you entered is incorrect. Please try again."
    );
  }

  if (user.loginAttempts > 0 || user.lockUntil) {
    await prisma.user.update({
      where: { id: user.id },
      data: { loginAttempts: 0, lockUntil: null },
    });
  }

  return user;
};
