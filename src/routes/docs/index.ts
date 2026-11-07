import express, { Request, Response, Router } from "express";
import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";
import swaggerDefinition from "./swagger-definition";

const router: Router = express.Router();

/**
 * Assemble the OpenAPI document.
 *
 * `apis` is intentionally empty: every path is declared as a typed object in
 * the sibling `*.docs.ts` files and spread into `swaggerDefinition`, rather
 * than scanned out of JSDoc comments. See the note at the top of
 * `auth.docs.ts` for why — comment scanning breaks in the compiled build.
 */
const specs = swaggerJsdoc({ swaggerDefinition, apis: [] });

/** Raw OpenAPI document, for client generators and schema diffing. */
router.get("/swagger.json", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "application/json");
  res.send(specs);
});

router.use("/", swaggerUi.serve);
router.get(
  "/",
  swaggerUi.setup(specs, {
    explorer: true,
    customSiteTitle: "Node Express Boilerplate API docs",
  })
);

export default router;
