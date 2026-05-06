import Joi, { ObjectSchema } from "joi";
import { password } from "./custom.validation";

interface ValidationSchema {
  body?: ObjectSchema;
  query?: ObjectSchema;
}

const register: ValidationSchema = {
  body: Joi.object().keys({
    firstName: Joi.string().required(),
    lastName: Joi.string().required(),
    email: Joi.string().required().email(),
    password: Joi.string().required().custom(password),
  }),
};

const login: ValidationSchema = {
  body: Joi.object().keys({
    email: Joi.string().required().email(),
    password: Joi.string().required(),
  }),
};

const refreshToken: ValidationSchema = {
  body: Joi.object().keys({
    refreshToken: Joi.string().optional().allow(""),
  }),
};

const logout: ValidationSchema = {
  body: Joi.object().keys({
    refreshToken: Joi.string().optional().allow(""),
  }),
};

const forgotPassword: ValidationSchema = {
  body: Joi.object().keys({
    email: Joi.string().email().required(),
  }),
};

const resetPassword: ValidationSchema = {
  query: Joi.object().keys({
    token: Joi.string().required(),
  }),
  body: Joi.object().keys({
    password: Joi.string().required().custom(password),
  }),
};

export { register, login, refreshToken, logout, forgotPassword, resetPassword };
