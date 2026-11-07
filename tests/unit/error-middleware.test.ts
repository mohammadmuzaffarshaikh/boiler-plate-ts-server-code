import express, { Express, Request, Response, NextFunction } from "express";
import request from "supertest";
import httpStatus from "http-status";
import { Prisma } from "@prisma/client";
import { errorConverter, errorHandler } from "../../src/middlewares/error.middleware";
import ApiError from "../../src/utils/api-error";
import config from "../../src/config/config";
import logger from "../../src/config/logger";

/**
 * How failures become HTTP answers.
 *
 * Prisma's errors carry no `statusCode`, so without the mapping every
 * database problem is an identical, unexplained 500 — a unique constraint
 * lost to a race reads the same as a crash, and a database that has gone
 * away reads the same as a bug in our code.
 *
 * The raw Prisma message is a multi-line code frame quoting our own source.
 * Several tests below assert it never reaches the client.
 */
const appThrowing = (error: unknown): Express => {
  const app = express();
  app.get("/boom", (_req: Request, _res: Response, next: NextFunction) => next(error));
  app.use(errorConverter, errorHandler);
  return app;
};

const known = (code: string) =>
  new Prisma.PrismaClientKnownRequestError(
    `\nInvalid \`prisma.user.create()\` invocation in\n/src/services/user.service.ts:12\n` +
      `Unique constraint failed on the fields: (\`email\`)`,
    { code, clientVersion: "7.10.1" },
  );

