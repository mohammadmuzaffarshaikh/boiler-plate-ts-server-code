import cron from "node-cron";
import { deleteExpiredTokens } from "./token-cleanup.job";
import { cleanupExpiredSessions } from "./session-cleanup.job";
import { cleanupFiles } from "./file-cleanup.job";
import config from "../config/config";
import logger from "../config/logger";

/**
 * Every schedule in this file is UTC, so the host's own timezone cannot
 * change when a job runs. Stated once here and passed explicitly below.
 */
const CRON_TIMEZONE = "UTC";

interface ScheduledJob {
  name: string;
  /** Cron expression, in UTC. */
  schedule: string;
  run: () => Promise<void>;
}

const jobs: ScheduledJob[] = [
  {
    name: "token cleanup",
    schedule: config.CRON.TOKEN_CLEANUP,
    run: deleteExpiredTokens,
  },
  {
    name: "session cleanup",
    schedule: config.CRON.SESSION_CLEANUP,
    run: cleanupExpiredSessions,
  },
  { name: "file cleanup", schedule: config.CRON.FILE_CLEANUP, run: cleanupFiles },
];

/**
 * Register every scheduled job.
 *
 * A table rather than three copies of the same `cron.schedule` block, so a
 * new job is one entry and the logging and error handling cannot drift
 * between them — which is how the file job ended up being the only one that
 * caught its own failures.
 *
 * Each run is wrapped: node-cron does catch a rejected handler, but it
 * reports through its own channel rather than winston, so a failure would
 * otherwise be missing from the logs everything else is read in.
 */
const registerCronJobs = (): void => {
  for (const job of jobs) {
    cron.schedule(
      job.schedule,
      async () => {
        logger.info(`Running scheduled ${job.name} job...`);
        try {
          await job.run();
        } catch (err) {
          logger.error(`Scheduled ${job.name} job failed: ${(err as Error).message}`);
        }
      },
      // node-cron interprets an expression in the HOST timezone unless told
      // otherwise, while the `schedule` field above, .env.example and the
      // config descriptions all say UTC. On a container with TZ set — which
      // is most of them — `0 3 * * *` fired at some other hour entirely, and
      // nothing logged the discrepancy. The file sweep deletes R2 objects,
      // so the window it runs in is operationally meaningful.
      { timezone: CRON_TIMEZONE },
    );

    logger.info(
      `Scheduled ${job.name}: "${job.schedule}" (${CRON_TIMEZONE})`,
    );
  }
};

export default registerCronJobs;
