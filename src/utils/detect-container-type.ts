import fsp from "node:fs/promises";
import type { DetectedFileType } from "./detect-file-type";

/**
 * Identify Office documents, which a magic-byte prefix cannot tell apart.
 *
 * Every modern Office file is a ZIP and every legacy one is an OLE compound
 * file, so `.docx` and `.xlsx` share one signature and `.doc` and `.xls`
 * share another. A flat byte table — what `detect-file-type` does for JPEG,
 * PNG, MP4 — physically cannot distinguish them. The only honest answer is
 * to open the container and look at what is inside it, which is what this
 * module does, and why it takes a path instead of a buffer: a ZIP's index
 * lives at the END of the file.
 *
 * It is still a bytes-only decision. Nothing here reads the filename or the
 * client's declared content type.
 *
 * TWO THINGS THIS DELIBERATELY REFUSES:
 *
 *   - A plain `.zip`, `.jar`, `.apk` or any other archive. Being a ZIP is
 *     not enough; the OOXML main part has to be present. An allowlist of
 *     one part name per format is the whole gate.
 *   - Macro-enabled documents (`.docm`, `.xlsm`), which are byte-identical
 *     to their safe siblings apart from a `vbaProject.bin` part. Accepting
 *     them would mean this API distributing executable content under a
 *     content type that looks inert.
 */

export type ContainerKind = "zip" | "ole";

/** ZIP local file header, `PK\x03\x04`. */
const ZIP_LOCAL_HEADER = [0x50, 0x4b, 0x03, 0x04];

/** OLE compound file (CFB) header, used by Office 97-2003 and by MSI. */
const OLE_HEADER = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const startsWith = (buffer: Buffer, bytes: number[]): boolean =>
  buffer.length >= bytes.length && bytes.every((b, i) => buffer[i] === b);

/**
 * Which container this is, from the first bytes — or `null`.
 *
 * Only the *container* is decided here. What it holds needs
 * {@link detectContainerType}, which has to read further into the file.
 *
 * An empty archive (`PK\x05\x06`) and a spanned one (`PK\x07\x08`) are not
 * matched: neither can be a document, and treating them as ZIPs would only
 * mean opening a file to prove it.
 */
export const detectContainerKind = (buffer: Buffer): ContainerKind | null => {
  if (startsWith(buffer, ZIP_LOCAL_HEADER)) return "zip";
  if (startsWith(buffer, OLE_HEADER)) return "ole";
  return null;
};

const ooxml = (mimeType: string, extension: string): DetectedFileType => ({
  mimeType,
  extension,
  category: "document",
});

/**
 * The part whose presence identifies an OOXML document, in match order.
 *
 * These are the main document parts named by the ECMA-376 package
 * conventions. Every writer — Word, Excel, LibreOffice, Google's exporter,
 * Apache POI, openpyxl — produces them at exactly these paths, because the
 * relationship graph in `_rels/.rels` points at them by name.
 */
const OOXML_PARTS: readonly (readonly [string, DetectedFileType])[] = [
  [
    "word/document.xml",
    ooxml(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "docx",
    ),
  ],
  [
    "xl/workbook.xml",
    ooxml(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "xlsx",
    ),
  ],
  [
    "ppt/presentation.xml",
    ooxml(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "pptx",
    ),
  ],
];

/**
 * The directory-entry name that identifies a legacy Office document.
 *
 * `Book` is Excel 5.0 and `Workbook` is Excel 8.0 (97 onwards); both still
 * turn up in exports from accounting software. Anything else in a CFB
 * container — an MSI installer, an Outlook `.msg`, a Thumbs.db — matches
 * nothing and is refused.
 */
const OLE_STREAMS: readonly (readonly [string, DetectedFileType])[] = [
  ["WordDocument", ooxml("application/msword", "doc")],
  ["Workbook", ooxml("application/vnd.ms-excel", "xls")],
  ["Book", ooxml("application/vnd.ms-excel", "xls")],
  ["PowerPoint Document", ooxml("application/vnd.ms-powerpoint", "ppt")],
];

/** A macro project under any of the three part roots. */
const MACRO_PART = /(^|\/)vbaproject\.bin$/;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
const MAX_ZIP_COMMENT = 0xffff;
const ZIP64_SENTINEL = 0xffffffff;

/**
 * Bounds on the index walk. An OOXML document has tens of parts; these are
 * set where no real document reaches them but a crafted file stops early.
 */
const MAX_CENTRAL_DIRECTORY_BYTES = 4 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 4096;

const read = async (
  handle: fsp.FileHandle,
  position: number,
  length: number,
): Promise<Buffer> => {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
};

/**
 * Every entry name in a ZIP's central directory, or `null` if it cannot be
 * read as one.
 *
 * The central directory is used rather than walking local headers from the
 * front, because a local header may declare a size of zero and defer the
 * real one to a data descriptor after the compressed bytes (general-purpose
 * bit 3). Office's own writers do exactly that when streaming, so forward
 * iteration desynchronises on precisely the files this has to identify.
 *
 * ZIP64 is not handled: a ZIP needing it holds more than 65,535 entries or
 * exceeds 4 GiB, and either way it is not a document that fits under
 * `UPLOAD_MAX_DOCUMENT_MB`. Such a file is refused rather than guessed at.
 */
