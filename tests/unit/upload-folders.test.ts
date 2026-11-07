import {
  uploadFolders,
  folderPolicy,
  isUploadFolder,
  keyPrefixFor,
  allKeyPrefixes,
  maxBytesFor,
  maxUploadBytes,
  UploadFolder,
} from "../../src/config/constants";
import { uploadFile as uploadSchema } from "../../src/validations/file.validation";
import config from "../../src/config/config";

/**
 * The folder allowlist.
 *
 * `folder` is the only value in an upload request that influences where the
 * bytes land, so the properties worth pinning are: the set is closed, a
 * folder always resolves to a prefix, and nothing a caller sends can be
 * turned into a path. The sibling api repo fails exactly this — it
 * concatenates the client's string into the key and "sanitises" it with a
 * non-recursive `.replace(/\.\.\//g, "")`, which `....//` walks straight
 * through.
 */
describe("upload folders", () => {
  const FOLDERS: UploadFolder[] = [
    "product_images",
    "product_videos",
    "documents",
    "profile_images",
  ];

  it("is exactly the four documented folders", () => {
    expect([...uploadFolders].sort()).toEqual([...FOLDERS].sort());
  });

  it("states a policy and a prefix for every folder", () => {
    for (const folder of uploadFolders) {
      expect(folderPolicy[folder].length).toBeGreaterThan(0);
      expect(keyPrefixFor(folder)).toBeTruthy();
    }
  });

  it("accepts the type each folder is for, and nothing else", () => {
    expect(folderPolicy.product_images).toEqual(["image"]);
    expect(folderPolicy.product_videos).toEqual(["video"]);
    expect(folderPolicy.documents).toEqual(["document"]);
    expect(folderPolicy.profile_images).toEqual(["image"]);
  });

  describe("isUploadFolder", () => {
    it.each(FOLDERS)("accepts %s", (folder) => {
      expect(isUploadFolder(folder)).toBe(true);
    });

    it.each([
      "../product_images",
      "product_images/../../etc",
      "....//product_images",
      "Product_Images",
      "products",
      "",
      "  product_images  ",
    ])("refuses %p", (value) => {
      expect(isUploadFolder(value)).toBe(false);
    });

    it.each([undefined, null, 42, {}, ["product_images"]])(
      "refuses the non-string %p",
      (value) => {
        expect(isUploadFolder(value)).toBe(false);
      },
    );
  });

  describe("key prefixes", () => {
    it("never yields a prefix containing a traversal or a leading slash", () => {
      for (const prefix of allKeyPrefixes()) {
        expect(prefix).toMatch(/^[a-z_]+$/);
      }
    });

    it("lists one prefix per folder, for the orphan sweep to walk", () => {
      expect(allKeyPrefixes()).toHaveLength(uploadFolders.length);
      expect(new Set(allKeyPrefixes()).size).toBe(uploadFolders.length);
    });
  });

  describe("size caps", () => {
    it("gives multer the largest cap of any category", () => {
      // It cannot be per-folder: the folder field is part of the body multer
      // is still parsing. The precise cap is applied after the sniff.
      expect(maxUploadBytes()).toBe(
        Math.max(
          maxBytesFor("image"),
          maxBytesFor("video"),
          maxBytesFor("document"),
        ),
      );
      expect(maxUploadBytes()).toBe(config.STORAGE.MAX_VIDEO_MB * 1024 * 1024);
    });

    it("reads each cap from its own setting", () => {
      expect(maxBytesFor("image")).toBe(
        config.STORAGE.MAX_IMAGE_MB * 1024 * 1024,
      );
      expect(maxBytesFor("document")).toBe(
        config.STORAGE.MAX_DOCUMENT_MB * 1024 * 1024,
      );
    });
  });

  describe("the upload schema", () => {
    it("requires folder", () => {
      const { error } = uploadSchema.body!.validate({});
      expect(error?.message).toMatch(/folder.*required/);
    });

    it.each(FOLDERS)("accepts %s", (folder) => {
      expect(uploadSchema.body!.validate({ folder }).error).toBeUndefined();
    });

    it("rejects a folder outside the allowlist", () => {
      expect(
        uploadSchema.body!.validate({ folder: "../etc" }).error,
      ).toBeDefined();
    });

    it("rejects any other field alongside it", () => {
      expect(
        uploadSchema.body!.validate({ folder: "documents", key: "x" }).error,
      ).toBeDefined();
    });
  });
});
