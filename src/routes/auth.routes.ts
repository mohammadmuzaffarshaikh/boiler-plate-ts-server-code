import express, { Router, Request, Response, NextFunction } from "express";
import validate from "../middlewares/validate.middleware";
import { authValidation } from "../validations";
import { authController } from "../controllers";

const router: Router = express.Router();

// Register route
router.post(
  "/register",
  validate(authValidation.register),
  authController.register
);

// Login route
router.post(
  "/login",
  validate(authValidation.login),
  authController.loginUserWithEmailAndPassword
);

// Forgot password route
router.post(
  "/forgot-password",
  validate(authValidation.forgotPassword),
  authController.forgotPassword
);

// Reset password route
router.post(
  "/reset-password",
  validate(authValidation.resetPassword),
  authController.resetPassword
);

// Refresh token route
router.post(
  "/refresh",
  validate(authValidation.refreshToken),
  authController.handleRefreshToken
);

// Logout route
router.post(
  "/logout",
  validate(authValidation.logout),
  authController.logout
);

export default router;
