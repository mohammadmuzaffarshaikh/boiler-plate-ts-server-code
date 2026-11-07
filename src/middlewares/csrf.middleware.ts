import { NextFunction, Request, Response } from "express";
import httpStatus from "http-status";
import config from "../config/config";
import { COOKIE_NAMES } from "../config/cookies-option";
import logger from "../config/logger";
import ApiError from "../utils/api-error";

/**
 * Cross-site request forgery, and why CORS was never going to stop it.
 *
 * In production the auth cookies are `SameSite=None` (`config/cookies-option`)
 * because the admin frontend is on a different origin to this API, and CORS
 * runs with `credentials: true`. The browser therefore attaches those cookies
 * to cross-site requests, and CORS does **not** prevent the request — it only
 * hides the *response* from a script that was not granted the origin.
 *
 * For anything the browser treats as a "simple" request that distinction is
 * the whole vulnerability. A `multipart/form-data` POST is simple: it is sent
 * without a preflight, the server executes it, and the attacker never needed
 * to read the reply. So any page a signed-in staff member visited could make
 * their browser run `POST /api/app/files` or `POST /api/app/auth/logout` with
 * their cookies attached. `PATCH` and `DELETE` are preflighted and were
 * always safe; `POST` was not.
 *
 * The check here is the server-side half CORS cannot do for us: on a
 * state-changing request that carries our cookies, the `Origin` header must
 * name an origin in `ALLOWED_ORIGINS`. Browsers have sent `Origin` on every
 * POST, PUT, PATCH and DELETE for years, and — this is the part that makes it
 * a control rather than a convention — a page cannot forge or suppress it.
 *
 * Deliberately NOT a CSRF token. A double-submit token is stronger in the
 * abstract, but it requires every client to read a cookie and echo it in a
 * header, which is an API contract change for a frontend that does not exist
 * yet. The origin check closes the same hole with no client cooperation. If a
 * token is wanted later, it layers on top of this rather than replacing it.
 */
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Whether the request carries a credential the *browser* attached by itself.
 *
 * This is the entire scope of CSRF. A native client authenticating with a
 * bearer token has to be given that token by someone; no third-party page can
 * make the browser produce one. Checking the cookies rather than the method
 * alone is what keeps the native and server-to-server callers — which send no
 * `Origin` at all — working untouched.
 */
const carriesCookieCredential = (req: Request): boolean =>
  Boolean(
    req.cookies?.[COOKIE_NAMES.access] ?? req.cookies?.[COOKIE_NAMES.refresh],
  );

const requireTrustedOrigin = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  // Production only. Outside it the cookies are `SameSite=Lax`, which already
  // withholds them from a cross-site POST, and a developer running a frontend
  // on an arbitrary port is the normal case.
  if (config.ENV !== "production") return next();
  if (!STATE_CHANGING.has(req.method)) return next();
  if (!carriesCookieCredential(req)) return next();

  const origin = req.get("Origin");

  // Kept in the log, not in the response — the client-facing message says
  // nothing about what the allowlist contains. Logged at warn because a
  // genuine hit here is either a misconfigured frontend or an attempt.
  if (!origin || !config.CORS.ALLOWED_ORIGINS.includes(origin)) {
    logger.warn(
      `[CSRF] Refused ${req.method} ${req.path} — Origin ${
        origin ?? "<absent>"
      } is not in ALLOWED_ORIGINS`,
    );

    return next(
      new ApiError(
        httpStatus.FORBIDDEN,
        "This request was blocked because it did not come from a recognised origin.",
      ),
    );
  }

  return next();
};

export { requireTrustedOrigin, carriesCookieCredential };