const readZipEntryNames = async (
  handle: fsp.FileHandle,
  fileSize: number,
): Promise<string[] | null> => {
  // The end-of-central-directory record is last, but a trailing comment of
  // up to 64 KiB may follow it, so the whole tail has to be scanned
  // backwards for the signature.
  const tailLength = Math.min(fileSize, EOCD_SIZE + MAX_ZIP_COMMENT);
  const tail = await read(handle, fileSize - tailLength, tailLength);

  let eocd = -1;
  for (let i = tail.length - EOCD_SIZE; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const size = tail.readUInt32LE(eocd + 12);
  const offset = tail.readUInt32LE(eocd + 16);

  if (size === ZIP64_SENTINEL || offset === ZIP64_SENTINEL) return null;
  if (size === 0 || size > MAX_CENTRAL_DIRECTORY_BYTES) return null;
  if (offset + size > fileSize) return null;

  const central = await read(handle, offset, size);
  const names: string[] = [];

  let at = 0;
  while (at + CENTRAL_HEADER_SIZE <= central.length) {
    if (central.readUInt32LE(at) !== CENTRAL_HEADER_SIGNATURE) break;
    if (names.length >= MAX_ZIP_ENTRIES) break;

    const nameLength = central.readUInt16LE(at + 28);
    const extraLength = central.readUInt16LE(at + 30);
    const commentLength = central.readUInt16LE(at + 32);
    const nameAt = at + CENTRAL_HEADER_SIZE;

    names.push(central.subarray(nameAt, nameAt + nameLength).toString("utf8"));
    at = nameAt + nameLength + extraLength + commentLength;
  }

  return names;
};

const classifyZip = (names: string[]): DetectedFileType | null => {
  const lower = new Set(names.map((name) => name.toLowerCase()));

  if ([...lower].some((name) => MACRO_PART.test(name))) return null;

  for (const [part, type] of OOXML_PARTS) {
    if (lower.has(part)) return type;
  }
  return null;
};

const OLE_HEADER_SIZE = 512;
const DIRECTORY_ENTRY_SIZE = 128;
const DIRECTORY_NAME_BYTES = 64;
const ENTRY_TYPE_UNALLOCATED = 0;
const MAX_REGULAR_SECTOR = 0xfffffffa;

/**
 * Stream and storage names from the FIRST directory sector of a compound
 * file.
 *
 * Only the first sector, on purpose. Following the FAT chain to later
 * directory sectors means implementing the DIFAT as well, which is a real
 * parser for a format this project does not otherwise touch. It buys
 * nothing here: a CFB writer lays the root entry down first and the
 * document's main stream immediately after it, so the name that identifies
 * the format is within the first 4 (512-byte sectors) or 32 (4096-byte)
 * entries of every file Word and Excel have ever written. A file that hides
 * it further in is not something to accept on a guess, so it is refused.
 */
const readOleStreamNames = async (
  handle: fsp.FileHandle,
  fileSize: number,
): Promise<string[] | null> => {
  const header = await read(handle, 0, OLE_HEADER_SIZE);
  if (header.length < OLE_HEADER_SIZE) return null;

  // Only 512 and 4096 are legal, and a bogus shift would otherwise be used
  // as a shift distance and an allocation size.
  const sectorShift = header.readUInt16LE(30);
  if (sectorShift !== 9 && sectorShift !== 12) return null;
  const sectorSize = 1 << sectorShift;

  const firstDirectorySector = header.readUInt32LE(48);
  if (firstDirectorySector > MAX_REGULAR_SECTOR) return null;

  // Sector 0 starts immediately after the 512-byte header, so sector N
  // begins at (N + 1) * sectorSize for 512-byte sectors. For 4096-byte
  // sectors the header occupies a whole sector, and the arithmetic is the
  // same.
  const position = (firstDirectorySector + 1) * sectorSize;
  if (position + sectorSize > fileSize) return null;

  const sector = await read(handle, position, sectorSize);
  const names: string[] = [];

  for (
    let at = 0;
    at + DIRECTORY_ENTRY_SIZE <= sector.length;
    at += DIRECTORY_ENTRY_SIZE
  ) {
    if (sector[at + 66] === ENTRY_TYPE_UNALLOCATED) continue;

    // Length includes the UTF-16 null terminator, hence the -2.
    const nameBytes = sector.readUInt16LE(at + DIRECTORY_NAME_BYTES);
    if (nameBytes < 4 || nameBytes > DIRECTORY_NAME_BYTES) continue;

    names.push(sector.subarray(at, at + nameBytes - 2).toString("utf16le"));
  }

  return names;
};

const classifyOle = (names: string[]): DetectedFileType | null => {
  const present = new Set(names);
  for (const [stream, type] of OLE_STREAMS) {
    if (present.has(stream)) return type;
  }
  return null;
};

/**
 * Identify the document inside a container, or `null` to refuse it.
 *
 * @param filePath - The spooled upload. Opened read-only and closed here.
 * @param kind     - From {@link detectContainerKind} on the first bytes.
 * @param fileSize - Already known to the caller from `stat`; passed in
 *                   rather than re-stat'ed so the size the policy check used
 *                   and the size this reads against cannot disagree.
 */
export const detectContainerType = async (
  filePath: string,
  kind: ContainerKind,
  fileSize: number,
): Promise<DetectedFileType | null> => {
  if (fileSize < OLE_HEADER_SIZE && kind === "ole") return null;
  if (fileSize < EOCD_SIZE && kind === "zip") return null;

  const handle = await fsp.open(filePath, "r");
  try {
    const names =
      kind === "zip"
        ? await readZipEntryNames(handle, fileSize)
        : await readOleStreamNames(handle, fileSize);

    if (!names) return null;
    return kind === "zip" ? classifyZip(names) : classifyOle(names);
  } finally {
    await handle.close();
  }
};

/** Every extension this module can return. Mirrored in ALLOWED_EXTENSIONS. */
export const CONTAINER_EXTENSIONS: readonly string[] = [
  "docx",
  "xlsx",
  "pptx",
  "doc",
  "xls",
  "ppt",
];
