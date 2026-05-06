import httpStatus from "http-status";
import { prisma } from "../utils/prisma-client";
import ApiError from "../utils/api-error";
import { hashString } from "../utils/hash";
import { isEmailTakenUser } from "../utils/helpers";
import { User } from "@prisma/client";

export const createUser = async (userBody: User): Promise<User> => {
  if (await isEmailTakenUser(userBody.email!)) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "User already exists with this email"
    );
  }

  const hashedPassword = await hashString(userBody.password!);
  const user = await prisma.user.create({
    data: { ...userBody, password: hashedPassword },
  });

  return user;
};

export const getUserById = async (id: string) => {
  return prisma.user.findUnique({ where: { id } });
};

export const getUserByEmail = async (email: string) => {
  return prisma.user.findUnique({ where: { email } });
};

export const updateUserById = async (
  userId: string,
  updateBody: Partial<User>
): Promise<User> => {
  const user = await getUserById(userId);
  if (!user) throw new ApiError(httpStatus.NOT_FOUND, "User not found.");

  if (updateBody.email && (await isEmailTakenUser(updateBody.email, userId))) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "User already exists with this email"
    );
  }

  if (updateBody.password) {
    updateBody.password = await hashString(updateBody.password);
  }

  return prisma.user.update({
    where: { id: userId },
    data: updateBody,
  });
};

export const deleteUserById = async (userId: string): Promise<User> => {
  return prisma.user.delete({ where: { id: userId } });
};
