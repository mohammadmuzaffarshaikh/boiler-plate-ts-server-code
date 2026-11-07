import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Sample files for the upload specs.
 *
 * Embedded as base64 rather than generated or checked in as binaries, so the
 * suite is self-contained: no fixture directory to keep in sync, no image
 * library to install, and the bytes are identical on every machine.
 *
 * The four raster images are genuine 1x1 files produced by an encoder — not
 * hand-written headers — so the magic-byte detector is tested against the
 * real thing rather than against a copy of its own table.
 */

const JPEG_B64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy" +
  "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIA" +
  "AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA" +
  "AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3" +
  "ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm" +
  "p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEA" +
  "AwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSEx" +
  "BhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElK" +
  "U1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3" +
  "uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDk6KKK" +
  "4z9KP//Z";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGM4IWcDAALUASNyYth2" +
  "AAAAAElFTkSuQmCC";

const WEBP_B64 =
  "UklGRjgAAABXRUJQVlA4ICwAAACQAQCdASoBAAEAAUAmJaACdLoAA5gA/vD6K67xaUa/+8Z//cZ/" +
  "/cZ/7uAAAA==";

const GIF_B64 = "R0lGODdhAQABAIAAAMgePAAAACwAAAAAAQABAAACAkQBADs=";

/**
 * Office documents, produced by a real ZIP writer (Python's `zipfile`) and a
 * hand-built OLE compound file.
 *
 * The OOXML ones are genuine archives — deflated members, a real central
 * directory — so `detect-container-type` is tested against the format and
 * not against a copy of its own assumptions. They carry only the parts that
 * identify them, which is the whole point: the main part name is the
 * discriminator, so a 600-byte file exercises the same code path a 6 MB one
 * would.
 *
 * `DOCM` is a .docx with a `word/vbaProject.bin` beside it — byte-identical
 * in every other respect, and it must be refused.
 *
 * The three CFB files are assembled by hand (there is no OLE writer in the
 * standard library): a 512-byte header, one FAT sector and one directory
 * sector holding a root entry plus the stream whose name decides the format.
 * `OLE_OTHER` names a stream no Office format uses and must be refused.
 */
const DOCX_B64 =
  "UEsDBBQAAAAIABpmZl2i7cddawAAAHMAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbBWMwQ3CMAwA" +
  "V4n8bx14IISa9scEZYAomLSC2FFsIdie8Dzd6ablU17uTU134QCH0YMjTnLfOQe4rdfhDMs8rd9K" +
  "6nrKGmAzqxdETRuVqKNU4m4e0kq0ji1jjekZM+HR+xMmYSO2wf4PwPkHUEsDBBQAAAAIABpmZl3S" +
  "d/y3bQAAAHsAAAALAAAAX3JlbHMvLnJlbHNNjEEOAiEMRa9CuneKLowxw8xuDmD0AA1WIA6FUGI8" +
  "vixd/rz3/rx+824+3DQVcXCcLBgWX55JgoPHfTtcYF3mG+/Uh6ExVTUjEXUQe69XRPWRM+lUKssg" +
  "r9Iy9TFbwEr+TYHxZO0Z2/8H4PIDUEsDBBQAAAAIABpmZl1fW9FMDQAAAAsAAAARAAAAd29yZC9k" +
  "b2N1bWVudC54bWyzSclPLs1NzSvRtwMAUEsDBBQAAAAIABpmZl2YdyntCwAAAAkAAAAPAAAAd29y" +
  "ZC9zdHlsZXMueG1ssykuqcxJLda3AwBQSwECFAMUAAAACAAaZmZdou3HXWsAAABzAAAAEwAAAAAA" +
  "AAAAAAAAgAEAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAxQAAAAIABpmZl3Sd/y3bQAAAHsA" +
  "AAALAAAAAAAAAAAAAACAAZwAAABfcmVscy8ucmVsc1BLAQIUAxQAAAAIABpmZl1fW9FMDQAAAAsA" +
  "AAARAAAAAAAAAAAAAACAATIBAAB3b3JkL2RvY3VtZW50LnhtbFBLAQIUAxQAAAAIABpmZl2Ydynt" +
  "CwAAAAkAAAAPAAAAAAAAAAAAAACAAW4BAAB3b3JkL3N0eWxlcy54bWxQSwUGAAAAAAQABAD2AAAA" +
  "pgEAAAAA";

