import fsp from "node:fs/promises";
import logger from "../config/logger";

/**
 * Delete a spooled upload, tolerating its absence.
 *
 * Shared because two different things are responsible for it at two
 * different times, and both must be safe to run after the other:
 *
 *   - `file.service.createFile` removes it in a `finally`, covering the
 *     normal path and every failure it can see.
 *   - `cleanupUpload` removes it when the response ends, covering the cases
 *     `createFile` never hears about — a validation error after multer has
 *     already spooled the file, a thrown controller, a dropped connection.
 *
 * Whichever runs second finds nothing, which is why ENOENT is not an error
 * here. Anything else is worth a line in the log but must never surface to
 * the caller: a failed cleanup is not a failed request.
 */
export const removeTempFile = async (filePath: string): Promise<void> => {
  try {
    await fsp.unlink(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warn(`[Files] Could not remove temp file ${filePath}: ${code}`);
    }
  }
};
