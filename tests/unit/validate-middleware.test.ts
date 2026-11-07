import Joi from "joi";
import httpStatus from "http-status";
import { Request, Response, NextFunction } from "express";
import validate from "../../src/middlewares/validate.middleware";
import ApiError from "../../src/utils/api-error";

/**
 * The gate every route in this codebase stands behind.
 *
 * The case that matters most is the one that reads like a non-case: a
 * request with NO BODY. Express 5 leaves `req.body` as `undefined` for a
 * request that sent none, or whose Content-Type no parser claimed — and
 * `Joi.object().keys({ email: required() }).validate(undefined)` reports no
 * error, because an object schema is optional unless marked `.required()`
 * and there is no object for the keys to be missing from.
 *
 * So the middleware used to wave those requests through, every `required()`
 * in the project went unenforced, and the handler died on `req.body.email`
 * — a 500 with a raw TypeError in the response body where a 400 belonged.
 */

/** Run the middleware and return whatever it passed to `next`. */
const run = (
  schema: Parameters<typeof validate>[0],
  req: Partial<Request>,
): unknown => {
  let passed: unknown;
  const next: NextFunction = (err?: unknown) => {
    passed = err;
  };

  validate(schema)(req as Request, {} as Response, next);
  return passed;
};

/** The ApiError the middleware rejected with, failing the test if it did not. */
const rejection = (
  schema: Parameters<typeof validate>[0],
  req: Partial<Request>,
): ApiError => {
  const passed = run(schema, req);
  expect(passed).toBeInstanceOf(ApiError);
  return passed as ApiError;
};

const bodySchema = {
  body: Joi.object().keys({
    email: Joi.string().email().required(),
    password: Joi.string().required(),
  }),
};

describe("validate", () => {
  describe("a request with no body at all", () => {
    it("is rejected, not waved through", () => {
      // THE REGRESSION. `req.body` undefined is the shape Express 5 hands
      // over for a bodyless POST.
      const error = rejection(bodySchema, { body: undefined });

      expect(error.statusCode).toBe(httpStatus.BAD_REQUEST);
      expect(error.message).toMatch(/email/);
      expect(error.message).toMatch(/password/);
    });

    it("is rejected the same way as an empty object", () => {
      // `{}` always failed correctly; `undefined` did not. They are the same
      // request as far as a required field is concerned, and must answer
      // alike — otherwise the behaviour depends on which Content-Type the
      // caller happened to send.
      const missing = rejection(bodySchema, { body: undefined });
      const empty = rejection(bodySchema, { body: {} });

      expect(missing.message).toBe(empty.message);
      expect(missing.statusCode).toBe(empty.statusCode);
    });

    it("is accepted when every key is optional", () => {
      // The other half: `logout` and `refresh` take an optional
      // refreshToken because it normally arrives in a cookie. Substituting
      // `{}` must not turn those into 400s.
      const schema = {
        body: Joi.object().keys({
          refreshToken: Joi.string().optional().allow(""),
        }),
      };

      expect(run(schema, { body: undefined })).toBeUndefined();
    });
  });

  describe("a well-formed request", () => {
    it("passes nothing to next", () => {
      const passed = run(bodySchema, {
        body: { email: "ada@example.com", password: "hunter2" },
      });

      expect(passed).toBeUndefined();
    });

    it("leaves the request untouched", () => {
      // `validate` rejects; it never transforms. Joi's coerced `value` is
      // discarded on purpose, so a handler always sees what the client sent
      // and a schema can never silently strip a field.
      const body = { email: "ada@example.com", password: "hunter2" };
      const req = { body } as Partial<Request>;

      run(bodySchema, req);

      expect(req.body).toBe(body);
      expect(req.body).toEqual({
        email: "ada@example.com",
        password: "hunter2",
      });
    });
  });

  describe("what it refuses", () => {
    it("refuses an unknown key rather than ignoring it", () => {
      const error = rejection(bodySchema, {
        body: { email: "ada@example.com", password: "x", role: "ADMIN" },
      });

      expect(error.message).toMatch(/role/);
    });

    it("reports every problem at once, not just the first", () => {
      // `abortEarly: false`. One round-trip per attempt beats a client
      // discovering its mistakes one at a time.
      const error = rejection(bodySchema, { body: { email: "not-an-email" } });

      expect(error.message).toMatch(/email/);
      expect(error.message).toMatch(/password/);
    });

    it("reports problems from several segments together", () => {
      const error = rejection(
        {
          query: Joi.object().keys({ token: Joi.string().required() }),
          body: Joi.object().keys({ password: Joi.string().required() }),
        },
        { query: {}, body: undefined },
      );

      expect(error.message).toMatch(/token/);
      expect(error.message).toMatch(/password/);
    });
  });

  describe("segments it was not given", () => {
    it("ignores a segment with no schema", () => {
      // Only the segments a schema names are inspected. A route that
      // validates params must not start rejecting query strings.
      const schema = {
        params: Joi.object().keys({ id: Joi.string().required() }),
      };

      expect(
        run(schema, { params: { id: "abc" }, query: { anything: "goes" } }),
      ).toBeUndefined();
    });

    it("validates params and query as well as body", () => {
      const error = rejection(
        { params: Joi.object().keys({ id: Joi.string().uuid().required() }) },
        { params: { id: "not-a-uuid" } },
      );

      expect(error.statusCode).toBe(httpStatus.BAD_REQUEST);
      expect(error.message).toMatch(/id/);
    });
  });
});
