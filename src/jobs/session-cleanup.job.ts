import logger from "../config/logger";
import { sessionService } from "../services";

export const cleanupExpiredSessions = async () => {
  const count = await sessionService.deleteExpiredSessions();
  logger.info(`Deleted ${count} expired/revoked sessions from the database.`);
};
