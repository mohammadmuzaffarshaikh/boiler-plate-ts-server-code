import fs from "node:fs";
import crypto from "node:crypto";
import request from "supertest";
import httpStatus from "http-status";
import { Role } from "@prisma/client";
import app from "../../src/app";
import * as fileService from "../../src/services/file.service";
import {
  assertDatabaseReachable,
  createTestUser,
  cleanupUsers,
  cleanupFiles,
  disconnect,
  TEST_PASSWORD,
} from "../helpers/db";
import { bearerFor } from "../helpers/auth";
import { startR2Stub, R2Stub } from "../helpers/r2-stub";
import * as r2Client from "../../src/config/r2-client";
import { samples, writeTempFile } from "../helpers/samples";

/**
 * An upload reads the spooled file once, not twice.
 *
 * `createFile` used to stream the whole temp file through an MD5 to produce
 * the `Content-MD5` header, and then stream the whole temp file again to R2.
 * At the 95 MB video cap that is 190 MB of disk I/O per upload, and the
 * second pass has to finish before the PUT can even begin.
 *
 * The digest cannot be folded into the upload — R2 checks the body against a
 * header, so it has to exist first. It can be folded into the pass that was
 * already happening: multer writing the bytes to disk. These specs pin both
 * halves — that the digest produced that way is correct, and that the second
 * read is genuinely gone rather than merely moved.
 */
