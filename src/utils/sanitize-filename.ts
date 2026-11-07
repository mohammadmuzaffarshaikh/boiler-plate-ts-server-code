/**
 * Clean up a client-supplied filename.
 *
 * Two different jobs, deliberately kept apart:
 *
 *   `sanitizeFileName` produces the name that is STORED and shown back —
 *   still recognisably what the person uploaded, in their own alphabet,
 *   minus everything that is dangerous or meaningless to keep.
 *
 *   `fileNameSlug` produces the ASCII fragment that goes INTO the object
 *   key. Far stricter, because a key ends up in a URL, in a bucket listing
 *   and in a log line.
 *
 * Neither is a security boundary on its own — the type of a file is decided
 * by its bytes (`detect-file-type`), never by its name — but the name still
 * reaches several places where a hostile one causes trouble:
 *
 *   - A path. `../../etc/passwd.png` must not survive as a path. Only the
 *     last segment is kept, after splitting on BOTH separators: a Windows
 *     client sends `C:\Users\me\photo.jpg` and `path.basename` on Linux
 *     treats that entire string as one filename.
 *   - A `Content-Disposition` header. A CR or LF in a filename splits the
 *     response and injects headers. Control characters are stripped here so
 *     that header is safe to build later without remembering this.
 *   - A display string. U+202E RIGHT-TO-LEFT OVERRIDE turns `photo<RLO>gnp.exe`
 *     into something that renders as `photoexe.png`, which is the oldest
 *     attachment trick there is.
 */

/**
 * Longest name kept. Generous for display, short enough that the column,
 * a log line and a `Content-Disposition` header all stay sane. The POSIX
 * per-component limit is 255 bytes and a multi-byte name can exceed that
 * well before 255 characters.
 */
export const MAX_ORIGINAL_NAME_LENGTH = 180;

/** Longest slug placed in an object key, before the uuid is appended. */
export const MAX_SLUG_LENGTH = 48;

/** Used when nothing printable survives — an all-emoji or all-dots name. */
export const FALLBACK_NAME = "file";

/**
 * C0 and C1 control characters, zero-width marks, the bidirectional
 * overrides, the invisible-maths block and the byte-order mark. None of
 * these can be typed deliberately into a filename that means anything, and
 * every one of them has a use in disguising what a file is.
 */
const INVISIBLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

/** Combining marks left behind by NFKD, so "café" slugs as "cafe". */
const COMBINING_MARKS = /[\u0300-\u036F]/g;

/**
 * Split off a trailing extension, if the tail looks like one.
 *
 * The length bound is what stops `my.very.long.description` from being read
 * as a 14-character extension, which would then be glued back on after
 * truncation and produce nonsense.
 */
const splitExtension = (name: string): { stem: string; extension: string } => {
  const dot = name.lastIndexOf(".");
  const looksLikeExtension = dot > 0 && name.length - dot <= 11;
  return looksLikeExtension
    ? { stem: name.slice(0, dot), extension: name.slice(dot) }
    : { stem: name, extension: "" };
};

/** Shorten the stem, never the extension — the tail is the informative part. */
const truncate = (name: string, max: number): string => {
  if (name.length <= max) return name;
  const { stem, extension } = splitExtension(name);
  return `${stem.slice(0, Math.max(1, max - extension.length))}${extension}`;
};

/**
 * The display name: what gets written to `files.original_name`.
 *
 * Non-ASCII is kept on purpose. A product sheet called `Größentabelle.pdf`
 * or `размеры.pdf` should come back looking like itself — transliterating
 * it would be a worse answer than storing it. The ASCII-only rule belongs
 * to the key, which is a different string with different consumers.
 */
export const sanitizeFileName = (raw: string): string => {
  const segments = raw
    .normalize("NFC")
    .split(/[/\\]/)
    .filter((segment) => segment !== "");

  const cleaned = (segments[segments.length - 1] ?? "")
    .replace(INVISIBLE, "")
    // Tabs and newlines are gone by now; this collapses the rest.
    .replace(/\s+/g, " ")
    // Leading dots hide a file on POSIX; trailing dots and spaces are
    // silently dropped by Windows, so a name ending in one never round-trips.
    .replace(/^[\s.]+/, "")
    .replace(/[\s.]+$/, "")
    .trim();

  if (cleaned === "") return FALLBACK_NAME;
  return truncate(cleaned, MAX_ORIGINAL_NAME_LENGTH);
};

/**
 * The key fragment: lowercase ASCII letters, digits and single hyphens.
 *
 * Returns `""` when nothing survives — an all-Cyrillic or all-CJK name, or
 * a name that was only punctuation. The caller must cope with that rather
 * than substitute something, because the uuid alone is already a complete,
 * unique key and inventing a placeholder would only add noise.
 *
 * The output is URL-safe by construction, so it needs no escaping anywhere
 * downstream, and it cannot contain `/`, `.` or `%` — which is what keeps a
 * client-supplied name from reshaping the key it lands in.
 */
export const fileNameSlug = (
  name: string,
  maxLength: number = MAX_SLUG_LENGTH,
): string => {
  const { stem } = splitExtension(sanitizeFileName(name));

  const slug = stem
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  // Trimmed again after slicing: cutting mid-word can leave a trailing
  // hyphen, and `product-image--<uuid>` looks like a bug in a bucket listing.
  return slug.slice(0, maxLength).replace(/-+$/g, "");
};
