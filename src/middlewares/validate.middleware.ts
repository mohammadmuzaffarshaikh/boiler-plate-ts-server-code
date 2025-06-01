import Joi from "joi";
import httpStatus from "http-status";
import { Request, Response, NextFunction } from "express";
import pick from "../utils/pick";
import ApiError from "../utils/api-error";

// Define the type for validation schema
interface ValidationSchema {
  params?: Joi.ObjectSchema;
  query?: Joi.ObjectSchema;
  body?: Joi.ObjectSchema;
}

// Define the type for the middleware
const validate = (schema: ValidationSchema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      // Pick only the schema fields we want to validate
      const validSchema = pick(schema, ["params", "query", "body"]);

      // Pick matching fields from request
      const requestData = pick(req, Object.keys(validSchema));

      // Validate each part of the request separately
      Object.keys(validSchema).forEach((key) => {
        if (validSchema[key]) {
          const { error } = validSchema[key].validate(requestData[key], {
            errors: { label: "key" },
            abortEarly: false,
          });

          if (error) {
            throw new ApiError(
              400,
              error.details.map((details: any) => details.message).join(", ")
            );
          }
        }
      });

      // If validation passes, continue
      next();
    } catch (error) {
      next(error);
    }
  };
};

export default validate;
