// This file contains utility functions for user management and basic extra helper function.

import { prisma } from "./prisma-client";

export const isEmailTakenUser = async (
  email: string,
  excludeUserId?: string
) => {
  const user = await prisma.user.findUnique({ where: { email } });
  return user && user.id !== excludeUserId;
};

export const isEmailTakenOrganization = async (
  email: string,
  excludeUserId?: string
) => {
  const org = await prisma.organization.findUnique({ where: { email } });
  return org && org.id !== excludeUserId;
};
