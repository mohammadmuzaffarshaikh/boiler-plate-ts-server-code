import { prisma } from "./prisma-client";

export const isEmailTakenUser = async (
  email: string,
  excludeUserId?: string
) => {
  const user = await prisma.user.findUnique({ where: { email } });
  return user && user.id !== excludeUserId;
};
