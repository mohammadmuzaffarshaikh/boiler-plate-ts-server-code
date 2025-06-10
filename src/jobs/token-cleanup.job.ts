import logger from "../config/logger";
import { prisma } from "../utils/prisma-client";

/**
 * Delete expired tokens from the database
 * @returns void
 */
export const deleteExpiredTokens = async () => {
  const { count } = await prisma.token.deleteMany({
    where: {
      expires: { lt: new Date() },
    },
  });

  logger.info(`Deleted ${count} expired tokens from the database.`);
};
