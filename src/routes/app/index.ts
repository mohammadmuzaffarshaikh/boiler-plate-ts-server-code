import express, { Router } from "express";
import config from "../../config/config";
import buildAuthRouter from "./auth.routes";
import fileRoute from "./file.routes";

/**
 * The administration app, mounted at `/api/app`.
 *
 * Everything under here authenticates against `users`, which is the staff
 * table — STAFF and ADMIN, nobody else. The storefront is a separate router
 * under `/api/store` with separate principals; the two never share a route
 * file, so "is this endpoint reachable by a shopper?" is answered by which
 * directory the file is in rather than by reading its middleware.
 */
const router: Router = express.Router();

router.use(
  "/auth",
  buildAuthRouter({
    // Development only. See AuthRouterOptions in ./auth.routes.ts — this is
    // the single switch that decides whether a staff account can be created
    // without an invitation, so it is stated here rather than buried in the
    // route file.
    allowSelfRegistration: config.ENV === "development",
  })
);

router.use("/files", fileRoute);

export default router;
