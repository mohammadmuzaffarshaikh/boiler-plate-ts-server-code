import httpStatus from "http-status";
import { prisma } from "../utils/prisma-client";
import ApiError from "../utils/api-error";
import { UserOrganization, OrgUserStatus, OrgUserRole } from "@prisma/client";

type CreateUserOrganization = {
  userId: string;
  organizationId: string;
  isPrimary: boolean;
  status: OrgUserStatus;
  role: OrgUserRole;
};

export const addUserOrganization = async (userBody: CreateUserOrganization) => {
  const userOrganization = await prisma.userOrganization.create({
    data: userBody,
  });

  return userOrganization;
};

export const deleteUserOrganization = async (
  organizationId: string,
  userId?: string
) => {
  if (userId) {
    // delete one using composite key
    return await prisma.userOrganization.delete({
      where: {
        userId_organizationId: {
          userId,
          organizationId,
        },
      },
    });
  } else {
    // delete all matching org ID
    return await prisma.userOrganization.deleteMany({
      where: {
        organizationId,
      },
    });
  }
};
