import httpStatus from "http-status";
import { prisma } from "../utils/prisma-client";
import ApiError from "../utils/api-error";
import { isEmailTakenOrganization } from "../utils/helpers";
import { Organization, OrganizationStatus } from "@prisma/client";
import { deleteUserOrganization } from "./user-organization.service";

type CreateOrganization = {
  name: string;
  email?: string;
  colorTheme?: string;
  status: OrganizationStatus;
};

export const createOrganization = async (
  orgBody: CreateOrganization
): Promise<Organization> => {
  if (await isEmailTakenOrganization(orgBody.email!)) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "Organization already exists with this email. Please login."
    );
  }

  const organization = await prisma.organization.create({
    data: orgBody,
  });

  return organization;
};

export const deleteOrganization = async (orgId: string) => {
  const organization = await prisma.organization.delete({
    where: { id: orgId },
  });

  await deleteUserOrganization(orgId);
  return organization;
};