const XLSX_B64 =
  "UEsDBBQAAAAIABpmZl2i7cddawAAAHMAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbBWMwQ3CMAwA" +
  "V4n8bx14IISa9scEZYAomLSC2FFsIdie8Dzd6ablU17uTU134QCH0YMjTnLfOQe4rdfhDMs8rd9K" +
  "6nrKGmAzqxdETRuVqKNU4m4e0kq0ji1jjekZM+HR+xMmYSO2wf4PwPkHUEsDBBQAAAAIABpmZl3S" +
  "d/y3bQAAAHsAAAALAAAAX3JlbHMvLnJlbHNNjEEOAiEMRa9CuneKLowxw8xuDmD0AA1WIA6FUGI8" +
  "vixd/rz3/rx+824+3DQVcXCcLBgWX55JgoPHfTtcYF3mG+/Uh6ExVTUjEXUQe69XRPWRM+lUKssg" +
  "r9Iy9TFbwEr+TYHxZO0Z2/8H4PIDUEsDBBQAAAAIABpmZl3OnpgTDQAAAAsAAAAPAAAAeGwvd29y" +
  "a2Jvb2sueG1ssynPL8pOys/P1rcDAFBLAwQUAAAACAAaZmZdnMTIUwoAAAAIAAAAGAAAAHhsL3dv" +
  "cmtzaGVldHMvc2hlZXQxLnhtbLMpzkhNLdG3AwBQSwECFAMUAAAACAAaZmZdou3HXWsAAABzAAAA" +
  "EwAAAAAAAAAAAAAAgAEAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAxQAAAAIABpmZl3Sd/y3" +
  "bQAAAHsAAAALAAAAAAAAAAAAAACAAZwAAABfcmVscy8ucmVsc1BLAQIUAxQAAAAIABpmZl3OnpgT" +
  "DQAAAAsAAAAPAAAAAAAAAAAAAACAATIBAAB4bC93b3JrYm9vay54bWxQSwECFAMUAAAACAAaZmZd" +
  "nMTIUwoAAAAIAAAAGAAAAAAAAAAAAAAAgAFsAQAAeGwvd29ya3NoZWV0cy9zaGVldDEueG1sUEsF" +
  "BgAAAAAEAAQA/QAAAKwBAAAAAA==";

const PPTX_B64 =
  "UEsDBBQAAAAIABpmZl2i7cddawAAAHMAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbBWMwQ3CMAwA" +
  "V4n8bx14IISa9scEZYAomLSC2FFsIdie8Dzd6ablU17uTU134QCH0YMjTnLfOQe4rdfhDMs8rd9K" +
  "6nrKGmAzqxdETRuVqKNU4m4e0kq0ji1jjekZM+HR+xMmYSO2wf4PwPkHUEsDBBQAAAAIABpmZl3S" +
  "d/y3bQAAAHsAAAALAAAAX3JlbHMvLnJlbHNNjEEOAiEMRa9CuneKLowxw8xuDmD0AA1WIA6FUGI8" +
  "vixd/rz3/rx+824+3DQVcXCcLBgWX55JgoPHfTtcYF3mG+/Uh6ExVTUjEXUQe69XRPWRM+lUKssg" +
  "r9Iy9TFbwEr+TYHxZO0Z2/8H4PIDUEsDBBQAAAAIABpmZl3ZbSPpEQAAAA8AAAAUAAAAcHB0L3By" +
  "ZXNlbnRhdGlvbi54bWyzKShKLU7NK0ksyczP07cDAFBLAQIUAxQAAAAIABpmZl2i7cddawAAAHMA" +
  "AAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQDFAAAAAgAGmZmXdJ3" +
  "/LdtAAAAewAAAAsAAAAAAAAAAAAAAIABnAAAAF9yZWxzLy5yZWxzUEsBAhQDFAAAAAgAGmZmXdlt" +
  "I+kRAAAADwAAABQAAAAAAAAAAAAAAIABMgEAAHBwdC9wcmVzZW50YXRpb24ueG1sUEsFBgAAAAAD" +
  "AAMAvAAAAHUBAAAAAA==";

