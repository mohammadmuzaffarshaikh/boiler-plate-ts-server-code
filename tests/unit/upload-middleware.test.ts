import express, { Express, Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import {
  uploadSingleFile,
  handleMulterError,
  cleanupUpload,
} from "../../src/middlewares/upload.middleware";
import {
  errorConverter,
  errorHandler,
} from "../../src/middlewares/error.middleware";
import validate from "../../src/middlewares/validate.middleware";
import * as fileValidation from "../../src/validations/file.validation";
import config from "../../src/config/config";
import { samples, padded, spooledFiles } from "../helpers/samples";

/**
 * The multipart layer, isolated from auth, the database and R2.
 *
 * `fileFilter` here is a cheap pre-screen, NOT a security control — the
 * authoritative check is the magic-byte sniff in `file.service`, which cannot
 * run until the bytes are on disk. Several of these tests assert that
 * division explicitly, so nobody "fixes" the pre-screen into a gate later.
 */

/** Every upload now carries a folder; these specs use the image one. */
const FOLDER = "product_images";

const buildApp = (handler?: (req: Request, res: Response) => void): Express => {
  const app = express();
  app.post(
    "/upload",
    uploadSingleFile,
    handleMulterError,
    cleanupUpload,
    validate(fileValidation.uploadFile),
    handler ??
      ((req: Request, res: Response) => {
        res.status(201).send({
          tempPath: req.file?.path ?? null,
          declaredMime: req.file?.mimetype ?? null,
          folder: req.body.folder ?? null,
          size: req.file ? fs.statSync(req.file.path).size : null,
        });
      }),
  );
  app.use(errorConverter, errorHandler);
  return app;
};

describe("upload middleware", () => {
  describe("extension pre-screen", () => {
    it("lets a plausible extension through to the service", async () => {
      const res = await request(buildApp())
        .post("/upload")
        .field("folder", FOLDER)
        .attach("file", samples.jpeg, {
          filename: "hoodie.jpg",
          contentType: "image/jpeg",
        });

      expect(res.status).toBe(201);
      expect(res.body.size).toBe(samples.jpeg.length);
    });

    it("rejects a disallowed extension with 415", async () => {
      const res = await request(buildApp())
        .post("/upload")
        .field("folder", FOLDER)
        .attach("file", samples.csv, {
          filename: "prices.csv",
          contentType: "text/csv",
        });

      expect(res.status).toBe(415);
      expect(res.body.message).toMatch(/Unsupported file type/);
    });

    it("allows a file with NO extension through — browsers send 'blob'", async () => {
      // canvas.toBlob(), clipboard paste and several mobile pickers produce a
      // filename with no extension. Refusing those would reject valid PNGs
      // before the real check ever saw them.
      const res = await request(buildApp())
        .post("/upload")
        .field("folder", FOLDER)
        .attach("file", samples.png, {
          filename: "blob",
          contentType: "image/png",
        });

      expect(res.status).toBe(201);
    });

    it("lets a renamed SVG past — by design; the sniffer refuses it later", async () => {
      const res = await request(buildApp())
        .post("/upload")
        .field("folder", FOLDER)
        .attach("file", samples.svg, {
          filename: "photo.jpg",
          contentType: "image/jpeg",
        });

      expect(res.status).toBe(201);
    });
  });

  describe("limits, translated into this app's error shape", () => {
    it("answers 413 for an oversized file, not a masked 500", async () => {
      // Without handleMulterError a MulterError carries no statusCode, so
      // errorConverter classes it 500 and production masks it entirely.
      const cap = config.STORAGE.MAX_VIDEO_MB * 1024 * 1024;
      const res = await request(buildApp())
        .post("/upload")
        .field("folder", FOLDER)
        .attach("file", padded("mp4", cap + 1024), {
          filename: "big.mp4",
          contentType: "video/mp4",
        });

      expect(res.status).toBe(413);
      expect(res.body.message).toBe("File is too large.");
    });

    it("answers 400 for more than one file", async () => {
      const res = await request(buildApp())
        .post("/upload")
        .field("folder", FOLDER)
        .attach("file", samples.jpeg, {
          filename: "a.jpg",
          contentType: "image/jpeg",
        })
        .attach("file", samples.png, {
          filename: "b.png",
          contentType: "image/png",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Only one file/);
    });

    it("answers 400 for the wrong field name", async () => {
      const res = await request(buildApp())
        .post("/upload")
        .field("folder", FOLDER)
        .attach("image", samples.jpeg, {
          filename: "a.jpg",
          contentType: "image/jpeg",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Unexpected file field/);
    });
  });

  describe("the folder field", () => {
    it("reaches the handler, because multer parses the body before validate", () => {
      // The ordering the whole route depends on: `folder` is a multipart
      // text field, so it does not exist until multer has run.
      return request(buildApp())
        .post("/upload")
        .field("folder", FOLDER)
        .attach("file", samples.jpeg, {
          filename: "a.jpg",
          contentType: "image/jpeg",
        })
        .expect(201)
        .expect((res) => expect(res.body.folder).toBe(FOLDER));
    });

    it("is required", async () => {
      const res = await request(buildApp())
        .post("/upload")
        .attach("file", samples.jpeg, {
          filename: "a.jpg",
          contentType: "image/jpeg",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/folder/);
    });

    it("refuses a folder outside the allowlist", async () => {
      const res = await request(buildApp())
        .post("/upload")
        .field("folder", "../../etc")
        .attach("file", samples.jpeg, {
          filename: "a.jpg",
          contentType: "image/jpeg",
        });

      expect(res.status).toBe(400);
    });
  });

  describe("spooling", () => {
    it("writes to UPLOAD_TMP_DIR with no extension on the temp name", async () => {
      const res = await request(buildApp())
        .post("/upload")
        .field("folder", FOLDER)
        .attach("file", samples.jpeg, {
          filename: "hoodie.jpg",
          contentType: "image/jpeg",
        });

      expect(path.dirname(res.body.tempPath)).toBe(
        path.resolve(config.STORAGE.TMP_DIR),
      );
      // No extension, so nothing downstream can be tempted to infer a type.
      expect(path.extname(res.body.tempPath)).toBe("");
    });
  });

  describe("cleanupUpload", () => {
    it("removes the spooled file when a later middleware rejects", async () => {
      const before = spooledFiles();

      // An extra text field trips `validate`, AFTER multer has written the
      // whole file. Without cleanupUpload it would sit there forever.
      const res = await request(buildApp())
        .post("/upload")
        .field("folder", FOLDER)
        .field("productId", "abc-123")
        .attach("file", samples.jpeg, {
          filename: "a.jpg",
          contentType: "image/jpeg",
        });

      expect(res.status).toBe(400);
      await new Promise((r) => setTimeout(r, 100));
      expect(spooledFiles().filter((f) => !before.includes(f))).toEqual([]);
    });

    it("removes the spooled file when the handler throws", async () => {
      const before = spooledFiles();
      const app = buildApp(() => {
        throw new Error("handler blew up");
      });

      await request(app)
        .post("/upload")
        .field("folder", FOLDER)
        .attach("file", samples.jpeg, {
          filename: "a.jpg",
          contentType: "image/jpeg",
        });

      await new Promise((r) => setTimeout(r, 100));
      expect(spooledFiles().filter((f) => !before.includes(f))).toEqual([]);
    });
  });
});
