import morgan, { StreamOptions } from "morgan";
import config from "./config";
import logger from "./logger";
import { Response, Request } from "express";
import { redactUrl } from "../utils/redact";

// Define custom tokens for morgan
morgan.token(
  "message",
  (req: Request, res: Response) => res.locals.errorMessage || ""
);

// Overrides morgan's built-in `:url`, which is `req.originalUrl` verbatim.
// Access logs are the longest-lived copy of a request — stdout, the
// aggregator, a pasted screenshot — so a credential that reaches a query
// string reaches all of them. The reset token that used to travel that way
// now goes in the body; this makes sure the next one cannot repeat it.
// Parameter names survive, so the line still says what was called with what.
morgan.token("url", (req: Request) =>
  redactUrl(req.originalUrl || req.url || "")
);

// Function to determine the IP format based on environment
const getIpFormat = (): string =>
  config.ENV === "production" ? ":remote-addr - " : "";

// Define the success and error response formats
const successResponseFormat = `${getIpFormat()}:method :url :status - :response-time ms`;
const errorResponseFormat = `${getIpFormat()}:method :url :status - :response-time ms - message: :message`;

// Success handler for morgan (logs successful responses)
const successHandler = morgan(successResponseFormat, {
  skip: (req, res) => res.statusCode >= 400,
  stream: {
    write: (message: string) => logger.info(message.trim()),
  } as StreamOptions,
});

// Error handler for morgan (logs error responses)
const errorHandler = morgan(errorResponseFormat, {
  skip: (req, res) => res.statusCode < 400,
  stream: {
    write: (message: string) => logger.error(message.trim()),
  } as StreamOptions,
});

// Export handlers
export default {
  successHandler,
  errorHandler,
};
