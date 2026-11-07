import logger from "../config/logger";
import { fileService } from "../services";
import { isStorageEnabled } from "../config/r2-client";

/**
 * Nightly file sweep.
 *
 * Two separate jobs in one pass, with different risk profiles:
 *
 *   1. Delete rows that nothing claimed, and finish any delete that crashed
 *      partway. This one does destroy data, which is why `deleteUnusedFiles`
 *      only touches UNUSED rows older than the configured grace period.
 *   2. Report objects in R2 with no row in Postgres. This one deliberately
 *      does NOT delete. An unexplained object is more likely to be something
 *      a human put there than something worth destroying unattended; if the
 *      log stays quiet for a few weeks, promoting it to a real delete is a
 *      small change.
 */
export const cleanupFiles = async (): Promise<void> => {
  if (!isStorageEnabled()) {
    logger.info("[Files] R2 disabled — skipping file cleanup.");
    return;
  }

  // The two halves are independent on purpose. The sweep talks to Postgres
  // and R2; the orphan scan pages through an R2 listing. Either can fail on
  // its own, and a failed sweep must not mean nobody hears about orphans for
  // another day — so each is caught here rather than letting the first
  // failure abandon the second. (`jobs/index.ts` catches anything that still
  // escapes, which is the backstop, not the plan.)
  try {
    const { deleted, failed } = await fileService.deleteUnusedFiles();
    logger.info(
      `[Files] Sweep removed ${deleted} file(s); ${failed} failed and will be retried.`,
    );
  } catch (err) {
    logger.error(`[Files] Sweep failed: ${(err as Error).message}`);
  }

  try {
    const orphans = await fileService.findOrphanedObjects();
    if (orphans.length === 0) {
      logger.info("[Files] No orphaned objects in R2.");
      return;
    }

    logger.warn(
      `[Files] ${orphans.length} object(s) in R2 have no database row and were ` +
        `NOT deleted: ${orphans.slice(0, 20).join(", ")}` +
        (orphans.length > 20 ? ", ..." : ""),
    );
  } catch (err) {
    logger.error(`[Files] Orphan scan failed: ${(err as Error).message}`);
  }
};
