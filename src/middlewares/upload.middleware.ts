import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { NextFunction, Request, RequestHandler, Response } from "express";
import multer, { FileFilterCallback, MulterError } from "multer";
import httpStatus from "http-status";
import ApiError from "../utils/api-error";
import { ALLOWED_EXTENSIONS } from "../utils/detect-file-type";
import { maxUploadBytes } from "../config/constants";
import { removeTempFile } from "../utils/temp-file";
import config from "../config/config";

/**
 * Multipart intake.
 *
 * TWO DECISIONS WORTH KEEPING:
 *
 * 1. `diskStorage`, never `memoryStorage`. With a 100 MB video cap,
 *    memoryStorage means 100 MB of heap per concurrent upload and an OOM the
 *    first time three people publish a product at once. The file lands in a
 *    temp directory and is streamed to R2 from there; `file.service` unlinks
 *    it in a `finally`, including on the failure path.
 *
 * 2. `fileFilter` here is a cheap pre-screen and NOT a security control. It
 *    only reads the filename and the client's declared `Content-Type`, both
 *    of which the client chooses. The authoritative check is the magic-byte
 *    sniff in `file.service`, which cannot run until the bytes exist on
 *    disk. Renaming `payload.svg` to `photo.jpg` gets past this filter and
 *    is then refused by the sniffer — that is the intended division.
 */

/**
 * Resolve and sanity-check the spool directory once, at startup.
 *
 * Deliberately eager rather than checked per request. A typo in
 * `UPLOAD_TMP_DIR`, or a volume that did not mount, should stop the process
 * at boot with a message naming the path — not surface as a confusing 500 on
 * the first upload someone attempts, possibly days later.
 */
const resolveTmpDir = (): string => {
  const dir = config.STORAGE.TMP_DIR;

  try {
    // Recursive, so pointing at a path on a fresh volume just works. A no-op
    // for the default, since the system temp directory always exists.
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (err) {
    throw new Error(
      `UPLOAD_TMP_DIR "${dir}" is not usable: ${(err as Error).message}. ` +
        "It must be a writable directory on a disk with room for " +
        "(concurrent uploads x max file size).",
      { cause: err },
    );
  }

  return dir;
};

const TMP_DIR = resolveTmpDir();

/**
 * Disk storage that hashes while it writes.
 *
 * `multer.diskStorage` pipes the upload to a file and nothing else, so
 * `file.service` then had to open that file again purely to compute the
 * `Content-MD5` that R2 verifies. At the 95 MB video cap that is a second
 * full pass over the file, and it has to finish before the PUT can start —
 * so it cost latency, not just I/O.
 *
 * The digest cannot be folded into the upload itself: R2 checks the body
 * against a request header, so the header must exist first. It can be folded
 * into the pass that was already happening, which is this write.
 *
 * DELEGATES to `multer.diskStorage` rather than reimplementing it, and that
 * is deliberate. Multer's own engine does considerably more than pipe a
 * stream to a file: it assigns `file.path` before the write starts so an
 * aborted request can still be cleaned up, tracks the open write stream so
 * `_removeFile` can wait for the descriptor to close before unlinking,
 * refuses a stream that is already destroyed, and routes everything through
 * `stream.pipeline`. A hand-rolled engine that skipped any of that would
 * strand or double-delete spool files on exactly the failure paths nobody
 * exercises by hand.
 *
 * So the only change is what multer is handed: a pass-through that updates
 * the digest per chunk and forwards the bytes untouched.
 *
 * Temp filename: no extension at all, so nothing downstream can be tempted
 * to derive a type from it. The real extension comes from the sniffer.
 */
const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TMP_DIR),
  filename: (_req, _file, cb) => cb(null, `upload-${randomUUID()}`),
});

/**
 * A spooled file, plus the digest the engine below computed while writing it.
 *
 * Declared here rather than as an ambient augmentation of
 * `Express.Multer.File`. A `declare global` block in a `.d.ts` is only
 * applied by compilers that load the tsconfig `include` globs: `tsc` does,
 * and `ts-node` — which is what `pnpm dev` runs — does NOT unless
 * `ts-node.files` is turned on. So the augmentation typechecked in CI and
 * crashed the dev server on startup. A named type next to the code that
 * sets the property cannot drift that way, and says where the value comes
 * from besides.
 */
export interface SpooledFile extends Express.Multer.File {
  /** Base64 MD5 of the spooled bytes, computed during the write. */
  contentMd5?: string;
}

/**
 * Read the digest off a file multer has spooled.
 *
 * The property is real at runtime — multer merges whatever the storage
 * engine reports into the file object — but it is ours, not multer's, so
 * the one cast that asserts it lives here beside the engine that sets it.
 */
export const spooledMd5 = (file: Express.Multer.File): string | undefined =>
  (file as SpooledFile).contentMd5;

