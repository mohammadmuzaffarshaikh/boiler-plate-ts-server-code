import {
  detectFileType,
  ALLOWED_EXTENSIONS,
  MAGIC_BYTE_LENGTH,
} from "../../src/utils/detect-file-type";
import { CONTAINER_EXTENSIONS } from "../../src/utils/detect-container-type";
import { samples, isoHeader } from "../helpers/samples";

/**
 * The detector is the only thing standing between "the client said this is a
 * JPEG" and what actually gets stored and served, so these are the highest
 * value tests in the suite.
 */
describe("detectFileType", () => {
  describe("accepts real files", () => {
    it.each([
      ["jpeg", samples.jpeg, "image/jpeg", "jpg", "image"],
      ["png", samples.png, "image/png", "png", "image"],
      ["gif", samples.gif, "image/gif", "gif", "image"],
      ["webp", samples.webp, "image/webp", "webp", "image"],
      ["avif", samples.avif, "image/avif", "avif", "image"],
      ["mp4", samples.mp4, "video/mp4", "mp4", "video"],
      ["mov", samples.mov, "video/quicktime", "mov", "video"],
      ["webm", samples.webm, "video/webm", "webm", "video"],
      ["pdf", samples.pdf, "application/pdf", "pdf", "document"],
    ])("identifies %s", (_name, bytes, mimeType, extension, category) => {
      expect(detectFileType(bytes)).toEqual({ mimeType, extension, category });
    });
  });

  describe("refuses everything not on the allowlist", () => {
    it.each([
      ["svg (a script container — stored XSS if served)", samples.svg],
      ["csv", samples.csv],
      ["plain text", samples.text],
      ["zip", samples.zip],
      ["an empty buffer", samples.empty],
    ])("rejects %s", (_name, bytes) => {
      expect(detectFileType(bytes)).toBeNull();
    });
  });

  describe("ignores what the client claims", () => {
    it("refuses an SVG renamed to .jpg — the rename attack", () => {
      // The filename and declared Content-Type never reach this function;
      // only bytes do, which is exactly why the attack fails.
      expect(detectFileType(samples.svg)).toBeNull();
    });

    it("reports a PNG as a PNG even when it is named .jpg", () => {
      expect(detectFileType(samples.png)?.mimeType).toBe("image/png");
    });
  });

  describe("ISO base-media brands", () => {
    // Real encoders are inconsistent; a missing brand here means a staff
    // member is told their ordinary video is "unrecognised".
    it.each([
      "isom",
      "iso2",
      "iso4",
      "iso5",
      "iso6",
      "mp41",
      "mp42",
      "mp4v",
      "avc1",
      "mmp4",
      "MSNV",
      "dash",
      "M4V ",
    ])("accepts %s as video/mp4", (brand) => {
      expect(detectFileType(isoHeader(brand))?.mimeType).toBe("video/mp4");
    });

    it.each([
      ["M4A ", "audio must not pass a video endpoint"],
      ["3gp4", "3GPP is not on the allowlist"],
      ["f4v ", "Flash video is not on the allowlist"],
      ["heic", "HEIC is not on the allowlist"],
    ])("refuses %s (%s)", (brand) => {
      expect(detectFileType(isoHeader(brand))).toBeNull();
    });

    it.each(["cons", "toSt", "__pr", "hasO"])(
      "cannot resolve %s through Object.prototype",
      (brand) => {
        // The brand is four bytes read straight out of the file. A plain
        // object would let an inherited key answer the lookup.
        expect(detectFileType(isoHeader(brand))).toBeNull();
      },
    );
  });

  describe("short and malformed input", () => {
    it.each([0, 1, 2, 3, 7, 11])(
      "does not throw on a %i-byte buffer",
      (size) => {
        expect(() =>
          detectFileType(samples.jpeg.subarray(0, size)),
        ).not.toThrow();
      },
    );

    it("needs no more than MAGIC_BYTE_LENGTH bytes to identify a file", () => {
      const head = samples.png.subarray(0, MAGIC_BYTE_LENGTH);
      expect(detectFileType(head)?.mimeType).toBe("image/png");
    });
  });

  describe("Office formats are not this table's job", () => {
    it.each([
      "docx",
      "xlsx",
      "pptx",
      "doc",
      "xls",
      "docm",
      "zipArchive",
    ] as const)("returns null for %s", (name) => {
      // Every OOXML file is a ZIP and every legacy Office file is an OLE
      // compound file, so no byte prefix can tell them apart. They are
      // identified by `detect-container-type`, which opens the container.
      expect(detectFileType(samples[name])).toBeNull();
    });

    it("still lists their extensions, because multer pre-screens on name", () => {
      // The pre-screen in `fileFilter` rejects an unknown extension before
      // any bytes reach disk, so an extension the container detector can
      // return has to appear here or the file never gets that far.
      for (const extension of CONTAINER_EXTENSIONS) {
        expect(ALLOWED_EXTENSIONS).toContain(extension);
      }
    });
  });

  it("never returns an extension outside ALLOWED_EXTENSIONS", () => {
    for (const bytes of [
      samples.jpeg,
      samples.png,
      samples.gif,
      samples.webp,
      samples.avif,
      samples.mp4,
      samples.mov,
      samples.webm,
      samples.pdf,
    ]) {
      expect(ALLOWED_EXTENSIONS).toContain(detectFileType(bytes)!.extension);
    }
  });
});