describe("error middleware", () => {
  describe("Prisma errors", () => {
    it.each([
      ["P2002 unique constraint", "P2002", httpStatus.CONFLICT],
      ["P2003 foreign key", "P2003", httpStatus.BAD_REQUEST],
      ["P2025 record not found", "P2025", httpStatus.NOT_FOUND],
      ["P1001 cannot reach database", "P1001", httpStatus.SERVICE_UNAVAILABLE],
      ["P1002 connection timed out", "P1002", httpStatus.SERVICE_UNAVAILABLE],
      ["P1017 server closed the connection", "P1017", httpStatus.SERVICE_UNAVAILABLE],
    ])("maps %s to %i", async (_label, code, expected) => {
      const res = await request(appThrowing(known(code))).get("/boom");
      expect(res.status).toBe(expected);
    });

    it("maps an unknown Prisma code to 500", async () => {
      const res = await request(appThrowing(known("P9999"))).get("/boom");
      expect(res.status).toBe(httpStatus.INTERNAL_SERVER_ERROR);
    });

    it("maps an initialization failure to 503, not 500", async () => {
      // The database is unreachable or the URL is wrong. Nothing is wrong
      // with the request, so this should not count against the bug budget.
      const error = new Prisma.PrismaClientInitializationError(
        "Can't reach database server at localhost:5432",
        "7.10.1",
      );
      const res = await request(appThrowing(error)).get("/boom");
      expect(res.status).toBe(httpStatus.SERVICE_UNAVAILABLE);
    });

    it("never returns Prisma's message, file paths or SQL to the client", async () => {
      const res = await request(appThrowing(known("P2002"))).get("/boom");
      const body = JSON.stringify(res.body);

      expect(body).not.toContain("prisma.user.create");
      expect(body).not.toContain("user.service.ts");
      expect(body).not.toContain("Unique constraint failed");
      expect(res.body.message).toBe("That record already exists.");
    });

    it("does not name the column that collided", async () => {
      // Naming it leaks the schema to anyone who can trigger a conflict.
      const res = await request(appThrowing(known("P2002"))).get("/boom");
      expect(res.body.message).not.toContain("email");
    });
  });

  describe("non-Prisma errors", () => {
    it("passes an ApiError through untouched", async () => {
      const res = await request(
        appThrowing(new ApiError(httpStatus.IM_A_TEAPOT, "I am a teapot")),
      ).get("/boom");

      expect(res.status).toBe(httpStatus.IM_A_TEAPOT);
      expect(res.body.message).toBe("I am a teapot");
    });

    it("keeps a library 4xx as a 4xx", async () => {
      // body-parser's 413 and malformed-JSON 400 arrive this way; they are
      // ordinary client errors, not server faults.
      const libraryError = Object.assign(new Error("request entity too large"), {
        statusCode: 413,
      });
      const res = await request(appThrowing(libraryError)).get("/boom");

      expect(res.status).toBe(413);
      expect(res.body.message).toBe("request entity too large");
    });

    it("treats a bare Error as a 500", async () => {
      const res = await request(appThrowing(new Error("something broke"))).get("/boom");
      expect(res.status).toBe(httpStatus.INTERNAL_SERVER_ERROR);
    });

    it("always answers in the { code, message } envelope", async () => {
      const res = await request(appThrowing(known("P2025"))).get("/boom");
      expect(res.body).toMatchObject({
        code: httpStatus.NOT_FOUND,
        message: expect.any(String),
      });
    });
  });

  describe("what reaches the log", () => {
    /**
     * Production rewrites an unexpected failure to a bare
     * `{ code: 500, message: "Internal Server Error" }`, so the log line is
     * the ONLY surviving record of what actually happened.
     *
     * It used to be written only when ENV was development — which is to say,
     * never where it mattered. A TypeError in production left nothing behind
     * but morgan's one-line summary; the stack was simply gone. Both
     * docs/decisions.md §10 and CLAUDE.md's "keep the detail in the log"
     * already claimed otherwise.
     */
    const inEnv = async (
      env: string,
      error: unknown,
    ): Promise<jest.SpyInstance> => {
      const previous = config.ENV;
      const spy = jest.spyOn(logger, "error").mockImplementation(() => logger);
      config.ENV = env;
      try {
        await request(appThrowing(error)).get("/boom");
        return spy;
      } finally {
        config.ENV = previous;
      }
    };

    it("logs an unexpected failure in production", async () => {
      // THE REGRESSION.
      const spy = await inEnv("production", new Error("TypeError: x of undefined"));

      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("TypeError: x of undefined"),
      );
    });

    it("logs the stack, not just the message", async () => {
      const spy = await inEnv("production", new Error("boom"));

      expect(spy).toHaveBeenCalledWith(expect.stringContaining("at "));
    });

    it("logs the method and path, so the line is actionable", async () => {
      const spy = await inEnv("production", new Error("boom"));

      expect(spy).toHaveBeenCalledWith(expect.stringContaining("GET /boom"));
    });

    it("logs in development too", async () => {
      const spy = await inEnv("development", new Error("boom"));
      expect(spy).toHaveBeenCalled();
    });

    it("does not log an ordinary 4xx", async () => {
      // A client sending a bad request is not an incident. Logging every
      // 400 at error level is how a log stops being read.
      const spy = await inEnv(
        "production",
        new ApiError(httpStatus.BAD_REQUEST, "Missing email"),
      );

      expect(spy).not.toHaveBeenCalled();
    });

    it("logs a deliberate but operational 5xx", async () => {
      // A 502 from R2 is operational — the message is safe to return — but
      // it is still a failure worth a line.
      const spy = await inEnv(
        "production",
        new ApiError(httpStatus.BAD_GATEWAY, "Storage provider rejected it"),
      );

      expect(spy).toHaveBeenCalled();
    });

    it("still masks the response even though it logged", async () => {
      const previous = config.ENV;
      jest.spyOn(logger, "error").mockImplementation(() => logger);
      config.ENV = "production";
      try {
        const res = await request(appThrowing(new Error("internal detail"))).get(
          "/boom",
        );

        expect(res.status).toBe(httpStatus.INTERNAL_SERVER_ERROR);
        expect(res.body.message).toBe("Internal Server Error");
        expect(JSON.stringify(res.body)).not.toContain("internal detail");
      } finally {
        config.ENV = previous;
      }
    });
  });
  describe("a response that has already begun", () => {
    /**
     * A handler can fail after the first byte is out — a stream that dies
     * mid-body, a client that aborts, a `compression()` wrapper that throws.
     * `res.status().send()` at that point throws ERR_HTTP_HEADERS_SENT.
     *
     * The process is not at risk: router's `Layer.handleError` wraps this
     * handler in a try/catch. What the throw costs is the log — Express's
     * finalhandler prints its own raw, unredacted stack to stderr, around
     * every format and filter this file exists to apply. Delegating reaches
     * the same finalhandler without that.
     */
    const halfSent = (): { res: Response; next: jest.Mock } => {
      const next = jest.fn();
      const res = {
        headersSent: true,
        locals: {},
        status: jest.fn().mockReturnThis(),
        // What Node really does once the head is out: `res.send` reaches
        // `setHeader`, which throws. A mock that quietly records the call
        // would let the unguarded version pass this suite.
        send: jest.fn(() => {
          const error: NodeJS.ErrnoException = new Error(
            "Cannot set headers after they are sent to the client",
          );
          error.code = "ERR_HTTP_HEADERS_SENT";
          throw error;
        }),
      } as unknown as Response;
      return { res, next };
    };

    const req = { method: "GET", originalUrl: "/files/stream" } as Request;

    it("does not throw", () => {
      // THE REGRESSION.
      const { res, next } = halfSent();
      jest.spyOn(logger, "error").mockImplementation(() => logger);

      expect(() =>
        errorHandler(
          new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "stream died"),
          req,
          res,
          next,
        ),
      ).not.toThrow();
    });

    it("does not try to rewrite the response", () => {
      const { res, next } = halfSent();
      jest.spyOn(logger, "error").mockImplementation(() => logger);

      errorHandler(
        new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "stream died"),
        req,
        res,
        next,
      );

      expect(res.status).not.toHaveBeenCalled();
      expect(res.send).not.toHaveBeenCalled();
    });

    it("hands the error on, so the socket is still closed", () => {
      const { res, next } = halfSent();
      jest.spyOn(logger, "error").mockImplementation(() => logger);
      const error = new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "stream died");

      errorHandler(error, req, res, next);

      expect(next).toHaveBeenCalledWith(error);
    });

    it("still logs, because nothing else will", () => {
      // The guard sits below the log on purpose. A half-written response is
      // the case where this line is the only record a reader ever gets.
      const { res, next } = halfSent();
      const spy = jest.spyOn(logger, "error").mockImplementation(() => logger);

      errorHandler(
        new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "stream died"),
        req,
        res,
        next,
      );

      expect(spy).toHaveBeenCalledWith(expect.stringContaining("stream died"));
    });

    it("answers normally when the response has not begun", () => {
      // The guard must not swallow the ordinary path.
      const next = jest.fn();
      const res = {
        headersSent: false,
        locals: {},
        status: jest.fn().mockReturnThis(),
        send: jest.fn().mockReturnThis(),
      } as unknown as Response;

      errorHandler(
        new ApiError(httpStatus.BAD_REQUEST, "Missing email"),
        req,
        res,
        next,
      );

      expect(res.status).toHaveBeenCalledWith(httpStatus.BAD_REQUEST);
      expect(next).not.toHaveBeenCalled();
    });
  });
});
