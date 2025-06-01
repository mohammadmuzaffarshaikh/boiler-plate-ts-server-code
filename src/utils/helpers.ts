// This file contains utility functions for user management and basic extra helper function.

import { prisma } from "./prisma-client";

export const isEmailTaken = async (email: string, excludeUserId?: string) => {
  const user = await prisma.user.findUnique({ where: { email } });
  return user && user.id !== excludeUserId;
};
