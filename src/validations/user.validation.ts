import Joi, { ObjectSchema } from "joi";
import { password, objectId } from "./custom.validation";
import { roles } from "../config/constants";

// Define the interface for validation schemas
interface ValidationSchema {
  body?: ObjectSchema;
  query?: ObjectSchema;
  params?: ObjectSchema;
}

// Create the validation schemas with proper types
const createUser: ValidationSchema = {
  body: Joi.object({
    email: Joi.string().required().email(),
    password: Joi.string().required().custom(password),
    firstName: Joi.string().required(),
    lastName: Joi.string().required(),
    role: Joi.string().required().valid(...roles),
  }),
};

const inviteUser: ValidationSchema = {
  body: Joi.object({
    email: Joi.string().required().email(),
    firstName: Joi.string().required(),
    lastName: Joi.string().required(),
    role: Joi.string().valid(...roles),
  }),
};

const activateUser: ValidationSchema = {
  query: Joi.object({
    token: Joi.string().required(),
  }),
  body: Joi.object({
    password: Joi.string().required().custom(password),
  }),
};

const getUsers: ValidationSchema = {
  query: Joi.object({
    search: Joi.string().optional(),
    role: Joi.array().items(Joi.string()).optional(),
    status: Joi.array().items(Joi.string()).optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().optional().default(10),
    page: Joi.number().integer().optional().default(1),
  }),
};

const getUser: ValidationSchema = {
  params: Joi.object({
    userId: Joi.string().custom(objectId),
  }),
};

const updateUser: ValidationSchema = {
  params: Joi.object({
    userId: Joi.required().custom(objectId),
  }),
  body: Joi.object()
    .keys({
      email: Joi.string().email(),
      password: Joi.string().custom(password),
      firstName: Joi.string().required(),
      lastName: Joi.string().required(),
      role: Joi.string(),
    })
    .min(1),
};

const deactivateAndReactivateUser: ValidationSchema = {
  params: Joi.object({
    userId: Joi.required().custom(objectId),
  }),
};

const updateUserRole: ValidationSchema = {
  params: Joi.object({
    userId: Joi.required().custom(objectId),
  }),
  body: Joi.object()
    .keys({
      role: Joi.string().required().valid(...roles),
    })
    .min(1),
};

const deleteUser: ValidationSchema = {
  params: Joi.object({
    userId: Joi.string().custom(objectId),
  }),
};

export default {
  createUser,
  getUsers,
  getUser,
  updateUser,
  deleteUser,
  inviteUser,
  activateUser,
  deactivateAndReactivateUser,
  updateUserRole,
};