const storage: multer.StorageEngine = {
  _handleFile(req, file, cb): void {
    const hash = createHash("md5");

    const hashing = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        done(null, chunk);
      },
    });

    const source = file.stream;

    // `.pipe()` does not forward errors, and multer aborts an oversized or
    // broken upload by destroying the source. Without this the transform
    // would simply end, and multer's pipeline would see a clean finish on a
    // file that is actually truncated.
    source.on("error", (err: Error) => hashing.destroy(err));

    // What multer consumes from here on. Redefined rather than assigned:
    // make-middleware installs `stream` with `Object.defineProperty` and NO
    // `writable: true`, so `file.stream = ...` silently does nothing. The
    // raw busboy stream then stays in place while the transform is also
    // reading it, and two consumers racing one stream hangs the request.
    //
    // Replaced on the file object rather than wrapped in a proxy so that
    // `file.path` — which diskStorage sets on this same object before the
    // write starts — still lands where multer and `cleanupSpooledFile` look
    // for it.
    Object.defineProperty(file, "stream", {
      configurable: true,
      enumerable: false,
      value: source.pipe(hashing),
    });

    diskStorage._handleFile(req, file, (err, info) => {
      if (err) return cb(err);
      // Cast because `contentMd5` is ours and not part of multer's own
      // `File`; `spooledMd5` above is the matching read. Multer merges
      // whatever is reported here onto the file object.
      cb(null, {
        ...info,
        contentMd5: hash.digest("base64"),
      } as Partial<SpooledFile>);
    });
  },

  _removeFile(req, file, cb): void {
    diskStorage._removeFile(req, file, cb);
  },
};

const extensionOf = (filename: string): string =>
  path.extname(filename).slice(1).toLowerCase();

const fileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: FileFilterCallback,
): void => {
  const extension = extensionOf(file.originalname);

  // No extension at all is allowed through on purpose. A browser uploading
  // from `canvas.toBlob()`, a clipboard paste, or several mobile pickers
  // sends a filename of "blob" or "image" with no extension, and refusing
  // those would reject perfectly valid PNGs before the authoritative check
  // ever sees them. There is nothing to pre-screen, so defer to the sniffer.
  if (extension === "") {
    cb(null, true);
    return;
  }

  if (!ALLOWED_EXTENSIONS.includes(extension)) {
    cb(
      new ApiError(
        httpStatus.UNSUPPORTED_MEDIA_TYPE,
        `Unsupported file type. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}.`,
      ),
    );
    return;
  }

  cb(null, true);
};

/**
 * The multipart handler. One instance, for every folder.
 *
 * It cannot be per-folder: the folder arrives as a text field in the same
 * multipart body multer is parsing, so it is not known until multer has
 * finished. `fileSize` is therefore the largest cap of any category, and
 * the exact per-type cap is applied afterwards by `file.service`, against
 * the type sniffed from the bytes. See `maxUploadBytes`.
 *
 * `limits` bound the whole body, not just the file: without `fields`/`parts`
 * a caller can send a million empty text fields and keep the parser busy
 * without ever tripping the size limit.
 */
export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: maxUploadBytes(),
    files: 1,
    fields: 10,
    parts: 11,
    fieldNameSize: 100,
    fieldSize: 10 * 1024,
  },
});

/** The only multipart entry point: exactly one file, in the `file` field. */
export const uploadSingleFile: RequestHandler = upload.single("file");

/**
 * Guarantee the spooled file is deleted once the response is over.
 *
 * Mount it directly after `upload.single(...)`. By the time any later
 * middleware runs, multer has already written the whole file to disk — so
 * anything that rejects between there and `file.service` (a `validate`
 * failure on an unexpected form field, a thrown controller, a client that
 * hangs up) would otherwise strand up to a full-size video on disk with
 * nothing to ever collect it: `createFile`'s own `finally` never runs, and
 * the nightly sweep only knows about Postgres and R2, never `UPLOAD_TMP_DIR`.
 *
 * `close` rather than `finish`, because it fires for aborted responses too.
 * On the happy path `createFile` has already unlinked the file and this is a
 * harmless no-op.
 */
export const cleanupUpload = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  res.once("close", () => {
    const spooled = req.file?.path;
    if (spooled) void removeTempFile(spooled);
  });

  next();
};

const MULTER_STATUS: Record<string, number> = {
  LIMIT_FILE_SIZE: httpStatus.REQUEST_ENTITY_TOO_LARGE,
  LIMIT_FILE_COUNT: httpStatus.BAD_REQUEST,
  LIMIT_UNEXPECTED_FILE: httpStatus.BAD_REQUEST,
  LIMIT_PART_COUNT: httpStatus.BAD_REQUEST,
  LIMIT_FIELD_KEY: httpStatus.BAD_REQUEST,
  LIMIT_FIELD_VALUE: httpStatus.BAD_REQUEST,
  LIMIT_FIELD_COUNT: httpStatus.BAD_REQUEST,
};

const MULTER_MESSAGE: Record<string, string> = {
  LIMIT_FILE_SIZE: "File is too large.",
  LIMIT_FILE_COUNT: "Only one file may be uploaded per request.",
  LIMIT_UNEXPECTED_FILE: 'Unexpected file field. Use the field name "file".',
};

/**
 * Translate multer's errors into this app's error shape.
 *
 * Mount it immediately after `upload.single(...)`. Without it a
 * `LIMIT_FILE_SIZE` reaches `errorConverter` as a plain `Error` with no
 * `statusCode`, gets classified 500, and production then masks it to
 * "Internal Server Error" — so a user uploading a file one byte over the
 * limit is told the server is broken.
 */
export const handleMulterError = (
  err: unknown,
  _req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  if (err instanceof MulterError) {
    next(
      new ApiError(
        MULTER_STATUS[err.code] ?? httpStatus.BAD_REQUEST,
        MULTER_MESSAGE[err.code] ?? `Upload failed: ${err.message}.`,
      ),
    );
    return;
  }

  next(err);
};
