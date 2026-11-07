import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { removeTempFile } from "../../src/utils/temp-file";
import logger from "../../src/config/logger";

/**
 * Two different things delete a spooled upload at two different times —
 * `file.service.createFile` in a `finally`, and `cleanupUpload` when the
 * response closes — and neither knows whether the other has already run.
 * So the only interesting property is that running second is harmless.
 */
describe("removeTempFile", () => {
  const tmp = () => path.join(os.tmpdir(), `temp-file-spec-${randomUUID()}`);

  it("removes the file", async () => {
    const file = tmp();
    fs.writeFileSync(file, "spooled");

    await removeTempFile(file);

    expect(fs.existsSync(file)).toBe(false);
  });

  it("is silent when the file is already gone", async () => {
    // ENOENT is the normal case, not an error: whichever of the two
    // cleanup paths runs second always finds nothing.
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => logger);

    await expect(removeTempFile(tmp())).resolves.toBeUndefined();

    expect(warn).not.toHaveBeenCalled();
  });

  it("is safe to call twice", async () => {
    const file = tmp();
    fs.writeFileSync(file, "spooled");

    await removeTempFile(file);
    await expect(removeTempFile(file)).resolves.toBeUndefined();
  });

  it("warns but does not throw when the delete genuinely fails", async () => {
    // A failed cleanup is not a failed request — it must never propagate
    // into the response. A directory gives a non-ENOENT errno (EISDIR or
    // EPERM depending on platform).
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => logger);
    const dir = tmp();
    fs.mkdirSync(dir);

    try {
      await expect(removeTempFile(dir)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