const DOCM_B64 =
  "UEsDBBQAAAAIABpmZl2i7cddawAAAHMAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbBWMwQ3CMAwA" +
  "V4n8bx14IISa9scEZYAomLSC2FFsIdie8Dzd6ablU17uTU134QCH0YMjTnLfOQe4rdfhDMs8rd9K" +
  "6nrKGmAzqxdETRuVqKNU4m4e0kq0ji1jjekZM+HR+xMmYSO2wf4PwPkHUEsDBBQAAAAIABpmZl3S" +
  "d/y3bQAAAHsAAAALAAAAX3JlbHMvLnJlbHNNjEEOAiEMRa9CuneKLowxw8xuDmD0AA1WIA6FUGI8" +
  "vixd/rz3/rx+824+3DQVcXCcLBgWX55JgoPHfTtcYF3mG+/Uh6ExVTUjEXUQe69XRPWRM+lUKssg" +
  "r9Iy9TFbwEr+TYHxZO0Z2/8H4PIDUEsDBBQAAAAIABpmZl1fW9FMDQAAAAsAAAARAAAAd29yZC9k" +
  "b2N1bWVudC54bWyzSclPLs1NzSvRtwMAUEsDBBQAAAAIABpmZl2FPZ0+CQAAAAcAAAATAAAAd29y" +
  "ZC92YmFQcm9qZWN0LmJpbmNgzE1MLsoHAFBLAQIUAxQAAAAIABpmZl2i7cddawAAAHMAAAATAAAA" +
  "AAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQDFAAAAAgAGmZmXdJ3/LdtAAAA" +
  "ewAAAAsAAAAAAAAAAAAAAIABnAAAAF9yZWxzLy5yZWxzUEsBAhQDFAAAAAgAGmZmXV9b0UwNAAAA" +
  "CwAAABEAAAAAAAAAAAAAAIABMgEAAHdvcmQvZG9jdW1lbnQueG1sUEsBAhQDFAAAAAgAGmZmXYU9" +
  "nT4JAAAABwAAABMAAAAAAAAAAAAAAIABbgEAAHdvcmQvdmJhUHJvamVjdC5iaW5QSwUGAAAAAAQA" +
  "BAD6AAAAqAEAAAAA";

const PLAIN_ZIP_B64 =
  "UEsDBBQAAAAIABpmZl2GphA2BwAAAAUAAAAKAAAAcmVhZG1lLnR4dMtIzcnJBwBQSwMEFAAAAAgA" +
  "GmZmXYMW3IwDAAAAAQAAAAsAAABzcmMvbWFpbi5qc6sAAFBLAQIUAxQAAAAIABpmZl2GphA2BwAA" +
  "AAUAAAAKAAAAAAAAAAAAAACAAQAAAAByZWFkbWUudHh0UEsBAhQDFAAAAAgAGmZmXYMW3IwDAAAA" +
  "AQAAAAsAAAAAAAAAAAAAAIABLwAAAHNyYy9tYWluLmpzUEsFBgAAAAACAAIAcQAAAFsAAAAAAA==";

const DOC_B64 =
  "0M8R4KGxGuEAAAAAAAAAAAAAAAAAAAAAPgADAP7/CQAGAAAAAAAAAAAAAAABAAAAAQAAAAAAAAAA" +
  "EAAA/v///wAAAAD+////AAAAAAAAAAD/////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "///////////////////////////////////////////////////////////////////////////9" +
  "/////v//////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "/////////////////////////////////////////////////////////////////////////1IA" +
  "bwBvAHQAIABFAG4AdAByAHkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAWAAUB////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAVwBvAHIAZABEAG8AYwB1AG0AZQBuAHQAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAABoAAgH///////////////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFAFMAdQBtAG0AYQByAHkASQBuAGYAbwByAG0AYQB0" +
  "AGkAbwBuAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKAACAf///////////////wAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const XLS_B64 =
  "0M8R4KGxGuEAAAAAAAAAAAAAAAAAAAAAPgADAP7/CQAGAAAAAAAAAAAAAAABAAAAAQAAAAAAAAAA" +
  "EAAA/v///wAAAAD+////AAAAAAAAAAD/////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "///////////////////////////////////////////////////////////////////////////9" +
  "/////v//////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "/////////////////////////////////////////////////////////////////////////1IA" +
  "bwBvAHQAIABFAG4AdAByAHkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAWAAUB////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAVwBvAHIAawBiAG8AbwBrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAABIAAgH///////////////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFAFMAdQBtAG0AYQByAHkASQBuAGYAbwByAG0AYQB0" +
  "AGkAbwBuAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKAACAf///////////////wAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const OLE_OTHER_B64 =
  "0M8R4KGxGuEAAAAAAAAAAAAAAAAAAAAAPgADAP7/CQAGAAAAAAAAAAAAAAABAAAAAQAAAAAAAAAA" +
  "EAAA/v///wAAAAD+////AAAAAAAAAAD/////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "///////////////////////////////////////////////////////////////////////////9" +
  "/////v//////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////" +
  "/////////////////////////////////////////////////////////////////////////1IA" +
  "bwBvAHQAIABFAG4AdAByAHkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAWAAUB////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAQwBhAHQAYQBsAG8AZwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAABAAAgH///////////////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFAFMAdQBtAG0AYQByAHkASQBuAGYAbwByAG0AYQB0" +
  "AGkAbwBuAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKAACAf///////////////wAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/**
 * An ISO base-media header: a size field, the literal "ftyp", then the brand
 * that distinguishes MP4 from MOV from AVIF. Built here rather than embedded
 * because the brand is the whole point of the test.
 */
