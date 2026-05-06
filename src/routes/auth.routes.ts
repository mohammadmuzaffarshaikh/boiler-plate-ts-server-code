import express, { Router } from "express";
import validate from "../middlewares/validate.middleware";
import { authValidation } from "../validations";
import { authController } from "../controllers";
import { auth } from "../middlewares/auth.middleware";

const router: Router = express.Router();

router.post(
  "/register",
  validate(authValidation.register),
  authController.register
);

router.post(
  "/login",
  validate(authValidation.login),
  authController.loginUserWithEmailAndPassword
);

router.post(
  "/forgot-password",
  validate(authValidation.forgotPassword),
  authController.forgotPassword
);

router.post(
  "/reset-password",
  validate(authValidation.resetPassword),
  authController.resetPassword
);

router.post(
  "/refresh",
  validate(authValidation.refreshToken),
  authController.handleRefreshToken
);

router.post(
  "/logout",
  validate(authValidation.logout),
  authController.logout
);

router.get("/self", auth(), authController.self);

export default router;
