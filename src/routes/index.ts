import express, { Router } from "express";
import appRoutes from "./app";
import storeRoutes from "./store";

const router: Router = express.Router();

// The API has exactly two namespaces, and which one an endpoint lives in is
// a statement about who may call it:
//
//   /api/app    the administration app. Authenticates against `users`, which
//               holds staff and nobody else.
//   /api/store  the storefront. Authenticates against customers, who are a
//               separate table with a separate signing secret. Nothing is
//               mounted here yet — see src/routes/store/index.ts.
//
// Nothing is mounted at the bare `/api` root any more. The old `/api/auth`
// and `/api/files` were unprefixed and therefore said nothing about their
// audience; `tests/integration/*.routes.test.ts` pins that they are gone,
// because a path that quietly keeps working is how two namespaces drift back
// into one.
//
// NOTE: /api/health is NOT here. It is mounted in app.ts ahead of the global
// rate limiter, so a load balancer polling it cannot be throttled out of its
// own health check.
router.use("/app", appRoutes);
router.use("/store", storeRoutes);

export default router;
