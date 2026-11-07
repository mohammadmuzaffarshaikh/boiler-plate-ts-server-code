import Joi from "joi";
import httpStatus from "http-status";
import { Request, Response, NextFunction } from "express";
import ApiError from "../utils/api-error";

/** The request segments a schema may describe. */
interface ValidationSchema {
  params?: Joi.ObjectSchema;
  query?: Joi.ObjectSchema;
  body?: Joi.ObjectSchema;
}

const SEGMENTS = ["params", "query", "body"] as const;

/**
 * Reject a request that does not match its schema.
 *
 * Rejects only — Joi's coerced `value` is deliberately discarded, so a
 * schema cannot strip or transform anything. A handler always sees exactly
 * what the client sent.
 *
 * THE `?? {}` IS THE WHOLE POINT, AND IT IS NOT DEFENSIVE PADDING:
 * Express 5 leaves `req.body` as `undefined` for a request with no body, or
 * one whose Content-Type no parser claimed. Validating `undefined` against
 * `Joi.object().keys({ email: Joi.string().required() })` *passes* — Joi
 * only enforces keys when the object itself is present, and an object schema
 * is optional unless marked `.required()`. The previous implementation
 * passed `undefined` straight through, so on a bodyless request every
 * `required()` field in this codebase was unenforced and the handler then
 * died on `req.body.email` with a 500 carrying a raw TypeError. Substituting
 * `{}` makes the missing keys missing, which is what the 400 is for.
 */
const validate = (schema: ValidationSchema) => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const messages: string[] = [];

    for (const segment of SEGMENTS) {
      const segmentSchema = schema[segment];
      if (!segmentSchema) continue;

      const { error } = segmentSchema.validate(req[segment] ?? {}, {
        errors: { label: "key" },
        abortEarly: false,
      });

      // Collected across all three segments rather than thrown at the first,
      // so a caller who got both the query and the body wrong is told once.
      if (error) messages.push(...error.details.map((detail) => detail.message));
    }

    if (messages.length > 0) {
      next(new ApiError(httpStatus.BAD_REQUEST, messages.join(", ")));
      return;
    }

    next();
  };
};

export default validate;
