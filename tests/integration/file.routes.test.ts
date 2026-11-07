import request from "supertest";
import httpStatus from "http-status";
import { FileStatus, Role } from "@prisma/client";
import app from "../../src/app";
import * as r2Client from "../../src/config/r2-client";
import {
  prisma,
  assertDatabaseReachable,
  createTestUser,
  cleanupUsers,
  disconnect,
  TEST_PASSWORD,
} from "../helpers/db";
import { accessTokenWithRole } from "../helpers/db";
import { bearerFor } from "../helpers/auth";
import { startR2Stub, R2Stub } from "../helpers/r2-stub";
import { samples, spooledFiles } from "../helpers/samples";

/**
 * /api/app/files over HTTP, against a real database and the local R2 stub.
 *
 * The access rule under test: any STAFF or ADMIN may upload, read and delete
 * ANY file, including one uploaded by somebody else — product media is shared
 * catalogue content, not personal property.
 *
 * Both roles `users` can hold now pass that rule, so there is no longer a
 * real account that gets a 403 here. Shoppers are not a lesser role on this
 * API, they are a different table on a different namespace (/api/store) with
 * a different signing secret. The negative case is kept alive by a token
 * carrying a role with no rights entry, which is what proves the rights
 * lookup actually runs on these routes rather than being a decoration on the
 * route table.
 */
