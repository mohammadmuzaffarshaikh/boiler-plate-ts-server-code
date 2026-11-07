import Joi, { ObjectSchema } from "joi";
import { password } from "./custom.validation";
import { roles } from "../config/constants";

// Define the interface for validation schemas
interface ValidationSchema {
  body?: ObjectSchema;
  query?: ObjectSchema;
  params?: ObjectSchema;
}

/**
 * Every id in this project is a Postgres uuid (`@default(uuid())`), so route
 * params are validated with Joi's built-in matcher. There used to be a shared
 * `objectId` helper here that matched a 24-character hexadecimal Mongo
 * ObjectId — carried over from a Mongoose codebase, it would have rejected
 * every id this API can produce. `Joi.string().uuid()` accepts v4 (what
 * Prisma generates today) and v7, and rejects a Mongo id.
 */
const uuid = Joi.string().uuid();

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
    userId: uuid.required(),
  }),
};

const updateUser: ValidationSchema = {
  params: Joi.object({
    userId: uuid.required(),
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
    userId: uuid.required(),
  }),
};

const updateUserRole: ValidationSchema = {
  params: Joi.object({
    userId: uuid.required(),
  }),
  body: Joi.object()
    .keys({
      role: Joi.string().required().valid(...roles),
    })
    .min(1),
};

const deleteUser: ValidationSchema = {
  params: Joi.object({
    userId: uuid.required(),
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
