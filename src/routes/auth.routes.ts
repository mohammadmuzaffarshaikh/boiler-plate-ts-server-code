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

export default router;