export const isoHeader = (brand: string): Buffer => {
  const compat = Buffer.from("isom", "latin1");
  const payload = Buffer.concat([
    Buffer.from(brand.padEnd(4).slice(0, 4), "latin1"),
    Buffer.alloc(4),
    compat,
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length + 8);
  const mdat = Buffer.concat([Buffer.alloc(4), Buffer.from("mdat", "latin1")]);
  mdat.writeUInt32BE(8, 0);
  return Buffer.concat([size, Buffer.from("ftyp", "latin1"), payload, mdat]);
};

export const samples = {
  jpeg: Buffer.from(JPEG_B64, "base64"),
  png: Buffer.from(PNG_B64, "base64"),
  gif: Buffer.from(GIF_B64, "base64"),
  webp: Buffer.from(WEBP_B64, "base64"),
  mp4: isoHeader("isom"),
  mov: isoHeader("qt  "),
  avif: isoHeader("avif"),
  // EBML header — the first bytes of every WebM/Matroska file.
  webm: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]),
  pdf: Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n", "latin1"),
  docx: Buffer.from(DOCX_B64, "base64"),
  xlsx: Buffer.from(XLSX_B64, "base64"),
  pptx: Buffer.from(PPTX_B64, "base64"),
  doc: Buffer.from(DOC_B64, "base64"),
  xls: Buffer.from(XLS_B64, "base64"),

  // Must all be refused.
  svg: Buffer.from(
    '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg">' +
      "<script>alert(document.cookie)</script></svg>",
    "utf8",
  ),
  csv: Buffer.from("id,name,price\n1,hoodie,49.00\n", "utf8"),
  text: Buffer.from("just some text\n", "utf8"),
  // A ZIP header with nothing behind it — no central directory to read.
  zip: Buffer.concat([
    Buffer.from("PK\u0003\u0004", "latin1"),
    Buffer.alloc(32),
  ]),
  // A real archive that is not a document. Being a ZIP is not enough.
  zipArchive: Buffer.from(PLAIN_ZIP_B64, "base64"),
  // A .docx carrying a macro project. Everything else about it is valid.
  docm: Buffer.from(DOCM_B64, "base64"),
  // A compound file that is not an Office document (an installer looks like
  // this). Being an OLE container is not enough either.
  oleOther: Buffer.from(OLE_OTHER_B64, "base64"),
  empty: Buffer.alloc(0),
};

export type SampleName = keyof typeof samples;

/** Pad a sample out to `bytes` while keeping its real header intact. */
export const padded = (name: SampleName, bytes: number): Buffer =>
  Buffer.concat([
    samples[name],
    Buffer.alloc(Math.max(0, bytes - samples[name].length), 0x20),
  ]);

/**
 * Write a buffer to a scratch file and return its path, mimicking what multer
 * produces: a name with no extension, so nothing downstream can infer a type
 * from it.
 */
export const writeTempFile = (contents: Buffer): string => {
  const dir = process.env.UPLOAD_TMP_DIR ?? os.tmpdir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `spec-${randomUUID()}`);
  fs.writeFileSync(file, contents);
  return file;
};

/** Temp files left in UPLOAD_TMP_DIR by multer (`upload-*`). */
export const spooledFiles = (): string[] => {
  const dir = process.env.UPLOAD_TMP_DIR ?? os.tmpdir();
  try {
    return fs.readdirSync(dir).filter((f) => f.startsWith("upload-"));
  } catch {
    return [];
  }
};
