import { Writable } from "node:stream";
import winston from "winston";
import logger from "../../src/config/logger";

/**
 * What survives a `logger.error(message, error)` call.
 *
 * The console transport is the only one the logger ships with, and it renders
 * through the logger's own format chain. Adding a second transport over a
 * capturing stream reads exactly what that chain produced, without mocking
 * the formats under test.
 */
const captured: string[] = [];
let sink: winston.transports.StreamTransportInstance;

beforeAll(() => {
  const stream = new Writable({
    write(chunk: unknown, _encoding: unknown, callback: () => void) {
      captured.push(String(chunk));
      callback();
    },
  });
  sink = new winston.transports.Stream({ stream });
  logger.add(sink);
});

afterAll(() => {
  logger.remove(sink);
});

const rendered = async (emit: () => void): Promise<string> => {
  captured.length = 0;
  emit();
  // The transport writes on the next tick.
  await new Promise((resolve) => setImmediate(resolve));
  return captured.join("");
};

const failing = (message: string): Error => {
  try {
    throw new Error(message);
  } catch (error) {
    return error as Error;
  }
};

describe("logger", () => {
  describe("an error passed beside the message", () => {
    /**
     * THE REGRESSION.
     *
     * `printf` renders `message` and nothing else. Winston's own `log()`
     * appends `meta.message` for an Error, so the text survived — but the
     * stack never did, and `format.splat()` could not help: with no `%` token
     * it merges the argument's *enumerable* keys onto `info`, and an Error
     * has none.
     *
     * `src/index.ts` logs this way on all four of its crash paths. The
     * `uncaughtException` handler at :181 is the one that matters: it logs,
     * then shuts the process down. Without the stack the only record of a
     * production crash named the error and not one line of where it came
     * from.
     */
    it("renders the stack, not just the error message", async () => {
      const line = await rendered(() =>
        logger.error("Unexpected error:", failing("db exploded")),
      );

      expect(line).toContain("db exploded");
      expect(line).toContain("at ");
      expect(line).toContain(__filename);
    });

    it("keeps the message that introduced it", async () => {
      const line = await rendered(() =>
        logger.error("Failed to start server", failing("EADDRINUSE")),
      );

      expect(line).toContain("Failed to start server");
    });

    it("does not print the error message twice", async () => {
      const line = await rendered(() =>
        logger.error("Unexpected error:", failing("once only")),
      );

      // Winston merges the error's message into `message`, and the stack's
      // header line says it again. One of the two has to go or every crash
      // line in production repeats itself.
      expect(line.match(/once only/g)).toHaveLength(1);
    });

    it("keeps the message when the error carries no stack", async () => {
      // Winston's own merge already put the text in `message`, and there are
      // no frames to add, so nothing is appended rather than an empty line.
      const error = new Error("no trace here");
      delete error.stack;

      const line = await rendered(() => logger.error("Degraded:", error));

      expect(line).toContain("Degraded: no trace here");
      expect(line).not.toContain("undefined");
      expect(line.trimEnd()).toMatch(/no trace here$/);
    });
  });

  describe("other trailing arguments", () => {
    it("renders plain object metadata instead of dropping it", async () => {
      // This was lost completely — not even the keys came through.
      const line = await rendered(() =>
        logger.error("[auth] refused", { userId: "u-1", reason: "locked" }),
      );

      expect(line).toContain("u-1");
      expect(line).toContain("locked");
    });

    it("still interpolates a message that carries format tokens", async () => {
      // When the message has a `%` token the trailing arguments are operands,
      // not metadata, and belong to `format.splat()`. Folding them in as well
      // would print each one twice.
      const line = await rendered(() => logger.info("port %d open", 3000));

      expect(line).toContain("port 3000 open");
      expect(line.match(/3000/g)).toHaveLength(1);
    });
  });

  describe("what has to keep working", () => {
    it("leaves a single-argument message alone", async () => {
      const line = await rendered(() => logger.info("Routes mounted successfully"));

      expect(line).toContain("info: Routes mounted successfully");
      expect(line.trimEnd()).toMatch(/Routes mounted successfully$/);
    });

    it("renders the stack when the Error itself is logged", async () => {
      // enumerateErrorFormat's job, and it is untouched.
      const line = await rendered(() => logger.error(failing("logged directly")));

      expect(line).toContain("logged directly");
      expect(line).toContain("at ");
    });

    it("prefixes every line with a timestamp and a level", async () => {
      const line = await rendered(() => logger.info("shape check"));

      expect(line).toMatch(/^\[.+\] info: shape check/);
    });
  });
});
