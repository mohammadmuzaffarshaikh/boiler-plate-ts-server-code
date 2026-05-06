import cron from "node-cron";
import { deleteExpiredTokens } from "./token-cleanup.job";
import { cleanupExpiredSessions } from "./session-cleanup.job";
import config from "../config/config";
import logger from "../config/logger";

const registerCronJobs = () => {
  cron.schedule(config.CRON.TOKEN_CLEANUP, async () => {
    logger.info("Running scheduled token cleanup job...");
    await deleteExpiredTokens();
  });

  cron.schedule(config.CRON.SESSION_CLEANUP, async () => {
    logger.info("Running scheduled session cleanup job...");
    await cleanupExpiredSessions();
  });
};

export default registerCronJobs;
