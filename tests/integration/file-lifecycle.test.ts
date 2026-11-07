import fs from "node:fs";
import { FileStatus } from "@prisma/client";
import * as fileService from "../../src/services/file.service";
import * as r2Client from "../../src/config/r2-client";
import { cleanupFiles as cleanupFilesJob } from "../../src/jobs/file-cleanup.job";
import config from "../../src/config/config";
import {
  prisma,
  assertDatabaseReachable,
  createTestUser,
  cleanupUsers,
  cleanupFiles,
  disconnect,
} from "../helpers/db";
import { startR2Stub, R2Stub } from "../helpers/r2-stub";
import { samples, writeTempFile, spooledFiles } from "../helpers/samples";
import { allKeyPrefixes, UploadFolder } from "../../src/config/constants";

/**
 * The file lifecycle: upload, attach, sweep, delete, orphan reporting.
 *
 * Service level rather than HTTP, because the interesting behaviour is the
 * ordering between Postgres and object storage — specifically that a crash
 * can never leave a live row pointing at an object that is already gone.
 */
describe("file lifecycle", () => {
  let stub: R2Stub;
  const fileIds: string[] = [];
  const userIds: string[] = [];
  const HOUR = 60 * 60 * 1000;

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

  const create = async (
    bytes: Buffer = samples.jpeg,
    originalName = "a.jpg",
    folder: UploadFolder = "product_images",
  ) => {
    const file = await fileService.createFile({
      tempPath: writeTempFile(bytes),
      originalName,
      folder,
    });
    fileIds.push(file.id);
    return file;
  };

  /** Backdate a row so the sweep considers it, without waiting a day. */
  const age = (id: string, hours: number) =>
    prisma.file.update({
      where: { id },
      data: { createdAt: new Date(Date.now() - hours * HOUR) },
    });

  describe("createFile", () => {
    it("writes the row from the bytes, not from the request", async () => {
      const user = await createTestUser();
      userIds.push(user.id);

      const file = await fileService.createFile({
        tempPath: writeTempFile(samples.png),
        originalName: "../../etc/passwd.png",
        folder: "product_images",
        uploadedById: user.id,
      });
      fileIds.push(file.id);

      expect(file.mimeType).toBe("image/png");
      expect(file.size).toBe(samples.png.length);
      expect(Number.isInteger(file.size)).toBe(true);
      expect(file.status).toBe(FileStatus.UNUSED);
      expect(file.uploadedById).toBe(user.id);
      expect(file.folder).toBe("product_images");
      // The traversal is gone from BOTH the stored name and the key: the
      // name keeps only its last segment, and the slug can hold nothing but
      // [a-z0-9-], so there is no `.` or `/` left to walk with.
      expect(file.originalName).toBe("passwd.png");
      expect(file.key).toMatch(/^product_images\/passwd-[0-9a-f-]{36}\.png$/);
      expect(file.url).toBe(`${config.STORAGE.PUBLIC_URL}/${file.key}`);
      expect(stub.objects.has(file.key)).toBe(true);
    });

    it("puts each folder under its own prefix", async () => {
      const cases: [UploadFolder, Buffer, string][] = [
        ["product_images", samples.jpeg, "jpg"],
        ["product_videos", samples.mp4, "mp4"],
        ["documents", samples.docx, "docx"],
        ["profile_images", samples.png, "png"],
      ];

      for (const [folder, bytes, extension] of cases) {
        const file = await create(
          bytes,
          `Blue Hoodie Front.${extension}`,
          folder,
        );
        expect(file.folder).toBe(folder);
        expect(file.key).toMatch(
          new RegExp(
            `^${folder}/blue-hoodie-front-[0-9a-f-]{36}\\.${extension}$`,
          ),
        );
      }
    });

    it("refuses a file the folder does not take", async () => {
      // Detection succeeds — it is a perfectly good MP4. The folder is what
      // says no, which is the whole reason the folder decides the policy.
      const tempPath = writeTempFile(samples.mp4);
      await expect(
        fileService.createFile({
          tempPath,
          originalName: "clip.mp4",
          folder: "product_images",
        }),
      ).rejects.toMatchObject({ statusCode: 415 });
      expect(fs.existsSync(tempPath)).toBe(false);
    });

    it("refuses a folder that is not on the allowlist, even past validate", async () => {
      // The service re-checks rather than trusting a middleware two layers
      // up to still be mounted. Without this the string would be
      // interpolated straight into the object key.
      const tempPath = writeTempFile(samples.jpeg);
      await expect(
        fileService.createFile({
          tempPath,
          originalName: "a.jpg",
          folder: "../../etc" as UploadFolder,
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(fs.existsSync(tempPath)).toBe(false);
    });

    it("stores an Office document with the sniffed type, not the sent one", async () => {
      const file = await create(
        samples.xlsx,
        "Q4 price list.xlsx",
        "documents",
      );
      expect(file.mimeType).toBe(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      expect(file.key).toMatch(
        /^documents\/q4-price-list-[0-9a-f-]{36}\.xlsx$/,
      );
    });

    it("refuses a macro-enabled document that passes as a .docx", async () => {
      const tempPath = writeTempFile(samples.docm);
      await expect(
        fileService.createFile({
          tempPath,
          originalName: "invoice.docx",
          folder: "documents",
        }),
      ).rejects.toMatchObject({ statusCode: 415 });
    });

    it("falls back to the uuid alone when the name slugs to nothing", async () => {
      const file = await create(samples.png, "размеры.png", "product_images");
      expect(file.key).toMatch(/^product_images\/[0-9a-f-]{36}\.png$/);
      expect(file.originalName).toBe("размеры.png");
    });

    it("always removes the spooled file, even when R2 refuses", async () => {
      const before = spooledFiles();
      const tempPath = writeTempFile(samples.jpeg);
      stub.failNext(500, "<Error/>", 10);

      await expect(
        fileService.createFile({
          tempPath,
          originalName: "a.jpg",
          folder: "product_images",
        }),
      ).rejects.toThrow();

      expect(fs.existsSync(tempPath)).toBe(false);
      expect(spooledFiles().filter((f) => !before.includes(f))).toEqual([]);
      stub.reset();
      stub.install();
    });

    it("removes the spooled file when the type is rejected", async () => {
      const tempPath = writeTempFile(samples.svg);

      await expect(
        fileService.createFile({
          tempPath,
          originalName: "x.jpg",
          folder: "product_images",
        }),
      ).rejects.toMatchObject({ statusCode: 415 });

      expect(fs.existsSync(tempPath)).toBe(false);
    });
  });

  describe("attach / detach", () => {
    it("moves a file between UNUSED and IN_USE", async () => {
      const file = await create();

      expect(await fileService.markFilesInUse([file.id])).toBe(1);
      expect((await fileService.getFileById(file.id))!.status).toBe(
        FileStatus.IN_USE,
      );

      expect(await fileService.markFilesUnused([file.id])).toBe(1);
      expect((await fileService.getFileById(file.id))!.status).toBe(
        FileStatus.UNUSED,
      );
    });

    it("will not resurrect a file that is already being deleted", async () => {
      const file = await create();
      await prisma.file.update({
        where: { id: file.id },
        data: { status: FileStatus.PENDING_DELETE },
      });

      expect(await fileService.markFilesInUse([file.id])).toBe(0);
      expect((await fileService.getFileById(file.id))!.status).toBe(
        FileStatus.PENDING_DELETE,
      );
    });

    it("treats an empty id list as a no-op", async () => {
      expect(await fileService.markFilesInUse([])).toBe(0);
      expect(await fileService.markFilesUnused([])).toBe(0);
    });
  });

  describe("deleteFile", () => {
    it("removes the object and the row", async () => {
      const file = await create();

      await fileService.deleteFile(file.id);

      expect(await fileService.getFileById(file.id)).toBeNull();
      expect(stub.objects.has(file.key)).toBe(false);
    });

    it("answers 404 rather than 500 when the row is already gone", async () => {
      const file = await create();
      await fileService.deleteFile(file.id);

      // Two people deleting at once both get past the lookup; `update` would
      // raise Prisma's P2025 here, which errorConverter classes as a 500.
      await expect(fileService.deleteFile(file.id)).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it("refuses before touching the row when storage is off", async () => {
      const file = await create();
      jest.spyOn(r2Client, "isStorageEnabled").mockReturnValue(false);

      await expect(fileService.deleteFile(file.id)).rejects.toMatchObject({
        statusCode: 503,
      });

      // Had the status been flipped first, the row would be stuck in
      // PENDING_DELETE: the request fails and the sweep that would finish it
      // also returns early while storage is off.
      expect((await fileService.getFileById(file.id))!.status).toBe(
        FileStatus.UNUSED,
      );
    });
  });

  describe("the nightly sweep", () => {
    it("spares UNUSED files inside the grace window", async () => {
      const fresh = await create();

      await fileService.deleteUnusedFiles();

      expect(await fileService.getFileById(fresh.id)).not.toBeNull();
    });

    it("deletes UNUSED files past the grace window, object included", async () => {
      const stale = await create();
      await age(stale.id, config.STORAGE.UNUSED_GRACE_HOURS + 1);

      const result = await fileService.deleteUnusedFiles();

      expect(result.failed).toBe(0);
      expect(await fileService.getFileById(stale.id)).toBeNull();
      expect(stub.objects.has(stale.key)).toBe(false);
    });

    it("never sweeps IN_USE files, however old", async () => {
      const inUse = await create();
      await fileService.markFilesInUse([inUse.id]);
      await age(inUse.id, config.STORAGE.UNUSED_GRACE_HOURS * 10);

      await fileService.deleteUnusedFiles();

      expect(await fileService.getFileById(inUse.id)).not.toBeNull();
    });

    it("finishes a delete that crashed partway, regardless of age", async () => {
      const crashed = await create();
      // Exactly the state a process killed between the status flip and the
      // object delete would leave behind.
      await prisma.file.update({
        where: { id: crashed.id },
        data: { status: FileStatus.PENDING_DELETE },
      });

      await fileService.deleteUnusedFiles();

      expect(await fileService.getFileById(crashed.id)).toBeNull();
      expect(stub.objects.has(crashed.key)).toBe(false);
    });

    it("counts a failure instead of abandoning the batch", async () => {
      const doomed = await create();
      await age(doomed.id, config.STORAGE.UNUSED_GRACE_HOURS + 1);
      stub.failNext(500, "<Error/>", 10);

      const result = await fileService.deleteUnusedFiles();

      expect(result.failed).toBeGreaterThan(0);
      // Left PENDING_DELETE so the next run retries it.
      expect((await fileService.getFileById(doomed.id))!.status).toBe(
        FileStatus.PENDING_DELETE,
      );
      stub.reset();
      stub.install();
    });
  });

  describe("orphan scan", () => {
    it("reports an object with no row, and does not delete it", async () => {
      const orphanKey = `product_images/${Date.now()}-orphan.jpg`;
      stub.objects.set(orphanKey, samples.jpeg);

      const orphans = await fileService.findOrphanedObjects();

      expect(orphans).toContain(orphanKey);
      // Deleting unattended would destroy anything a human put there by hand.
      expect(stub.objects.has(orphanKey)).toBe(true);
    });

    it("does not flag files that do have a row", async () => {
      const known = await create();
      const orphans = await fileService.findOrphanedObjects();
      expect(orphans).not.toContain(known.key);
    });

    it("walks every folder prefix, not just the two the code used to write", async () => {
      // The prefixes changed with the folder field. A sweep that still
      // listed "products/" would silently stop seeing orphans the moment
      // the first profile image was uploaded.
      const keys = allKeyPrefixes().map(
        (prefix) => `${prefix}/${Date.now()}-${prefix}-orphan.bin`,
      );
      for (const key of keys) stub.objects.set(key, samples.jpeg);

      const orphans = await fileService.findOrphanedObjects();
      for (const key of keys) expect(orphans).toContain(key);
    });
  });

  describe("queryFiles", () => {
    it("paginates", async () => {
      await create();
      await create();

      const page = await fileService.queryFiles({ page: 1, limit: 1 });

      expect(page.results).toHaveLength(1);
      expect(page.limit).toBe(1);
      expect(page.totalResults).toBeGreaterThanOrEqual(2);
      expect(page.totalPages).toBe(Math.ceil(page.totalResults / 1));
    });

    it("filters by status", async () => {
      const file = await create();
      await fileService.markFilesInUse([file.id]);

      const page = await fileService.queryFiles({ status: FileStatus.IN_USE });

      expect(page.results.every((f) => f.status === FileStatus.IN_USE)).toBe(
        true,
      );
      expect(page.results.map((f) => f.id)).toContain(file.id);
    });

    it("clamps an absurd limit", async () => {
      const page = await fileService.queryFiles({ limit: 10_000 });
      expect(page.limit).toBeLessThanOrEqual(100);
    });
  });

  describe("the cron job wrapper", () => {
    it("does nothing when storage is off", async () => {
      jest.spyOn(r2Client, "isStorageEnabled").mockReturnValue(false);
      await expect(cleanupFilesJob()).resolves.toBeUndefined();
    });

    it("survives a failing sweep and still runs the orphan scan", async () => {
      jest
        .spyOn(fileService, "deleteUnusedFiles")
        .mockRejectedValue(new Error("postgres went away"));
      const scan = jest
        .spyOn(fileService, "findOrphanedObjects")
        .mockResolvedValue([]);

      // A throwing half must not abandon the other half, nor escape the job.
      await expect(cleanupFilesJob()).resolves.toBeUndefined();
      expect(scan).toHaveBeenCalled();
    });
  });
});
