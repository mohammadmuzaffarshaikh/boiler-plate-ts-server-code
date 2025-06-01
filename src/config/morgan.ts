import morgan, { StreamOptions } from "morgan";
import config from "./config";
import logger from "./logger";
import { Response, Request } from "express";

// Define custom tokens for morgan
morgan.token(
  "message",
  (req: Request, res: Response) => res.locals.errorMessage || ""
);

// Function to determine the IP format based on environment
const getIpFormat = (): string =>
  config.env === "production" ? ":remote-addr - " : "";

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
