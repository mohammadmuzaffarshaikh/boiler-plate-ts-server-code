import express, { Request, Response, NextFunction, Express } from "express";
import helmet from "helmet";
import compression from "compression";
import cors from "cors";
import passport from "passport";
import httpStatus from "http-status";
import config from "./config/config";
import morgan from "./config/morgan";
import cookieParser from "cookie-parser";
import { jwtStrategy } from "./config/passport";
import { authLimiter } from "./middlewares/rate-limiter.middleware";
import routes from "./routes";
import { errorConverter, errorHandler } from "./middlewares/error.middleware";
import ApiError from "./utils/api-error";
import logger from "./config/logger";
import { parse } from "path";

const app: Express = express();

// Add types for Express middleware functions
if (config.env !== "test") {
  app.use(morgan.successHandler);
  app.use(morgan.errorHandler);
}

// Set necessary HTTP headers for app security
app.use(helmet());

// JSON requests are received as plain text. We need to parse the JSON request body.
app.use(express.json());

// Parse cookies from request headers
app.use(cookieParser());

// Parse urlencoded request body if provided with any of the requests
app.use(express.urlencoded({ extended: true }));

// Using gzip compression for faster transfer of response data
app.use(compression());

// Enable CORS to accept requests from any frontend domain, all possible HTTP methods, and necessary items in request headers
app.use(cors({ origin: "*" }));

// Initialize JWT authentication
app.use(passport.initialize());

// Define JWT token authentication strategy
passport.use("jwt", jwtStrategy);

// Limit repeated failed requests to auth endpoints
if (config.env === "production") {
  app.use("/auth", authLimiter);
}

// Mount API routes
logger.info("Mounting routes...");
app.use("/api", routes);
logger.info("Routes mounted successfully");

// Send back a 404 error for any unknown API request
app.use((req: Request, res: Response, next: NextFunction) => {
  console.log(`404 - Route not found: ${req.originalUrl}`);
  next(new ApiError(httpStatus.NOT_FOUND, "Not found"));
});

// Convert error to ApiError, if the request was rejected or it throws an error
app.use(errorConverter);

// Handle the error
app.use(errorHandler);

export default app;
