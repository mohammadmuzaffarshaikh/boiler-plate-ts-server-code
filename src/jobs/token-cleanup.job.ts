import logger from "../config/logger";
import { prisma } from "../config/prisma-client";
import { deleteExpiredAuthCodes } from "../services/auth-code.service";

/**
 * Delete expired tokens and authorization codes from the database.
 *
 * Both in one job because both are "a credential row past its expiry" and
 * splitting them would mean two crons with one reason between them.
 *
 * `auth_codes` is the higher-churn of the two by a wide margin — a row per
 * native login, dead within a minute — so it is the one that actually needs
 * the sweep. Redeemed rows go on the same schedule rather than being deleted
 * at redemption: a consumed row is what makes a replay detectable, so it has
 * to outlive the code's own validity window to do that job.
 */
export const deleteExpiredTokens = async () => {
  const { count } = await prisma.token.deleteMany({
    where: {
      expires: { lt: new Date() },
    },
  });

  logger.info(`Deleted ${count} expired tokens from the database.`);

  const codes = await deleteExpiredAuthCodes();

  logger.info(`Deleted ${codes} expired authorization codes.`);
};