describe("file routes", () => {
  let stub: R2Stub;
  const userIds: string[] = [];
  const tokens: Record<string, string> = {};

  /**
   * A staff member with a bearer token, obtained the way a native client
   * does: login with a PKCE challenge, then trade the authorization code.
   * A browser login returns no tokens in its body (docs/decisions.md §28).
   */
  const login = async (role: Role) => {
    const user = await createTestUser(role);
    userIds.push(user.id);

    return { user, token: await bearerFor(app, user.email, TEST_PASSWORD) };
  };

  beforeAll(async () => {
    await assertDatabaseReachable();
    stub = await startR2Stub();
    for (const role of [Role.STAFF, Role.ADMIN]) {
      tokens[role] = (await login(role)).token;
    }
  });

  afterAll(async () => {
    await cleanupUsers(userIds);
    await disconnect();
    await stub.close();
  });

  beforeEach(() => {
    stub.install();
  });

  const upload = (
    token: string,
    bytes: Buffer,
    filename: string,
    contentType: string,
    folder = "product_images",
  ) =>
    request(app)
      .post("/api/app/files")
      .set("Authorization", `Bearer ${token}`)
      .field("folder", folder)
      .attach("file", bytes, { filename, contentType });

  describe("authentication", () => {
    it.each([
      ["get", "/api/app/files"],
      ["post", "/api/app/files"],
      ["get", "/api/app/files/8f1b1f6e-0000-4000-8000-000000000000"],
      ["patch", "/api/app/files/8f1b1f6e-0000-4000-8000-000000000000/status"],
      ["delete", "/api/app/files/8f1b1f6e-0000-4000-8000-000000000000"],
    ])("%s %s requires a token", async (method, path) => {
      const res = await (request(app) as any)[method](path);
      expect(res.status).toBe(httpStatus.UNAUTHORIZED);
    });
  });

  describe("role matrix", () => {
    it("a token whose role holds no file rights is refused on every route", async () => {
      // CUSTOMER was removed from the enum when `users` became the staff
      // table. `role` is still carried in the token rather than read back
      // from the row, so a token minted before that change is signed,
      // unexpired and names a role `roleRights` cannot resolve. It must get
      // nothing here.
      //
      // The session behind it is real. Access tokens are bound to a
      // `sessions` row now, and a fabricated one is refused by the strategy
      // with a 401 before `roleRights` is consulted — which would turn this
      // into a spec about session binding instead of about rights.
      const stale = await createTestUser(Role.STAFF);
      userIds.push(stale.id);
      const token = await accessTokenWithRole(stale, "CUSTOMER" as Role);

      await request(app)
        .get("/api/app/files")
        .set("Authorization", `Bearer ${token}`)
        .expect(httpStatus.FORBIDDEN);
      await upload(token, samples.jpeg, "a.jpg", "image/jpeg").expect(
        httpStatus.FORBIDDEN,
      );
      await request(app)
        .delete("/api/app/files/8f1b1f6e-0000-4000-8000-000000000000")
        .set("Authorization", `Bearer ${token}`)
        .expect(httpStatus.FORBIDDEN);
    });

    it.each([Role.STAFF, Role.ADMIN])("%s can list files", async (role) => {
      const res = await request(app)
        .get("/api/app/files")
        .set("Authorization", `Bearer ${tokens[role]}`);

      expect(res.status).toBe(httpStatus.OK);
      expect(res.body.data).toMatchObject({
        page: 1,
        limit: expect.any(Number),
        totalPages: expect.any(Number),
        totalResults: expect.any(Number),
      });
      expect(Array.isArray(res.body.data.files)).toBe(true);
    });
  });

  describe("POST /api/app/files", () => {
    it("stores a JPEG and records it", async () => {
      const res = await upload(
        tokens[Role.STAFF]!,
        samples.jpeg,
        "hoodie.jpg",
        "image/jpeg",
      );

      expect(res.status).toBe(httpStatus.CREATED);
      const file = res.body.data.file;
      await prisma.file.deleteMany({ where: { id: file.id } });

      expect(file).toMatchObject({
        mimeType: "image/jpeg",
        size: samples.jpeg.length,
        originalName: "hoodie.jpg",
        folder: "product_images",
        status: FileStatus.UNUSED,
      });
      // The api repo this was ported from read the ETag off the wrong object
      // and stored undefined every time.
      expect(file.etag).toEqual(expect.any(String));
      // The key is <folder>/<slug>-<uuid>.<ext>. The folder is an
      // allowlist lookup, the extension comes from the sniffed type, and
      // the slug is the filename reduced to [a-z0-9-] — so the request
      // influences how the key reads but never its shape.
      expect(file.key).toMatch(/^product_images\/hoodie-[0-9a-f-]{36}\.jpg$/);
      expect(stub.objects.has(file.key)).toBe(true);
    });

    it("refuses an SVG renamed to .jpg — the rename attack", async () => {
      const res = await upload(
        tokens[Role.STAFF]!,
        samples.svg,
        "photo.jpg",
        "image/jpeg",
      );

      expect(res.status).toBe(httpStatus.UNSUPPORTED_MEDIA_TYPE);
      expect(res.body.message).toMatch(/Unrecognised file type/);
    });

    it("refuses a PDF in product_images (policy, not detection)", async () => {
      const res = await upload(
        tokens[Role.STAFF]!,
        samples.pdf,
        "spec.pdf",
        "application/pdf",
      );

      expect(res.status).toBe(httpStatus.UNSUPPORTED_MEDIA_TYPE);
      expect(res.body.message).toMatch(/not accepted in "product_images"/);
    });

    it("stores the same PDF once it is sent to documents", async () => {
      const res = await upload(
        tokens[Role.STAFF]!,
        samples.pdf,
        "Size guide.pdf",
        "application/pdf",
        "documents",
      );

      expect(res.status).toBe(httpStatus.CREATED);
      const file = res.body.data.file;
      await prisma.file.deleteMany({ where: { id: file.id } });

      expect(file.folder).toBe("documents");
      expect(file.key).toMatch(/^documents\/size-guide-[0-9a-f-]{36}\.pdf$/);
    });

    it.each([
      [
        "docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ],
      [
        "xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ],
      ["doc", "application/msword"],
      ["xls", "application/vnd.ms-excel"],
    ] as const)("accepts a .%s in documents", async (name, mimeType) => {
      const res = await upload(
        tokens[Role.STAFF]!,
        samples[name],
        `report.${name}`,
        // Deliberately the wrong declared type. It is ignored.
        "application/octet-stream",
        "documents",
      );

      expect(res.status).toBe(httpStatus.CREATED);
      const file = res.body.data.file;
      await prisma.file.deleteMany({ where: { id: file.id } });

      expect(file.mimeType).toBe(mimeType);
      expect(file.key.endsWith(`.${name}`)).toBe(true);
    });

    it("refuses a plain archive renamed to .docx", async () => {
      const res = await upload(
        tokens[Role.STAFF]!,
        samples.zipArchive,
        "report.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "documents",
      );

      expect(res.status).toBe(httpStatus.UNSUPPORTED_MEDIA_TYPE);
      expect(res.body.message).toMatch(/Unrecognised file type/);
    });

    it("refuses a macro-enabled document", async () => {
      const res = await upload(
        tokens[Role.STAFF]!,
        samples.docm,
        "invoice.docx",
        "application/octet-stream",
        "documents",
      );

      expect(res.status).toBe(httpStatus.UNSUPPORTED_MEDIA_TYPE);
    });

    it("routes a video to product_videos and refuses it in product_images", async () => {
      const refused = await upload(
        tokens[Role.STAFF]!,
        samples.mp4,
        "clip.mp4",
        "video/mp4",
      );
      expect(refused.status).toBe(httpStatus.UNSUPPORTED_MEDIA_TYPE);

      const res = await upload(
        tokens[Role.STAFF]!,
        samples.mp4,
        "Product Clip.mp4",
        "video/mp4",
        "product_videos",
      );
      expect(res.status).toBe(httpStatus.CREATED);
      await prisma.file.deleteMany({ where: { id: res.body.data.file.id } });
      expect(res.body.data.file.key).toMatch(
        /^product_videos\/product-clip-[0-9a-f-]{36}\.mp4$/,
      );
    });

    it("stores a sanitised filename and a key with no traversal in it", async () => {
      const res = await upload(
        tokens[Role.STAFF]!,
        samples.png,
        "../../etc/pass wd  .png",
        "image/png",
        "profile_images",
      );

      expect(res.status).toBe(httpStatus.CREATED);
      const file = res.body.data.file;
      await prisma.file.deleteMany({ where: { id: file.id } });

      // The traversal is gone from the stored name, the double space is
      // collapsed, and the trailing space before the extension is kept —
      // it is part of the name, not padding. (Control characters and
      // bidirectional overrides are covered in the unit spec: the
      // multipart encoder mangles them before they reach the server.)
      expect(file.originalName).toBe("pass wd .png");
      expect(file.key).toMatch(/^profile_images\/pass-wd-[0-9a-f-]{36}\.png$/);
    });

    it("requires a folder", async () => {
      const res = await request(app)
        .post("/api/app/files")
        .set("Authorization", `Bearer ${tokens[Role.STAFF]}`)
        .attach("file", samples.jpeg, {
          filename: "a.jpg",
          contentType: "image/jpeg",
        });

      expect(res.status).toBe(httpStatus.BAD_REQUEST);
      expect(res.body.message).toMatch(/folder/);
    });

    it.each(["../../etc", "products", "PRODUCT_IMAGES", "product_images/../x"])(
      "refuses the folder %p",
      async (folder) => {
        const res = await upload(
          tokens[Role.STAFF]!,
          samples.jpeg,
          "a.jpg",
          "image/jpeg",
          folder,
        );
        expect(res.status).toBe(httpStatus.BAD_REQUEST);
      },
    );

    it("refuses an empty file", async () => {
      const res = await upload(
        tokens[Role.STAFF]!,
        Buffer.alloc(0),
        "empty.jpg",
        "image/jpeg",
      );
      expect(res.status).toBe(httpStatus.BAD_REQUEST);
    });

    it("rejects an unexpected form field without leaking the temp file", async () => {
      const before = spooledFiles();

      const res = await request(app)
        .post("/api/app/files")
        .set("Authorization", `Bearer ${tokens[Role.STAFF]}`)
        .field("folder", "product_images")
        .field("productId", "abc")
        .attach("file", samples.jpeg, {
          filename: "a.jpg",
          contentType: "image/jpeg",
        });

      expect(res.status).toBe(httpStatus.BAD_REQUEST);
      await new Promise((r) => setTimeout(r, 100));
      expect(spooledFiles().filter((f) => !before.includes(f))).toEqual([]);
    });

    it("answers 503 when storage is switched off", async () => {
      jest.spyOn(r2Client, "isStorageEnabled").mockReturnValue(false);

      const res = await upload(
        tokens[Role.STAFF]!,
        samples.jpeg,
        "a.jpg",
        "image/jpeg",
      );
      expect(res.status).toBe(httpStatus.SERVICE_UNAVAILABLE);
    });
  });

  describe("lifecycle over HTTP", () => {
    const uploadOne = async (token: string) => {
      const res = await upload(token, samples.png, "img.png", "image/png");
      return res.body.data.file;
    };

    it("attaches and detaches a file", async () => {
      const file = await uploadOne(tokens[Role.STAFF]!);

      const attached = await request(app)
        .patch(`/api/app/files/${file.id}/status`)
        .set("Authorization", `Bearer ${tokens[Role.STAFF]}`)
        .send({ status: FileStatus.IN_USE });
      expect(attached.body.data.file.status).toBe(FileStatus.IN_USE);

      const detached = await request(app)
        .patch(`/api/app/files/${file.id}/status`)
        .set("Authorization", `Bearer ${tokens[Role.ADMIN]}`)
        .send({ status: FileStatus.UNUSED });
      expect(detached.body.data.file.status).toBe(FileStatus.UNUSED);

      await prisma.file.deleteMany({ where: { id: file.id } });
    });

    it("lets a DIFFERENT staff member delete a file", async () => {
      const owner = await login(Role.STAFF);
      const other = await login(Role.STAFF);
      const file = await uploadOne(owner.token);

      await request(app)
        .delete(`/api/app/files/${file.id}`)
        .set("Authorization", `Bearer ${other.token}`)
        .expect(httpStatus.OK);

      expect(
        await prisma.file.findUnique({ where: { id: file.id } }),
      ).toBeNull();
      expect(stub.objects.has(file.key)).toBe(false);
    });

    it("answers 404 when the same file is deleted twice", async () => {
      const file = await uploadOne(tokens[Role.ADMIN]!);

      await request(app)
        .delete(`/api/app/files/${file.id}`)
        .set("Authorization", `Bearer ${tokens[Role.ADMIN]}`)
        .expect(httpStatus.OK);

      // Previously this raised Prisma's P2025 and surfaced as a 500.
      await request(app)
        .delete(`/api/app/files/${file.id}`)
        .set("Authorization", `Bearer ${tokens[Role.ADMIN]}`)
        .expect(httpStatus.NOT_FOUND);
    });
  });

  describe("validation", () => {
    const staff = () => `Bearer ${tokens[Role.STAFF]}`;

    it("rejects a non-uuid id", async () => {
      const res = await request(app)
        .get("/api/app/files/not-a-uuid")
        .set("Authorization", staff());

      expect(res.status).toBe(httpStatus.BAD_REQUEST);
      expect(res.body.message).toMatch(/GUID|uuid/i);
    });

    it("answers 404 for an unknown id", async () => {
      await request(app)
        .get("/api/app/files/8f1b1f6e-0000-4000-8000-000000000000")
        .set("Authorization", staff())
        .expect(httpStatus.NOT_FOUND);
    });

    it("refuses PENDING_DELETE as a settable status", async () => {
      // It is an internal step of the delete path. Parking a row in it would
      // have the nightly sweep destroy the object with no delete requested.
      const res = await request(app)
        .patch("/api/app/files/8f1b1f6e-0000-4000-8000-000000000000/status")
        .set("Authorization", staff())
        .send({ status: FileStatus.PENDING_DELETE });

      expect(res.status).toBe(httpStatus.BAD_REQUEST);
    });

    it("filters the listing by folder", async () => {
      const uploaded = await upload(
        tokens[Role.STAFF]!,
        samples.png,
        "avatar.png",
        "image/png",
        "profile_images",
      );
      const file = uploaded.body.data.file;

      const res = await request(app)
        .get("/api/app/files?folder=profile_images&limit=100")
        .set("Authorization", staff());

      expect(res.status).toBe(httpStatus.OK);
      expect(res.body.data.files.map((f: { id: string }) => f.id)).toContain(
        file.id,
      );
      expect(
        res.body.data.files.every(
          (f: { folder: string }) => f.folder === "profile_images",
        ),
      ).toBe(true);

      await prisma.file.deleteMany({ where: { id: file.id } });
    });

    it.each([
      ["?limit=999", "limit above the maximum"],
      ["?status=NOPE", "an unknown status"],
      ["?folder=nope", "an unknown folder"],
      ["?page=0", "a page below one"],
    ])("rejects %s (%s)", async (query) => {
      const res = await request(app)
        .get(`/api/app/files${query}`)
        .set("Authorization", staff());
      expect(res.status).toBe(httpStatus.BAD_REQUEST);
    });
  });
});
