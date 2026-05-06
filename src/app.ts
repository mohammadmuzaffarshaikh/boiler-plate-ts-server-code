import express, {
  Request,
  Response,
  NextFunction,
  Express,
} from "express";
import helmet from "helmet";
import compression from "compression";
import cors, { CorsOptions } from "cors";
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

const app: Express = express();

if (config.ENV !== "test") {
  app.use(morgan.successHandler);
  app.use(morgan.errorHandler);
}

app.use(helmet());
app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(compression());

const allowedOrigins = config.CORS.ALLOWED_ORIGINS;
const corsOptions: CorsOptions = {
  origin:
    allowedOrigins.length > 0
      ? (origin, cb) => {
          if (!origin || allowedOrigins.includes(origin)) {
            return cb(null, true);
          }
          return cb(new Error(`Origin ${origin} not allowed by CORS`));
        }
      : true,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Cookie"],
};
app.use(cors(corsOptions));

app.use(passport.initialize());
passport.use("jwt", jwtStrategy);

if (config.ENV === "production") {
  app.use("/auth", authLimiter);
}

logger.info("Mounting routes...");
app.use("/api", routes);
logger.info("Routes mounted successfully");

app.use((req: Request, res: Response, next: NextFunction) => {
  next(new ApiError(httpStatus.NOT_FOUND, "Not found"));
});

app.use(errorConverter);
app.use(errorHandler);

export default app;
