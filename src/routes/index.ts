import express, { Router } from "express";
import authRoute from "./auth.routes";
import logger from "../config/logger";

// Define type for the route structure
interface Route {
  path: string;
  route: Router;
}

const router: Router = express.Router();

// Validate path format
const isValidPath = (path: string): boolean => {
  return /^\/[a-zA-Z0-9\-_/]*$/.test(path);
};

const defaultRoutes: Route[] = [
  {
    path: "/auth",
    route: authRoute,
  },
];

// Mount routes with validation
defaultRoutes.forEach((route) => {
  try {
    const path = route.path.startsWith("/") ? route.path : `/${route.path}`;
    
    if (!isValidPath(path)) {
      throw new Error(`Invalid path format: ${path}`);
    }

    
    // Use more specific route mounting
    router.use(path, (req, res, next) => {
      route.route(req, res, next);
    });

  } catch (error) {
    logger.error(`Failed to mount route ${route.path}:`, error);
    process.exit(1); // Exit if route mounting fails
  }
});

export default router;
