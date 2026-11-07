import express, {
  Request,
  Response,
  NextFunction,
  Express,
} from "express";
import helmet from "helmet";
import compression from "compression";
import cors, { CorsOptions } from "cors";
import { buildCorsOptions } from "./config/cors";
import passport from "passport";
import httpStatus from "http-status";
import config from "./config/config";
import morgan from "./config/morgan";
import cookieParser from "cookie-parser";
import { jwtStrategy } from "./config/passport";
import { globalLimiter } from "./middlewares/rate-limiter.middleware";
import { requireTrustedOrigin } from "./middlewares/csrf.middleware";
import routes from "./routes";
import healthRoute from "./routes/health.routes";
import docsRoute from "./routes/docs";
import { errorConverter, errorHandler } from "./middlewares/error.middleware";
import ApiError from "./utils/api-error";
import logger from "./config/logger";

const app: Express = express();

// How many reverse-proxy hops to trust when deriving req.ip. Everything
// IP-based — rate limiting, request logs, session records — reads that value,
// so an unset or over-permissive setting silently breaks all three: unset
// behind a load balancer buckets every visitor under the balancer's own IP,
// while a blanket `true` lets any caller forge X-Forwarded-For and mint a
// fresh bucket per request.
app.set("trust proxy", config.TRUST_PROXY);

if (config.ENV !== "test") {
  app.use(morgan.successHandler);
  app.use(morgan.errorHandler);
}

app.use(helmet());

// CORS goes BEFORE the body parsers, deliberately. A body-parser rejection
// (the BODY_LIMIT 413, or a malformed-JSON 400) short-circuits the chain, so
// anything registered after it never attaches CORS headers — and a browser
// then reports an opaque CORS failure instead of the 413 the limit exists to
// communicate. Preflights also get answered without parsing a body.
const allowedOrigins = config.CORS.ALLOWED_ORIGINS;

// An empty list means `origin: true` — reflect any Origin — which together
// with `credentials: true` lets any site make credentialed calls with the
// visitor's cookies and read the answers. config.ts refuses to boot in
// production without the list; everywhere else it is the convenient default
// for a frontend on an arbitrary port, so say so out loud rather than
// leaving it to be discovered.
if (allowedOrigins.length === 0) {
  logger.warn(
    "[CORS] ALLOWED_ORIGINS is empty — every origin is allowed, with " +
      "credentials. Acceptable in development; config.ts rejects it in " +
      "production.",
  );
}

const corsOptions: CorsOptions = buildCorsOptions(allowedOrigins);

app.use(cors(corsOptions));

// Cap body size so a single request can't exhaust memory before any handler
// or limiter sees it. Raise per-route for file uploads rather than globally.
app.use(express.json({ limit: config.BODY_LIMIT }));
app.use(cookieParser());
app.use(express.urlencoded({ extended: true, limit: config.BODY_LIMIT }));
app.use(compression());

// After cookieParser, because it reads the cookies to decide whether the
// request carries a browser-attached credential at all; before the routes,
// because a refusal must happen before anything acts on the request.
app.use(requireTrustedOrigin);

app.use(passport.initialize());
passport.use("jwt", jwtStrategy);

logger.info("Mounting routes...");
// Swagger UI, development only. Mounted at the app root rather than under /api
// so the docs sit at /docs; the documented paths themselves are still
// /api-prefixed. Outside development the route is never registered at all, so
// /docs (and /docs/swagger.json) fall through to the 404 handler below and the
// API surface is not published.
if (config.ENV === "development") {
  app.use("/docs", docsRoute);
  logger.info("API docs mounted at /docs (development only)");
}

// Health sits in front of the rate limiter on purpose. A load balancer polls
// it on a fixed interval from one address, which is exactly the shape the
// limiter exists to stop — and an instance being throttled out of its own
// health check would be reported as down while it was perfectly healthy.
app.use("/api/health", healthRoute);

// Blanket ceiling in front of every API route. Stricter per-endpoint limiters
// are attached inside the route files, closest to what they protect.
app.use("/api", globalLimiter, routes);
logger.info("Routes mounted successfully");

app.use((req: Request, res: Response, next: NextFunction) => {
  next(new ApiError(httpStatus.NOT_FOUND, "Not found"));
});

app.use(errorConverter);
app.use(errorHandler);

export default app;
