import httpStatus from "http-status";
import { Request, Response } from "express";
import { FileStatus } from "@prisma/client";
import catchAsync from "../utils/catch-async";
import pick from "../utils/pick";
import ApiError from "../utils/api-error";
import { fileService } from "../services";
import { UploadFolder } from "../config/constants";
import { spooledMd5 } from "../middlewares/upload.middleware";

/** The shape returned to clients. Everything on the model is staff-visible. */
const FILE_FIELDS = [
  "id",
  "key",
  "url",
  "folder",
  "originalName",
  "mimeType",
  "size",
  "etag",
  "status",
  "uploadedById",
  "createdAt",
  "updatedAt",
];

const currentUserId = (req: Request): string | undefined =>
  (req as Request & { user?: { id?: string } }).user?.id;

/**
 * Express 5 types a route param as `string | string[]`, because a path may
 * repeat a name. `:fileId` appears once in every route here and `validate`
 * has already checked it against `Joi.string().uuid()`, so the array arm is
 * unreachable — this narrows it in one place instead of at six call sites.
 */
const fileIdOf = (req: Request): string => String(req.params.fileId);

/**
 * Accept one file.
 *
 * Note what is *not* here: no type checking, no size checking, no key
 * building. All of that is in `file.service`, which does it from the file's
 * bytes. A controller that decided any of it would be deciding from
 * `req.file.mimetype`, which is whatever the client typed.
 *
 * `folder` comes from the multipart text fields, so it exists only because
 * multer runs before `validate` and before this. It decides the key prefix
 * AND which file types are acceptable — see `folderPolicy`.
 */
const uploadFile = catchAsync(async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'No file was uploaded. Send one file in the "file" field.',
    );
  }

  const created = await fileService.createFile({
    tempPath: file.path,
    originalName: file.originalname,
    // Checked against the allowlist by `validate` before this runs, and
    // again by the service. The cast is the narrowing of a validated
    // string, not a claim about untrusted input.
    folder: req.body.folder as UploadFolder,
    uploadedById: currentUserId(req),
    // Computed by the spool writer as the bytes went to disk, so the service
    // does not have to read the whole file again to produce it.
    contentMd5: spooledMd5(file),
  });

  res.status(httpStatus.CREATED).send({
    status: "success",
    message: "File uploaded successfully.",
    data: { file: pick(created, FILE_FIELDS) },
  });
});

const listFiles = catchAsync(async (req: Request, res: Response) => {
  const { status, folder, page, limit } = req.query;

  const result = await fileService.queryFiles({
    status: status as FileStatus | undefined,
    folder: folder as string | undefined,
    page: page ? Number(page) : undefined,
    limit: limit ? Number(limit) : undefined,
  });

  res.status(httpStatus.OK).send({
    status: "success",
    data: {
      files: pick(result.results, FILE_FIELDS),
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
      totalResults: result.totalResults,
    },
  });
});

const getFile = catchAsync(async (req: Request, res: Response) => {
  const file = await fileService.getFileById(fileIdOf(req));
  if (!file) throw new ApiError(httpStatus.NOT_FOUND, "File not found.");

  res.status(httpStatus.OK).send({
    status: "success",
    data: { file: pick(file, FILE_FIELDS) },
  });
});

/**
 * Attach or detach a file.
 *
 * This is what stops the cron sweeping an image the moment a product starts
 * using it. Once `Product` exists, the product service should call
 * `markFilesInUse` inside its own transaction and this route becomes a
 * manual override rather than the main path.
 */
const updateFileStatus = catchAsync(async (req: Request, res: Response) => {
  const fileId = fileIdOf(req);
  const status = req.body.status as FileStatus;

  const file = await fileService.getFileById(fileId);
  if (!file) throw new ApiError(httpStatus.NOT_FOUND, "File not found.");

  if (status === FileStatus.IN_USE) {
    await fileService.markFilesInUse([fileId]);
  } else {
    await fileService.markFilesUnused([fileId]);
  }

  // Re-read rather than trusting the write: the status transitions are
  // guarded (UNUSED -> IN_USE only, and vice versa), so a file that was
  // already PENDING_DELETE is left alone and the response must show that
  // rather than echo back what was asked for.
  const updated = await fileService.getFileById(fileId);
  if (!updated) throw new ApiError(httpStatus.NOT_FOUND, "File not found.");

  res.status(httpStatus.OK).send({
    status: "success",
    message: "File status updated successfully.",
    data: { file: pick(updated, FILE_FIELDS) },
  });
});

/**
 * Delete a file.
 *
 * Any STAFF or ADMIN may delete any file, including one uploaded by someone
 * else: product media is shared catalogue content, not personal property.
 * That is a deliberate policy choice, not an oversight — the sibling api
 * repo reaches the same outcome by accident, because it never scopes the
 * lookup at all and therefore lets *customers* do it too.
 */
const deleteFile = catchAsync(async (req: Request, res: Response) => {
  await fileService.deleteFile(fileIdOf(req));

  res.status(httpStatus.OK).send({
    status: "success",
    message: "File deleted successfully.",
  });
});

export { uploadFile, listFiles, getFile, updateFileStatus, deleteFile };
