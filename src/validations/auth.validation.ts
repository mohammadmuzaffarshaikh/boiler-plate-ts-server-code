import Joi, { ObjectSchema } from "joi";
import { password } from "./custom.validation";

// Define the shape of each validation schema
interface ValidationSchema {
  body?: ObjectSchema;
  query?: ObjectSchema;
}

// Validation schema for registering a user
const register: ValidationSchema = {
  body: Joi.object().keys({
    firstName: Joi.string().required(),
    lastName: Joi.string().required(),
    email: Joi.string().required().email(),
    password: Joi.string().required().custom(password),
  }),
};

// Validation schema for logging in a user
const login: ValidationSchema = {
  body: Joi.object().keys({
    email: Joi.string().required().email(),
    password: Joi.string().required(),
  }),
};

// Validation schema for verifying OTP
const verifyOtp: ValidationSchema = {
  body: Joi.object().keys({
    email: Joi.string().required().email(),
    otp: Joi.string().required(),
  }),
};

// Validation schema for social login
const socialLogin: ValidationSchema = {
  body: Joi.object().keys({
    token: Joi.string().required(),
  }),
};

// Validation schema for logging out
const logout: ValidationSchema = {
  body: Joi.object().keys({
    token: Joi.string().required(),
  }),
};

// Validation schema for forgot password
const forgotPassword: ValidationSchema = {
  body: Joi.object().keys({
    email: Joi.string().email().required(),
  }),
};

// Validation schema for resetting password
const resetPassword: ValidationSchema = {
  query: Joi.object().keys({
    token: Joi.string().required(),
  }),
  body: Joi.object().keys({
    password: Joi.string().required().custom(password),
  }),
};

export {
  register,
  login,
  logout,
  forgotPassword,
  resetPassword,
  socialLogin,
  verifyOtp,
};
