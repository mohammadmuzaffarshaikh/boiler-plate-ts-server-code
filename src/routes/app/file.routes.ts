import express, { Router } from "express";
import validate from "../../middlewares/validate.middleware";
import { fileValidation } from "../../validations";
import { fileController } from "../../controllers";
import { auth } from "../../middlewares/auth.middleware";
import { uploadLimiter } from "../../middlewares/rate-limiter.middleware";
import {
  uploadSingleFile,
  handleMulterError,
  cleanupUpload,
} from "../../middlewares/upload.middleware";

const router: Router = express.Router();

/**
 * MIDDLEWARE ORDER ON THE UPLOAD ROUTE IS NOT ARBITRARY:
 *
 *   auth -> limiter -> cleanupUpload -> multer -> handleMulterError
 *     -> validate -> controller
 *
 * multer must run *before* `validate`, because `validate` reads `req.body`
 * and on a multipart request there is no body at all until multer has parsed
 * it. Put `validate` first and every text field reads as undefined — which
 * now matters twice over, because `folder` is one of those text fields and
 * it decides both the destination prefix and which file types are accepted.
 *
 * `handleMulterError` must sit immediately after multer. It is an
 * error-handling middleware (four arguments), so Express skips it on the
 * happy path and only calls it when multer rejects — without it a file one
 * byte over the limit surfaces as a masked 500 instead of a 413.
 *
 * `cleanupUpload` goes BEFORE multer, which reads backwards and is the only
 * position that works. Express skips every remaining *non-error* middleware
 * once something calls `next(err)` — not just the ones before the error
 * handler, all of them. So with `cleanupUpload` anywhere after multer, the
 * one case it exists for (multer itself rejecting a 96 MB file) is precisely
 * the case where it never runs. It registers a `res.once("close")` hook and
 * reads `req.file?.path` lazily inside that hook, at which point multer has
 * long since populated it — so running first costs nothing and covers every
 * downstream rejection as well: `validate` on an unexpected field, a thrown
 * controller, a dropped connection.
 *
 * Until this was reordered the spooled file was still removed, but only
 * because multer 2.x happens to unlink it itself on abort. The app's own
 * safety net was not in the path its comment claimed.
 *
 * Rights note: `auth` grants on rights alone — there is no ownership
 * exemption to reason about. Any STAFF or ADMIN may manage any file, which
 * is the intended behaviour: product media is shared catalogue content, not
 * the personal property of whoever uploaded it.
 */
router.post(
  "/",
  auth("upload:files"),
  uploadLimiter,
  cleanupUpload,
  uploadSingleFile,
  handleMulterError,
  validate(fileValidation.uploadFile),
  fileController.uploadFile,
);

router.get(
  "/",
  auth("read:files"),
  validate(fileValidation.listFiles),
  fileController.listFiles,
);

router.get(
  "/:fileId",
  auth("read:files"),
  validate(fileValidation.getFile),
  fileController.getFile,
);

router.patch(
  "/:fileId/status",
  auth("manage:files"),
  validate(fileValidation.updateStatus),
  fileController.updateFileStatus,
);

router.delete(
  "/:fileId",
  auth("manage:files"),
  validate(fileValidation.deleteFile),
  fileController.deleteFile,
);

export default router;
