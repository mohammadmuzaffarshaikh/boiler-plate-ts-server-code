import express, { Router } from "express";
import validate from "../../middlewares/validate.middleware";
import { authValidation } from "../../validations";
import { authController } from "../../controllers";
import { auth } from "../../middlewares/auth.middleware";
import {
  authLimiter,
  passwordResetEmailLimiter,
  passwordResetIpLimiter,
} from "../../middlewares/rate-limiter.middleware";

export interface AuthRouterOptions {
  /**
   * Mount `POST /register`.
   *
   * Off everywhere but development. `register` writes a row to `users`, and
   * every row in `users` is staff (docs/decisions.md §2), so leaving it
   * reachable in production is self-service creation of a staff account —
   * precisely the hole the invitation flow in §3 exists to close. Until that
   * flow is built this is how a developer gets a first account locally
   * without running the seed.
   *
   * It is a mount-time decision rather than a check inside the handler, so
   * outside development the path does not exist at all and answers 404. A
   * handler that returned 403 would be confirming the endpoint is there.
   */
  allowSelfRegistration: boolean;
}

/**
 * The administration app's auth surface, mounted at `/api/app/auth`.
 *
 * Storefront auth is NOT this router with a different prefix. Customers get
 * their own table, their own credentials and their own signing secret, so
 * that a storefront token cannot be replayed against this API even if a
 * claim check is forgotten on some future route. See docs/decisions.md §13.
 *
 * Two credential shapes, one login. `POST /login` sets httpOnly cookies for a
 * browser and returns no tokens at all; a client that sends
 * `client: "native"` with a PKCE challenge gets a single-use authorization
 * code instead and trades it at `POST /token-exchange`. The body copy of the
 * tokens that used to serve both is gone — see docs/decisions.md §28.
 *
 * Taking the registration switch as an argument rather than reading
 * `config.ENV` in here keeps the policy visible at the mount site
 * (`src/routes/app/index.ts`), where a reader goes to find out what is
 * exposed — and lets the specs cover the endpoint itself instead of only
 * being able to prove it is absent.
 */
const buildAuthRouter = ({
  allowSelfRegistration,
}: AuthRouterOptions): Router => {
  const router: Router = express.Router();

  if (allowSelfRegistration) {
    router.post(
      "/register",
      authLimiter,
      validate(authValidation.register),
      authController.register
    );
  }

  router.post(
    "/login",
    authLimiter,
    validate(authValidation.login),
    authController.loginUserWithEmailAndPassword
  );

  router.post(
    "/google",
    authLimiter,
    validate(authValidation.googleLogin),
    authController.googleLogin
  );

  // The native half of the login handshake. Behind `authLimiter` like every
  // other credential endpoint: the code is single-use and short-lived, but
  // the verifier is not something an attacker should get to grind against.
  router.post(
    "/token-exchange",
    authLimiter,
    validate(authValidation.tokenExchange),
    authController.tokenExchange
  );

  // Two buckets on purpose: by IP, so one host can't sweep the user table; and
  // by email, so a botnet can't flood one person's inbox with reset mail.
  router.post(
    "/forgot-password",
    passwordResetIpLimiter,
    passwordResetEmailLimiter,
    validate(authValidation.forgotPassword),
    authController.forgotPassword
  );

  router.post(
    "/reset-password",
    authLimiter,
    validate(authValidation.resetPassword),
    authController.resetPassword
  );

  router.post(
    "/refresh",
    authLimiter,
    validate(authValidation.refreshToken),
    authController.handleRefreshToken
  );

  router.post("/logout", validate(authValidation.logout), authController.logout);

  router.get("/self", auth(), authController.self);

  return router;
};

export default buildAuthRouter;
