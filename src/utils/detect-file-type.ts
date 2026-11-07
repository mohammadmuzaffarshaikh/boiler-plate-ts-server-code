/**
 * Identify a file from its leading bytes, not from what the client claims.
 *
 * Both of the things a browser sends about a file are attacker-controlled:
 * the filename (so the extension) and the multipart `Content-Type`. Trusting
 * either is how an `image/jpeg` upload turns out to be an SVG full of script,
 * served back from a domain you control. So the only input here is bytes.
 *
 * Why this is hand-rolled rather than `file-type`: that package is pure ESM
 * from v21 and requires Node >= 22. This build emits CommonJS and targets
 * Node 20, so importing it is a build error. The allowlist below is small,
 * closed, and does not need to grow often — a dependency buys little.
 *
 * Office formats are NOT here, and their absence is not an oversight: every
 * modern one is a ZIP and every legacy one is an OLE compound file, so no
 * byte prefix can tell `.docx` from `.xlsx`. They are identified by opening
 * the container, in `detect-container-type` — which needs a path rather than
 * a buffer and so cannot live in this table.
 *
 * DELIBERATELY ABSENT, and not to be added without a reason:
 *
 *   - `image/svg+xml` — SVG is an XML document that may carry <script>. Served
 *     from your own domain it is stored XSS with a picture icon.
 *   - CSV and plain text — a browser will happily render `text/csv` as HTML
 *     when it disagrees with the content type, and nothing uploads them.
 *   - Macro-enabled Office documents — refused in `detect-container-type`.
 */

import { CONTAINER_EXTENSIONS } from "./detect-container-type";

/** What a detected type may be used for; drives the size cap and the route. */
export type FileCategory = "image" | "video" | "document";

export interface DetectedFileType {
  /** Authoritative content type. This is what gets stored and sent to R2. */
  mimeType: string;
  /** Canonical extension, without the dot. Used to build the object key. */
  extension: string;
  category: FileCategory;
}

/**
 * Bytes needed by the longest signature below. The ISO base-media check reads
 * a brand at offset 8..12, so 16 is comfortable for every case.
 */
export const MAGIC_BYTE_LENGTH = 16;

const ascii = (buffer: Buffer, start: number, end: number): string =>
  buffer.subarray(start, end).toString("latin1");

const startsWith = (buffer: Buffer, ...bytes: number[]): boolean =>
  buffer.length >= bytes.length && bytes.every((b, i) => buffer[i] === b);

/**
 * ISO base media container brands (`....ftyp<brand>`). MP4, MOV and AVIF all
 * share this box layout and are told apart only by the brand, which is why
 * they cannot be matched by a flat byte prefix like the others.
 */
const mp4 = (): DetectedFileType => ({
  mimeType: "video/mp4",
  extension: "mp4",
  category: "video",
});

const avif = (): DetectedFileType => ({
  mimeType: "image/avif",
  extension: "avif",
  category: "image",
});

/**
 * ISO base media container brands (`....ftyp<brand>`). MP4, MOV and AVIF all
 * share this box layout and are told apart only by the brand, which is why
 * they cannot be matched by a flat byte prefix like the others.
 *
 * The MP4 list is wider than the obvious three because real encoders are
 * inconsistent: phones emit `mp42` or `isom`, editors emit `iso4`/`iso5`,
 * fragmented output emits `iso6` or `dash`, Sony cameras emit `MSNV`. A
 * missing brand here is a staff member being told their perfectly ordinary
 * video is "unrecognised", so the list errs wide — but only within MP4.
 *
 * NOT listed, deliberately: `M4A ` and `3gp*`. `M4A ` is audio in an MP4
 * box, and accepting it would let an audio file through a video endpoint.
 *
 * Null-prototype so a 4-byte brand read out of a file can never resolve to
 * something inherited from `Object.prototype`. No such key is four
 * characters long today, which is the only reason the plain-object version
 * was safe; this does not depend on that holding.
 */
const ISO_BRANDS: Record<string, DetectedFileType> = Object.assign(
  Object.create(null) as Record<string, DetectedFileType>,
  {
    avif: avif(),
    avis: avif(),
    isom: mp4(),
    iso2: mp4(),
    iso4: mp4(),
    iso5: mp4(),
    iso6: mp4(),
    mp41: mp4(),
    mp42: mp4(),
    mp4v: mp4(),
    avc1: mp4(),
    mmp4: mp4(),
    MSNV: mp4(),
    dash: mp4(),
    // Trailing spaces are part of the brand: iTunes video is "M4V ".
    "M4V ": mp4(),
    // Likewise QuickTime's is literally "qt  ".
    "qt  ": {
      mimeType: "video/quicktime",
      extension: "mov",
      category: "video",
    },
  },
);

interface Signature {
  type: DetectedFileType;
  matches: (buffer: Buffer) => boolean;
}

const SIGNATURES: Signature[] = [
  {
    type: { mimeType: "image/jpeg", extension: "jpg", category: "image" },
    matches: (b) => startsWith(b, 0xff, 0xd8, 0xff),
  },
  {
    type: { mimeType: "image/png", extension: "png", category: "image" },
    matches: (b) =>
      startsWith(b, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
  },
  {
    type: { mimeType: "image/gif", extension: "gif", category: "image" },
    matches: (b) => ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a",
  },
  {
    type: { mimeType: "image/webp", extension: "webp", category: "image" },
    // RIFF container; the form only becomes WebP at offset 8.
    matches: (b) =>
      b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP",
  },
  {
    type: { mimeType: "video/webm", extension: "webm", category: "video" },
    // EBML header. Shared with Matroska (.mkv), which is close enough that
    // treating it as WebM is the conservative call for a browser-fed video.
    matches: (b) => startsWith(b, 0x1a, 0x45, 0xdf, 0xa3),
  },
  {
    type: { mimeType: "application/pdf", extension: "pdf", category: "document" },
    matches: (b) => ascii(b, 0, 5) === "%PDF-",
  },
];

/**
 * Sniff a file type from its first bytes.
 *
 * @param buffer - At least {@link MAGIC_BYTE_LENGTH} bytes from the start of
 *                 the file. A shorter buffer is safe: it simply matches less.
 * @returns The detected type, or `null` for anything not on the allowlist —
 *          which is the rejection path, and covers SVG, CSV, archives and
 *          executables alike without having to enumerate them.
 */
export const detectFileType = (buffer: Buffer): DetectedFileType | null => {
  for (const signature of SIGNATURES) {
    if (signature.matches(buffer)) return signature.type;
  }

  // ISO base media: a 4-byte size field, then the literal "ftyp", then the
  // brand that says which of MP4 / MOV / AVIF this actually is.
  if (buffer.length >= 12 && ascii(buffer, 4, 8) === "ftyp") {
    return ISO_BRANDS[ascii(buffer, 8, 12)] ?? null;
  }

  return null;
};

/**
 * Every extension this module can return. Used only for the cheap pre-screen
 * in multer's `fileFilter`, which rejects the obvious cases before any bytes
 * are written to disk. It is NOT a security control — `detectFileType` is.
 */
export const ALLOWED_EXTENSIONS: readonly string[] = [
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "avif",
  "mp4",
  "mov",
  "webm",
  "pdf",
  // Identified by `detect-container-type`, not by the table above, but they
  // still have to pass multer's pre-screen to reach it. A spec cross-checks
  // this tail against CONTAINER_EXTENSIONS so the two cannot drift.
  ...CONTAINER_EXTENSIONS,
];
