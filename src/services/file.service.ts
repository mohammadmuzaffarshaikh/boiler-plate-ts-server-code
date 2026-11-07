import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import httpStatus from "http-status";
import { File, FileStatus, Prisma } from "@prisma/client";
import config from "../config/config";
import logger from "../config/logger";
import { prisma } from "../config/prisma-client";
import ApiError from "../utils/api-error";
import { removeTempFile } from "../utils/temp-file";
import {
  detectFileType,
  DetectedFileType,
  MAGIC_BYTE_LENGTH,
} from "../utils/detect-file-type";
import {
  detectContainerKind,
  detectContainerType,
} from "../utils/detect-container-type";
import { fileNameSlug, sanitizeFileName } from "../utils/sanitize-filename";
import {
  allKeyPrefixes,
  folderPolicy,
  isUploadFolder,
  keyPrefixFor,
  maxBytesFor,
  UploadFolder,
} from "../config/constants";
import * as storageService from "./storage.service";

/**
 * Files: the database side, and the orchestration between Postgres and R2.
 *
 * The lifecycle is three states (see `prisma/schema/enums/file-status`):
 *
 *   UNUSED          just uploaded, attached to nothing. Swept after the
 *                   grace period, object and row together.
 *   IN_USE          referenced by a product. Never swept.
 *   PENDING_DELETE  a delete is in progress or crashed partway.
 *
 * That third state is the whole reason deletes are crash-safe. Removing the
 * object first and the row second leaves, on a crash, a live row pointing at
 * nothing — which is what the sibling api repo does, and why a product page
 * there can end up with a broken image and no way to notice. Marking the row
 * first leaves, on a crash, a row the cron finishes off.
 */

const MS_PER_HOUR = 60 * 60 * 1000;

/** How many rows one cron pass will try to clean up. */
const SWEEP_BATCH_SIZE = 500;

/** Bounds on the orphan scan, which pages through an external listing. */
const MAX_LIST_PAGES = 100;
const MAX_ORPHANS_REPORTED = 1000;

export interface CreateFileParams {
  /** Path multer wrote to. Always unlinked before this function returns. */
  tempPath: string;
  /** The client's filename. Sanitised before it is stored or slugged. */
  originalName: string;
  /**
   * Destination folder, as sent by the caller. Re-checked here against the
   * allowlist rather than trusted from `validate`: a service must not depend
   * on a middleware two layers up still being mounted.
   */
  folder: UploadFolder;
  uploadedById?: string;
  /**
   * Base64 MD5 of the spooled bytes, computed by `upload.middleware` while
   * it wrote them. R2 verifies it and refuses a mismatch.
   *
   * Optional, and the fallback below re-reads the file when it is absent —
   * which is what every caller outside the upload route does. It is supplied
   * on the route because that is the one path where the file has just been
   * streamed past us anyway, and re-reading it there meant two full passes
   * over as much as 95 MB before the PUT could start.
   */
  contentMd5?: string;
}

export interface FileQuery {
  status?: FileStatus;
  folder?: string;
  page?: number;
  limit?: number;
}

export interface PaginatedFiles {
  results: File[];
  page: number;
  limit: number;
  totalPages: number;
  totalResults: number;
}