describe("upload reads the spooled file once", () => {
  let stub: R2Stub;
  const userIds: string[] = [];
  const fileIds: string[] = [];

  beforeAll(async () => {
    await assertDatabaseReachable();
    stub = await startR2Stub();
  });

  afterAll(async () => {
    await cleanupFiles(fileIds);
    await cleanupUsers(userIds);
    await disconnect();
    await stub.close();
  });

  beforeEach(() => {
    stub.install();
  });

  const staffToken = async (): Promise<string> => {
    const user = await createTestUser(Role.STAFF);
    userIds.push(user.id);
    return bearerFor(app, user.email, TEST_PASSWORD);
  };

  const md5Of = (bytes: Buffer): string =>
    crypto.createHash("md5").update(bytes).digest("base64");

  describe("over HTTP", () => {
    it("uploads successfully with the digest computed during the spool write", async () => {
      // R2 verifies Content-MD5 and refuses a mismatch, so a wrong digest
      // from the new code path fails here rather than silently.
      const token = await staffToken();

      const res = await request(app)
        .post("/api/app/files")
        .set("Authorization", `Bearer ${token}`)
        .field("folder", "product_images")
        .attach("file", samples.jpeg, "photo.jpg")
        .expect(httpStatus.CREATED);

      fileIds.push(res.body.data.file.id);
      expect(res.body.data.file.key).toContain("product_images/");
    });

    it("reads the temp file once for the body, not twice", async () => {
      // THE REGRESSION, measured where it lives. Before the change this
      // counted two opens of the same spooled path: one for the MD5, one
      // for the PUT.
      const token = await staffToken();
      const opened: string[] = [];
      const real = fs.createReadStream;
      const spy = jest
        .spyOn(fs, "createReadStream")
        .mockImplementation((path, options?) => {
          if (typeof path === "string" && path.includes("upload-")) {
            opened.push(path);
          }
          return real(path, options as never);
        });

      try {
        const res = await request(app)
          .post("/api/app/files")
          .set("Authorization", `Bearer ${token}`)
          .field("folder", "product_images")
          .attach("file", samples.jpeg, "photo.jpg")
          .expect(httpStatus.CREATED);

        fileIds.push(res.body.data.file.id);
      } finally {
        spy.mockRestore();
      }

      expect(opened).toHaveLength(1);
    });
  });

  describe("the digest itself", () => {
    it("matches a hash of the bytes that were sent", async () => {
      // The spool writer hashes chunk by chunk through a Transform. A
      // transform that dropped or reordered a chunk would still produce a
      // valid-looking base64 digest — and an unusable file.
      const token = await staffToken();
      const bytes = samples.jpeg;

      const res = await request(app)
        .post("/api/app/files")
        .set("Authorization", `Bearer ${token}`)
        .field("folder", "product_images")
        .attach("file", bytes, "photo.jpg")
        .expect(httpStatus.CREATED);

      fileIds.push(res.body.data.file.id);

      const stored = stub.objects.get(res.body.data.file.key);
      expect(stored).toBeDefined();
      expect(md5Of(stored!)).toBe(md5Of(bytes));
    });

    it("writes the bytes through unchanged", async () => {
      const token = await staffToken();

      const res = await request(app)
        .post("/api/app/files")
        .set("Authorization", `Bearer ${token}`)
        .field("folder", "product_images")
        .attach("file", samples.jpeg, "photo.jpg")
        .expect(httpStatus.CREATED);

      fileIds.push(res.body.data.file.id);

      const stored = stub.objects.get(res.body.data.file.key);
      expect(stored!.equals(samples.jpeg)).toBe(true);
      expect(res.body.data.file.size).toBe(samples.jpeg.length);
    });
  });

  describe("the fallback, for callers that are not the upload route", () => {
    it("still computes the digest when none is supplied", async () => {
      // `createFile` is a service; it must not depend on a middleware two
      // layers up having run. This is the slow path on purpose.
      const file = await fileService.createFile({
        tempPath: writeTempFile(samples.jpeg),
        originalName: "a.jpg",
        folder: "product_images",
      });
      fileIds.push(file.id);

      const stored = stub.objects.get(file.key);
      expect(stored).toBeDefined();
      expect(md5Of(stored!)).toBe(md5Of(samples.jpeg));
    });

    it("produces the same object either way", async () => {
      const supplied = await fileService.createFile({
        tempPath: writeTempFile(samples.jpeg),
        originalName: "a.jpg",
        folder: "product_images",
        contentMd5: md5Of(samples.jpeg),
      });
      fileIds.push(supplied.id);

      const derived = await fileService.createFile({
        tempPath: writeTempFile(samples.jpeg),
        originalName: "a.jpg",
        folder: "product_images",
      });
      fileIds.push(derived.id);

      expect(supplied.etag).toBe(derived.etag);
      expect(supplied.size).toBe(derived.size);
    });

    it("reads the file once when the digest is supplied", async () => {
      const opened: string[] = [];
      const real = fs.createReadStream;
      const spy = jest
        .spyOn(fs, "createReadStream")
        .mockImplementation((path, options?) => {
          if (typeof path === "string") opened.push(path);
          return real(path, options as never);
        });

      try {
        const file = await fileService.createFile({
          tempPath: writeTempFile(samples.jpeg),
          originalName: "a.jpg",
          folder: "product_images",
          contentMd5: md5Of(samples.jpeg),
        });
        fileIds.push(file.id);
      } finally {
        spy.mockRestore();
      }

      expect(opened).toHaveLength(1);
    });
  });
  describe("when the PUT never consumes the body", () => {
    /**
     * A LATENT LEAK THIS CHANGE SURFACED.
     *
     * The read stream for the body was built eagerly, in `putObject`'s
     * argument list. `putObject` can throw before it touches the body at all
     * — storage switched off, a credential refused — and the stream was then
     * left open with nobody to consume or destroy it. `createFile`'s
     * `finally` unlinks the spool file immediately afterwards, so the
     * stream's own `open` lands against a path that no longer exists and
     * reports it as an `error` event with no listener. Node escalates that
     * to an unhandled rejection, which takes the process down rather than
     * answering 503.
     *
     * It was invisible for a reason worth recording: the digest used to be
     * awaited inside that same object literal, and that await yielded the
     * event loop for just long enough that the stream's `open` landed while
     * the file still existed. Removing the second read removed the accidental
     * delay, and the latent bug became a reproducible crash.
     */
    it("rejects with the storage failure, not a stream error", async () => {
      jest.spyOn(r2Client, "isStorageEnabled").mockReturnValue(false);

      await expect(
        fileService.createFile({
          tempPath: writeTempFile(samples.jpeg),
          originalName: "a.jpg",
          folder: "product_images",
          contentMd5: md5Of(samples.jpeg),
        }),
      ).rejects.toThrow(/storage is not configured/i);
    });

    it("still removes the spooled file", async () => {
      jest.spyOn(r2Client, "isStorageEnabled").mockReturnValue(false);
      const tempPath = writeTempFile(samples.jpeg);

      await expect(
        fileService.createFile({
          tempPath,
          originalName: "a.jpg",
          folder: "product_images",
          contentMd5: md5Of(samples.jpeg),
        }),
      ).rejects.toThrow();

      expect(fs.existsSync(tempPath)).toBe(false);
    });

    it("answers 503 over HTTP rather than crashing", async () => {
      // The end-to-end shape of the same thing.
      const token = await staffToken();
      jest.spyOn(r2Client, "isStorageEnabled").mockReturnValue(false);

      await request(app)
        .post("/api/app/files")
        .set("Authorization", `Bearer ${token}`)
        .field("folder", "product_images")
        .attach("file", samples.jpeg, "photo.jpg")
        .expect(httpStatus.SERVICE_UNAVAILABLE);
    });
  });
});
