import {
  sanitizeFileName,
  fileNameSlug,
  MAX_ORIGINAL_NAME_LENGTH,
  MAX_SLUG_LENGTH,
  FALLBACK_NAME,
} from "../../src/utils/sanitize-filename";

/**
 * The filename is the one piece of an upload that a client fully controls
 * and that still reaches a stored field, a log line and an object key. None
 * of these cases is theoretical: each one is something a filename has been
 * used to do.
 */
describe("sanitizeFileName", () => {
  describe("paths", () => {
    it.each([
      ["../../etc/passwd.png", "passwd.png"],
      ["/absolute/path/photo.jpg", "photo.jpg"],
      ["....//....//secret.pdf", "secret.pdf"],
      ["a/b/c/d/e.webp", "e.webp"],
    ])("keeps only the last segment of %s", (raw, expected) => {
      expect(sanitizeFileName(raw)).toBe(expected);
    });

    it("splits on backslashes too — a Windows client sends a Windows path", () => {
      // `path.basename` on Linux treats this entire string as one filename,
      // which is why it is not used here.
      expect(sanitizeFileName("C:\\Users\\me\\Desktop\\photo.jpg")).toBe(
        "photo.jpg",
      );
      expect(sanitizeFileName("..\\..\\windows\\system32\\cmd.exe")).toBe(
        "cmd.exe",
      );
    });

    it("survives a trailing separator with nothing after it", () => {
      expect(sanitizeFileName("folder/")).toBe("folder");
      expect(sanitizeFileName("/")).toBe(FALLBACK_NAME);
    });
  });

  describe("characters that hide what a file is", () => {
    it("strips CR and LF — they split a Content-Disposition header", () => {
      const name = sanitizeFileName(
        'a.jpg"\r\nContent-Type: text/html\r\n\r\n<script>',
      );
      expect(name).not.toMatch(/[\r\n]/);
    });

    it("strips the right-to-left override", () => {
      // "photo<RLO>gnp.exe" renders as "photoexe.png" in most file listings.
      expect(sanitizeFileName("photo\u202Egnp.exe")).toBe("photognp.exe");
    });

    it("strips NULs, zero-width characters and the BOM", () => {
      expect(sanitizeFileName("ph\u0000o\u200Bt\uFEFFo.png")).toBe("photo.png");
    });

    it("collapses runs of whitespace", () => {
      expect(sanitizeFileName("my    product \t photo.jpg")).toBe(
        "my product photo.jpg",
      );
    });
  });

  describe("names that are nothing once cleaned", () => {
    it.each([
      ["", FALLBACK_NAME],
      ["...", FALLBACK_NAME],
      ["   ", FALLBACK_NAME],
      ["\u0000\u0001", FALLBACK_NAME],
    ])("falls back for %p", (raw, expected) => {
      expect(sanitizeFileName(raw)).toBe(expected);
    });

    it("un-hides a dotfile", () => {
      expect(sanitizeFileName(".htaccess")).toBe("htaccess");
    });

    it("drops trailing dots and spaces, which Windows silently removes", () => {
      expect(sanitizeFileName("report.pdf. .")).toBe("report.pdf");
    });
  });

  describe("names worth keeping as they are", () => {
    it.each([
      "blue-hoodie-front.jpg",
      "Größentabelle.pdf",
      "размеры.pdf",
      "商品写真.png",
      "invoice (2).pdf",
    ])("leaves %s alone", (name) => {
      expect(sanitizeFileName(name)).toBe(name);
    });
  });

  describe("length", () => {
    it("caps the name and keeps the extension", () => {
      const name = sanitizeFileName(`${"a".repeat(400)}.jpeg`);
      expect(name.length).toBeLessThanOrEqual(MAX_ORIGINAL_NAME_LENGTH);
      expect(name.endsWith(".jpeg")).toBe(true);
    });

    it("does not mistake a long dotted name for a long extension", () => {
      // The whole trailing run would otherwise be glued back on after the
      // truncation, producing something longer than the cap.
      const name = sanitizeFileName(`${"a".repeat(300)}.${"b".repeat(40)}`);
      expect(name.length).toBeLessThanOrEqual(MAX_ORIGINAL_NAME_LENGTH);
    });
  });
});

describe("fileNameSlug", () => {
  it.each([
    ["Blue Hoodie Front.JPG", "blue-hoodie-front"],
    ["invoice (2).pdf", "invoice-2"],
    ["café_münchen.png", "cafe-munchen"],
    ["../../etc/passwd.png", "passwd"],
    ["  spaced   out  .webp", "spaced-out"],
  ])("slugs %s to %s", (raw, expected) => {
    expect(fileNameSlug(raw)).toBe(expected);
  });

  it("produces only characters that are safe in a key and a URL", () => {
    const slug = fileNameSlug('a/b\\c?d#e%f "g" <h>.jpg');
    expect(slug).toMatch(/^[a-z0-9-]*$/);
    expect(encodeURIComponent(slug)).toBe(slug);
  });

  it("returns an empty string when nothing Latin survives", () => {
    // The caller falls back to the uuid alone rather than inventing a name.
    expect(fileNameSlug("размеры.pdf")).toBe("");
    expect(fileNameSlug("商品写真.png")).toBe("");
    expect(fileNameSlug("!!!.png")).toBe("");
  });

  it("caps the length and never ends on a hyphen", () => {
    const slug = fileNameSlug(`${"word ".repeat(40)}.jpg`);
    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug).not.toMatch(/-$/);
  });

  it("cannot be made to contain a path separator or a dot", () => {
    // This is the property that lets the slug sit in an object key at all.
    for (const raw of [
      "../../x.png",
      "a.b.c.d.jpg",
      "x/../y.png",
      "%2e%2e/z.png",
    ]) {
      expect(fileNameSlug(raw)).not.toMatch(/[/\\.]/);
    }
  });
});
