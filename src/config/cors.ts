import { CorsOptions } from "cors";
import httpStatus from "http-status";
import ApiError from "../utils/api-error";

/**
 * The cross-origin policy, as a function of the configured allow-list.
 *
 * Its own module so the policy can be exercised directly. Inline in `app.ts`
 * it was only reachable by booting the whole application with a doctored
 * environment, which is why the two defects below went unnoticed.
 *
 * @param allowedOrigins Exact origins permitted to call the API. An EMPTY
 *   list means "reflect any origin", which `config.ts` refuses to allow in
 *   production — with `credentials: true` it lets any website make
 *   credentialed calls as the visitor and read the replies.
 */
export const buildCorsOptions = (allowedOrigins: string[]): CorsOptions => ({
  origin:
    allowedOrigins.length > 0
      ? (origin, cb) => {
          // A request with no Origin header is not a browser cross-site
          // request at all — curl, a server-to-server call, a same-origin
          // navigation — so there is nothing for CORS to protect.
          if (!origin || allowedOrigins.includes(origin)) {
            return cb(null, true);
          }

          // An ApiError, NOT a bare Error. `errorConverter` reads
          // `statusCode` off the error; a plain Error has none, so a refused
          // origin became a non-operational 500 — counted against the 5xx
          // budget, masked to "Internal Server Error" in production, and
          // indistinguishable from a crash on a dashboard.
          return cb(
            new ApiError(httpStatus.FORBIDDEN, "Origin not allowed by CORS."),
          );
        }
      : true,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Cookie"],
});
