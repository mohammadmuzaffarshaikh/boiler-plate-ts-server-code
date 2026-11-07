import { Request, Response, NextFunction } from "express";
import httpStatus from "http-status";
import { Prisma } from "@prisma/client";
import config from "../config/config";
import logger from "../config/logger";
import ApiError from "../utils/api-error";
import { redactUrl } from "../utils/redact";

/**
 * Map a Prisma failure onto an HTTP answer.
 *
 * Without this every database error is an unexplained 500: a unique
 * constraint lost to a race reads the same as a crash, and a database that
 * has gone away reads the same as a bug in our code. Worse, the raw Prisma
 * message is a multi-line code frame quoting our own source — fine in a log,
 * not something to hand a client.
 *
 * The messages below are deliberately ours and deliberately vague about
 * which column or constraint was involved; naming it leaks the schema.
 *
 * @returns An ApiError, or null when the error is not from Prisma.
 */
const fromPrismaError = (err: unknown): ApiError | null => {
  // The database is unreachable, the URL is wrong, or TLS failed. Nothing is
  // wrong with the request, so 503 with Retry-After semantics is the honest
  // answer and keeps these out of the 5xx bug budget.
  if (err instanceof Prisma.PrismaClientInitializationError) {
    return new ApiError(
      httpStatus.SERVICE_UNAVAILABLE,
      "The service is temporarily unavailable. Please try again shortly.",
    );
  }

  // A query we built wrong — always our bug, never the caller's.
  if (err instanceof Prisma.PrismaClientValidationError) {
    return new ApiError(
      httpStatus.INTERNAL_SERVER_ERROR,
      "Internal Server Error",
      false,
    );
  }

  // A dropped connection mid-query, or a panic in the query engine. Both are
  // ours to investigate, and neither message is fit to return, so they get a
  // clean 500 rather than falling through to the generic branch where the raw
  // Prisma text would become the client-facing message.
  if (
    err instanceof Prisma.PrismaClientUnknownRequestError ||
    err instanceof Prisma.PrismaClientRustPanicError
  ) {
    return new ApiError(
      httpStatus.INTERNAL_SERVER_ERROR,
      "Internal Server Error",
      false,
    );
  }

  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return null;

  switch (err.code) {
    case "P2002": // unique constraint
      return new ApiError(
        httpStatus.CONFLICT,
        "That record already exists.",
      );
    case "P2003": // foreign key constraint
      return new ApiError(
        httpStatus.BAD_REQUEST,
        "A referenced record does not exist.",
      );
    case "P2025": // required record not found
      return new ApiError(httpStatus.NOT_FOUND, "Record not found.");
    case "P1001": // cannot reach database
    case "P1002": // timed out
    case "P1008": // operation timed out
    case "P1017": // server closed the connection
      return new ApiError(
        httpStatus.SERVICE_UNAVAILABLE,
        "The service is temporarily unavailable. Please try again shortly.",
      );
    default:
      // Unmapped codes stay 500 and non-operational, so production masks
      // them and the real detail is only in the log.
      return new ApiError(
        httpStatus.INTERNAL_SERVER_ERROR,
        "Internal Server Error",
        false,
      );
  }
};

// Error converter middleware
const errorConverter = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  let error = err;

  if (!(error instanceof ApiError)) {
    // Prisma first: its errors carry no statusCode, so the generic branch
    // below would turn every one of them into an opaque 500.
    const prismaError = fromPrismaError(error);
    if (prismaError) {
      // The original message never reaches the client, but it is the only
      // thing that says what actually failed, so keep it for the log.
      logger.error(`[Database] ${(error as Error).message.split("\n").pop()?.trim()}`);
      return next(prismaError);
    }

    const statusCode = error.statusCode || httpStatus.INTERNAL_SERVER_ERROR;
    const message =
      error.message || httpStatus[statusCode as keyof typeof httpStatus];
    // A 4xx raised by a library (body-parser's 413, a malformed-JSON 400) is a
    // normal client error, so mark it operational and let its status and
    // message survive. Only 5xx is treated as unexpected and masked in
    // production by errorHandler below — without this, every library 4xx was
    // reported to clients as a generic 500.
    const isOperational = statusCode >= 400 && statusCode < 500;
    error = new ApiError(statusCode, message, isOperational, err.stack);
  }

  next(error);
};

// Error handler middleware
const errorHandler = (
  err: ApiError,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  let { statusCode, message } = err;

  // Decided before any masking, because masking is exactly what makes the
  // log the only surviving record.
  const isUnexpected =
    !err.isOperational || statusCode >= httpStatus.INTERNAL_SERVER_ERROR;

  if (config.ENV === "production" && !err.isOperational) {
    statusCode = httpStatus.INTERNAL_SERVER_ERROR;
    message = httpStatus[httpStatus.INTERNAL_SERVER_ERROR];
  }

  res.locals.errorMessage = err.message;

  const response = {
    code: statusCode,
    message,
    ...(config.ENV === "development" && { stack: err.stack }),
  };

  // Logged in EVERY environment, not just development. Production rewrites
  // the response to a bare "Internal Server Error", so without this line a
  // crash left nothing behind anywhere but morgan's one-line summary — the
  // stack was simply gone. The Prisma branch in `errorConverter` has always
  // logged; this is the generic branch catching up, and it is what
  // docs/decisions.md §10 and CLAUDE.md's "keep the detail in the log"
  // already claimed happened.
  if (isUnexpected) {
    logger.error(
      // Redacted for the same reason morgan's `:url` is — see `redactUrl`.
      // This line carries a stack trace, so it is the one most likely to be
      // copied into a ticket.
      `[${req.method} ${redactUrl(req.originalUrl)}] ${err.message}\n${err.stack ?? "<no stack>"}`,
    );
  }

  // The response may already be on the wire — a stream that failed mid-body,
  // a client that aborted, anything that threw after the first write. Calling
  // `res.send()` then throws ERR_HTTP_HEADERS_SENT out of `setHeader`.
  //
  // That throw does NOT reach `process.on("uncaughtException")`: router's
  // `Layer.handleError` wraps this handler in a try/catch, so the process is
  // never at risk. What it does instead is hand the request to Express's
  // finalhandler, which prints a second, raw stack straight to stderr —
  // around winston, around morgan, around the redaction two lines above —
  // and then destroys the socket.
  //
  // `next(err)` reaches that same finalhandler deliberately, without the
  // throw and without the unformatted dump. Logging stays above this guard:
  // a half-written response is exactly the case where the line above is the
  // only readable record of what went wrong.
  if (res.headersSent) {
    next(err);
    return;
  }

  res.status(statusCode).send(response);
};

export { errorConverter, errorHandler };
