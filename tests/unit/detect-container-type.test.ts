import fs from "node:fs";
import {
  detectContainerKind,
  detectContainerType,
  CONTAINER_EXTENSIONS,
} from "../../src/utils/detect-container-type";
import { samples, writeTempFile } from "../helpers/samples";
import { removeTempFile } from "../../src/utils/temp-file";

/**
 * Office documents, which no byte prefix can identify.
 *
 * Every OOXML file is a ZIP and every legacy Office file is an OLE compound
 * file, so `.docx` and `.xlsx` are indistinguishable at the signature level
 * and so are `.doc` and `.xls`. These specs pin the two properties that
 * matter: the right format is recognised, and *being a container is not
 * enough* — a plain archive, an installer and a macro-enabled document are
 * all refused.
 */
describe("detectContainerKind", () => {
  it.each([
    ["docx", "zip"],
    ["xlsx", "zip"],
    ["pptx", "zip"],
    ["zipArchive", "zip"],
    ["doc", "ole"],
    ["xls", "ole"],
    ["oleOther", "ole"],
  ] as const)("reads %s as a %s container", (name, kind) => {
    expect(detectContainerKind(samples[name])).toBe(kind);
  });

  it.each(["jpeg", "png", "mp4", "pdf", "svg", "csv", "empty"] as const)(
    "does not claim %s is a container",
    (name) => {
      expect(detectContainerKind(samples[name])).toBeNull();
    },
  );

  it("does not match an empty or spanned archive header", () => {
    // PK\x05\x06 and PK\x07\x08. Neither can hold a document, so there is
    // nothing to gain from opening the file to find that out.
    expect(
      detectContainerKind(Buffer.from("PK\u0005\u0006", "latin1")),
    ).toBeNull();
    expect(
      detectContainerKind(Buffer.from("PK\u0007\u0008", "latin1")),
    ).toBeNull();
  });
});

describe("detectContainerType", () => {
  const detect = async (bytes: Buffer) => {
    const path = writeTempFile(bytes);
    try {
      const kind = detectContainerKind(bytes);
      return kind ? await detectContainerType(path, kind, bytes.length) : null;
    } finally {
      await removeTempFile(path);
    }
  };

  describe("accepts", () => {
    it.each([
      [
        "docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "docx",
      ],
      [
        "xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xlsx",
      ],
      [
        "pptx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "pptx",
      ],
      ["doc", "application/msword", "doc"],
      ["xls", "application/vnd.ms-excel", "xls"],
    ] as const)("identifies %s", async (name, mimeType, extension) => {
      expect(await detect(samples[name])).toEqual({
        mimeType,
        extension,
        category: "document",
      });
    });
  });

  describe("refuses", () => {
    it("a macro-enabled document that is otherwise a valid .docx", async () => {
      // The only difference from `samples.docx` is a word/vbaProject.bin
      // part. Accepting it would mean serving executable content under a
      // content type that looks inert.
      expect(await detect(samples.docm)).toBeNull();
      expect(await detect(samples.docx)).not.toBeNull();
    });

    it("a real archive that is not a document", async () => {
      expect(await detect(samples.zipArchive)).toBeNull();
    });

    it("a compound file that is not an Office document", async () => {
      // Installers and Outlook messages are CFB files too.
      expect(await detect(samples.oleOther)).toBeNull();
    });

    it("a ZIP header with no central directory behind it", async () => {
      expect(await detect(samples.zip)).toBeNull();
    });

    it("a truncated compound file", async () => {
      expect(await detect(samples.doc.subarray(0, 300))).toBeNull();
    });

    it("a compound file whose directory sector points past the end", async () => {
      const broken = Buffer.from(samples.doc);
      broken.writeUInt32LE(9999, 48);
      expect(await detect(broken)).toBeNull();
    });

    it("a compound file declaring an impossible sector size", async () => {
      // The shift is used as a shift distance and an allocation size, so a
      // bogus value has to be refused before it is used, not after.
      const broken = Buffer.from(samples.doc);
      broken.writeUInt16LE(31, 30);
      expect(await detect(broken)).toBeNull();
    });

    it("a ZIP whose central directory claims to start past the end", async () => {
      const broken = Buffer.from(samples.docx);
      const eocd = broken.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      broken.writeUInt32LE(broken.length + 10_000, eocd + 16);
      expect(await detect(broken)).toBeNull();
    });

    it("a ZIP that would need ZIP64 to read", async () => {
      const broken = Buffer.from(samples.docx);
      const eocd = broken.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      broken.writeUInt32LE(0xffffffff, eocd + 16);
      expect(await detect(broken)).toBeNull();
    });
  });

  it("closes the file handle it opens", async () => {
    // A leaked descriptor per upload exhausts the process within a day of
    // ordinary traffic, and nothing else in the request would notice.
    const path = writeTempFile(samples.docx);
    const before = fs.readdirSync("/proc/self/fd").length;
    for (let i = 0; i < 50; i += 1) {
      await detectContainerType(path, "zip", samples.docx.length);
    }
    expect(fs.readdirSync("/proc/self/fd").length).toBeLessThanOrEqual(
      before + 2,
    );
    await removeTempFile(path);
  });

  it("every extension it can return is declared in CONTAINER_EXTENSIONS", async () => {
    for (const name of ["docx", "xlsx", "pptx", "doc", "xls"] as const) {
      expect(CONTAINER_EXTENSIONS).toContain(
        (await detect(samples[name]))!.extension,
      );
    }
  });
});