/** Read just enough of the file to identify it, without loading the rest. */
const readMagicBytes = async (filePath: string): Promise<Buffer> => {
  const handle = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(MAGIC_BYTE_LENGTH);
    const { bytesRead } = await handle.read(buffer, 0, MAGIC_BYTE_LENGTH, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

/** Base64 MD5 of the file, streamed. R2 verifies this and rejects a mismatch. */
const md5Base64 = async (filePath: string): Promise<string> => {
  const hash = crypto.createHash("md5");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("base64");
};

/**
 * Identify the file and check it against the folder's policy.
 *
 * Everything here reads bytes, never the filename or the client's declared
 * content type. Both of those are attacker-chosen; an SVG renamed to
 * `photo.jpg` and sent as `image/jpeg` fails at the first step below.
 *
 * Two passes, because two kinds of format exist. A JPEG or an MP4 is settled
 * by its first bytes. A `.docx` or a `.xls` is not: all OOXML files are ZIPs
 * and all legacy Office files are OLE compound files, so the prefix proves
 * only which container it is and the contents have to be opened to say
 * which document it holds. That second pass needs the path, not a buffer,
 * because a ZIP keeps its index at the end of the file.
 */
const classify = async (
  tempPath: string,
  folder: UploadFolder,
  size: number,
): Promise<DetectedFileType> => {
  const head = await readMagicBytes(tempPath);

  let detected = detectFileType(head);
  if (!detected) {
    const container = detectContainerKind(head);
    if (container) {
      detected = await detectContainerType(tempPath, container, size);
    }
  }

  if (!detected) {
    throw new ApiError(
      httpStatus.UNSUPPORTED_MEDIA_TYPE,
      "Unrecognised file type. The file's contents do not match any " +
        "accepted format.",
    );
  }

  if (!folderPolicy[folder].includes(detected.category)) {
    throw new ApiError(
      httpStatus.UNSUPPORTED_MEDIA_TYPE,
      `${detected.mimeType} is not accepted in "${folder}". That folder ` +
        `takes: ${folderPolicy[folder].join(", ")}.`,
    );
  }

  // Checked after detection, not before: the cap that applies is the one for
  // what the file actually is, not for what its name suggests.
  const limit = maxBytesFor(detected.category);
  if (size > limit) {
    throw new ApiError(
      httpStatus.REQUEST_ENTITY_TOO_LARGE,
      `${detected.category} files may be at most ${Math.floor(
        limit / (1024 * 1024),
      )} MB.`,
    );
  }

  return detected;
};

/**
 * Build the object key.
 *
 * `<folder>/<slug>-<uuid>.<ext>`, and every part of that is decided here:
 *
 *   - the folder is an allowlist lookup, never the caller's string;
 *   - the slug is `[a-z0-9-]` only, from `fileNameSlug`, and may be empty
 *     for a name with no Latin characters in it at all;
 *   - the uuid is what makes the key unique, so the slug never has to;
 *   - the extension comes from the sniffed type, not from the filename.
 *
 * The slug is the one piece influenced by the request, which is a change
 * from "nothing in the key comes from the client". It is a deliberate
 * trade: these URLs are public product media, and
 * `/product_images/blue-hoodie-front-<uuid>.jpg` is worth more to a
 * storefront than a bare uuid. Every property the old rule protected still
 * holds — no traversal (no `/` or `.` can survive the slug), no collision
 * (the uuid), no escaping needed anywhere downstream (URL-safe by
 * construction).
 */
const buildKey = (
  folder: UploadFolder,
  originalName: string,
  extension: string,
): string => {
  const slug = fileNameSlug(originalName);
  const prefix = slug === "" ? "" : `${slug}-`;
  return `${keyPrefixFor(folder)}/${prefix}${randomUUID()}.${extension}`;
};

/**
 * Upload one file to R2 and record it.
 *
 * The object is written before the row, which is the safe ordering for
 * uploads: a crash in between leaves an object with no row, which the orphan
 * sweep reports. The reverse would leave a row promising a URL that 404s.
 */
export const createFile = async (params: CreateFileParams): Promise<File> => {
  try {
    if (!isUploadFolder(params.folder)) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Unknown upload folder "${String(params.folder)}".`,
      );
    }

    const { size } = await fsp.stat(params.tempPath);
    if (size === 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, "The uploaded file is empty.");
    }

    const detected = await classify(params.tempPath, params.folder, size);
    const originalName = sanitizeFileName(params.originalName);
    const key = buildKey(params.folder, originalName, detected.extension);

    // Already computed during the spool write on the upload route. The
    // fallback is a full second read of the file, so it is the slow path on
    // purpose, not the default one.
    const contentMd5 = params.contentMd5 ?? (await md5Base64(params.tempPath));

    // Opened last, and destroyed by hand if the PUT never consumes it.
    //
    // `putObject` can throw before it ever touches the body — storage
    // switched off, a credential rejected — and an unconsumed ReadStream
    // left behind then opens a path the `finally` below has already
    // unlinked. That surfaces as an ENOENT `error` event on a stream nobody
    // is listening to, which is an unhandled rejection rather than the 503
    // the caller should get.
    //
    // This was always true and was hidden by evaluation order: the digest
    // used to be awaited inside this same object literal, which yielded the
    // event loop for long enough that the stream's `open` landed while the
    // file still existed. A latent leak, not a new one.
    const body = fs.createReadStream(params.tempPath);

    let etag: string | null;
    try {
      ({ etag } = await storageService.putObject({
        key,
        body,
        contentType: detected.mimeType,
        contentLength: size,
        contentMd5,
      }));
    } catch (err) {
      // Tear the unconsumed stream down and WAIT for it before rethrowing,
      // because the `finally` below unlinks the file the moment this throw
      // leaves. `createReadStream` queues its `open` on the threadpool, so a
      // stream destroyed in the same tick can still have that open land
      // afterwards — against a path that no longer exists — and report it as
      // an `error` event with nothing listening, which Node escalates to an
      // unhandled rejection instead of the 503 the caller should receive.
      //
      // The listener is attached only here, on the failure path. A read
      // error during a PUT that IS consuming the body still propagates
      // through the SDK as it always did; nothing is swallowed.
      await new Promise<void>((resolve) => {
        body.once("error", () => resolve());
        body.once("close", () => resolve());
        body.destroy();
      });

      throw err;
    }

    return prisma.file.create({
      data: {
        key,
        url: storageService.buildPublicUrl(key),
        folder: params.folder,
        originalName,
        mimeType: detected.mimeType,
        size,
        etag,
        status: FileStatus.UNUSED,
        uploadedById: params.uploadedById ?? null,
      },
    });
  } finally {
    // In a `finally` so the temp file goes whether the upload succeeded, R2
    // refused it, or the type was rejected. Without this every failed upload
    // leaks a file into the temp directory until the disk fills.
    await removeTempFile(params.tempPath);
  }
};

export const getFileById = async (id: string): Promise<File | null> =>
  prisma.file.findUnique({ where: { id } });

export const queryFiles = async (query: FileQuery): Promise<PaginatedFiles> => {
  const page = Math.max(1, query.page ?? 1);
  const limit = Math.min(100, Math.max(1, query.limit ?? 20));
  const where: Prisma.FileWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.folder ? { folder: query.folder } : {}),
  };

  const [results, totalResults] = await Promise.all([
    prisma.file.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.file.count({ where }),
  ]);

  return {
    results,
    page,
    limit,
    totalResults,
    totalPages: Math.ceil(totalResults / limit) || 1,
  };
};

/**
 * Mark files as attached, so the sweep stops considering them.
 *
 * Call this from inside the same transaction that saves the product. Doing
 * it afterwards leaves a window where the product is saved and its images
 * are still sweepable.
 */
export const markFilesInUse = async (ids: string[]): Promise<number> => {
  if (ids.length === 0) return 0;
  const { count } = await prisma.file.updateMany({
    where: { id: { in: ids }, status: FileStatus.UNUSED },
    data: { status: FileStatus.IN_USE },
  });
  return count;
};

/** Detach files — they become sweepable again after the grace period. */
export const markFilesUnused = async (ids: string[]): Promise<number> => {
  if (ids.length === 0) return 0;
  const { count } = await prisma.file.updateMany({
    where: { id: { in: ids }, status: FileStatus.IN_USE },
    data: { status: FileStatus.UNUSED },
  });
  return count;
};

/**
 * Delete the row with no error if it is already gone.
 *
 * `prisma.file.delete` throws P2025 on a missing row, and a missing row is
 * the normal outcome when the cron and a request both finish the same
 * PENDING_DELETE. `deleteMany` simply reports zero.
 */
const deleteRowIfPresent = async (id: string): Promise<void> => {
  await prisma.file.deleteMany({ where: { id } });
};

/**
 * Remove a file, object and row.
 *
 * Three steps, in this order, and the order is the point:
 *
 *   1. status -> PENDING_DELETE. Now the intent survives a crash.
 *   2. delete the object from R2. Idempotent, so a retry is free.
 *   3. delete the row.
 *
 * Crash after 1: the cron finds the PENDING_DELETE row and resumes at 2.
 * Crash after 2: same, and step 2 is a no-op the second time.
 * There is no ordering here that leaves a row pointing at a dead object.
 */
export const deleteFile = async (id: string): Promise<void> => {
  // Checked BEFORE the status flip, not left to `deleteObject`. With R2
  // switched off, flipping first would leave the row stranded in
  // PENDING_DELETE: the request fails, and the nightly sweep that would
  // finish the job returns early for exactly the same reason, so nothing
  // can recover the row until R2 is turned back on.
  storageService.assertStorageEnabled();

  const file = await getFileById(id);
  if (!file) throw new ApiError(httpStatus.NOT_FOUND, "File not found.");

  // `updateMany`, not `update`: two staff deleting the same file at once
  // both get past the lookup above, and `update` answers a vanished row with
  // P2025, which `errorConverter` would class as a 500. A count of zero here
  // means someone else finished first, which is a 404, not a server fault.
  const { count } = await prisma.file.updateMany({
    where: { id },
    data: { status: FileStatus.PENDING_DELETE },
  });
  if (count === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "File not found.");
  }

  await storageService.deleteObject(file.key);
  await deleteRowIfPresent(id);
};

export interface SweepResult {
  deleted: number;
  failed: number;
}

/**
 * The cron's job: finish pending deletes and remove files nobody claimed.
 *
 * Two different age rules, deliberately:
 *
 *   - UNUSED waits out `FILE_UNUSED_GRACE_HOURS`. Without that window the
 *     sweep races a staff member who uploaded an image and has not yet
 *     pressed Save — exactly the bug the sibling api repo has, where the
 *     cron deletes UNUSED rows with no age check at all.
 *   - PENDING_DELETE is retried immediately. Someone already asked for it to
 *     go; waiting a day only prolongs an inconsistent state. A request that
 *     is still in flight is harmless here, because the object delete is
 *     idempotent and the row delete tolerates an already-deleted row.
 */
export const deleteUnusedFiles = async (): Promise<SweepResult> => {
  const cutoff = new Date(
    Date.now() - config.STORAGE.UNUSED_GRACE_HOURS * MS_PER_HOUR,
  );

  const candidates = await prisma.file.findMany({
    where: {
      OR: [
        { status: FileStatus.UNUSED, createdAt: { lt: cutoff } },
        { status: FileStatus.PENDING_DELETE },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: SWEEP_BATCH_SIZE,
  });

  let deleted = 0;
  let failed = 0;

  for (const file of candidates) {
    try {
      if (file.status !== FileStatus.PENDING_DELETE) {
        // updateMany for the same reason as in `deleteFile`: a request may
        // have finished this row between the query above and now.
        await prisma.file.updateMany({
          where: { id: file.id },
          data: { status: FileStatus.PENDING_DELETE },
        });
      }
      await storageService.deleteObject(file.key);
      await deleteRowIfPresent(file.id);
      deleted += 1;
    } catch (err) {
      // One unreachable object must not abandon the rest of the batch. The
      // row stays PENDING_DELETE and is picked up again next run.
      failed += 1;
      logger.warn(
        `[Files] Sweep could not remove ${file.key}: ${(err as Error).message}`,
      );
    }
  }

  return { deleted, failed };
};

/**
 * Keys present in R2 with no row in Postgres.
 *
 * Reports only — it never deletes. An object with no row is usually a crash
 * between the PUT and the insert, but it could equally be something uploaded
 * out of band with `wrangler`, and guessing wrong here destroys data that
 * nothing can recover. A human reads the log and decides.
 */
export const findOrphanedObjects = async (): Promise<string[]> => {
  const orphans: string[] = [];

  for (const prefix of allKeyPrefixes()) {
    let cursor: string | undefined;
    let pages = 0;

    do {
      const page = await storageService.listObjects(`${prefix}/`, cursor);
      if (page.keys.length > 0) {
        const known = await prisma.file.findMany({
          where: { key: { in: page.keys } },
          select: { key: true },
        });
        const knownKeys = new Set(known.map((row) => row.key));
        for (const key of page.keys) {
          if (!knownKeys.has(key) && orphans.length < MAX_ORPHANS_REPORTED) {
            orphans.push(key);
          }
        }
      }

      cursor = page.nextCursor ?? undefined;
      pages += 1;

      // Two bounds, because this walks an external system's paging on a
      // timer with nothing watching it. A provider that returns the same
      // continuation token twice would otherwise spin forever, and an
      // unexpectedly large bucket would otherwise build a million-entry
      // array in a background job. Hitting either cap is itself worth saying.
      if (pages >= MAX_LIST_PAGES) {
        logger.warn(
          `[Files] Orphan scan stopped at ${MAX_LIST_PAGES} pages for ` +
            `"${prefix}/" — the listing was still incomplete.`,
        );
        break;
      }
      if (orphans.length >= MAX_ORPHANS_REPORTED) {
        logger.warn(
          `[Files] Orphan scan stopped at ${MAX_ORPHANS_REPORTED} findings; ` +
            "there may be more.",
        );
        break;
      }
    } while (cursor);
  }

  return orphans;
};
