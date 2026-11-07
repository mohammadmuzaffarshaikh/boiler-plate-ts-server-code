import express, { Router } from "express";

/**
 * The storefront, mounted at `/api/store`.
 *
 * Empty on purpose. The namespace is reserved now, while the admin surface is
 * being moved under `/api/app`, so that the first customer-facing endpoint is
 * a new file in this directory rather than a decision about where it goes —
 * and so a reviewer can tell at a glance that nothing shopper-facing exists
 * yet.
 *
 * What lands here is NOT the `/api/app` routers re-exported under a second
 * prefix. Customers are a separate table with their own credentials, their
 * own session rows and their own signing secret, so that a storefront token
 * is structurally unusable against the admin API — not merely rejected by a
 * check somebody remembered to write. The design is in docs/decisions.md §2
 * (the identity split) and §13 (sessions and tokens per principal), and none
 * of it is implemented.
 *
 * Until then every path under `/api/store` falls through to the 404 handler
 * in `src/app.ts`, which is the honest answer.
 */
const router: Router = express.Router();

export default router;
