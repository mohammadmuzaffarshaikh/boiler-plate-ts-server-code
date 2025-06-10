// This file is responsible for registering all cron jobs in the application.

import cron from "node-cron";
import { deleteExpiredTokens } from "./token-cleanup.job";
import config from "../config/config";
import logger from "../config/logger";

const registerCronJobs = () => {
  // Run every 24 hours at midnight UTC timezone
  cron.schedule(config.cron.tokenCleanup || "0 0 * * *", async () => {
    logger.info("Running schedule token cleanup job...");
    await deleteExpiredTokens();
  });

  // Add more cron jobs here as needed
};

export default registerCronJobs;
