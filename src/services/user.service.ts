import httpStatus from "http-status";
import { prisma } from "../utils/prisma-client";
import ApiError from "../utils/api-error";
import { hashString } from "../utils/hash"; 
import { isEmailTaken } from "../utils/helpers";
import { User } from "@prisma/client";

export const createUser = async (userBody: User): Promise<User> => {
  if (await isEmailTaken(userBody.email!)) {
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

export const getUserById = async (id: string): Promise<User | null> => {
  return prisma.user.findUnique({
    where: { id },
  });
};

export const getUserByEmail = async (email: string): Promise<User | null> => {
  return prisma.user.findUnique({
    where: { email },
  });
};

/** Update user by id */
export const updateUserById = async (
  userId: string,
  updateBody: Partial<User>
): Promise<User> => {
  const user = await getUserById(userId);
  if (!user) throw new ApiError(httpStatus.NOT_FOUND, "User not found.");

  if (updateBody.email && (await isEmailTaken(updateBody.email, userId))) {
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

/** Delete user by id */
export const deleteUserById = async (userId: string): Promise<User> => {
  return await prisma.user.delete({ where: { id: userId } });
};
