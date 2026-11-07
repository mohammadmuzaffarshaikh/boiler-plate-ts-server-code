import { prisma } from "../config/prisma-client";
import { normalizeEmail } from "./normalize-email";

export const isEmailTakenUser = async (
  email: string,
  excludeUserId?: string
) => {
  // Normalised here as well as in the caller. `users.email` is case-sensitive
  // in Postgres, so an un-folded argument makes this answer "free" for an
  // address that is already taken in another casing — and the point of this
  // check is to be the thing that cannot be wrong.
  const user = await prisma.user.findUnique({
    where: { email: normalizeEmail(email) },
  });
  return user && user.id !== excludeUserId;
};
