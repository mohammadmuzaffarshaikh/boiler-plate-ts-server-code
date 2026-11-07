import { Request, Response, NextFunction } from "express";
import catchAsync from "../../src/utils/catch-async";
import ApiError from "../../src/utils/api-error";

/**
 * Every controller is wrapped in this. Express 5 does forward a rejected
 * promise on its own, but the house convention is explicit — and what this
 * pins is that a thrown `ApiError` reaches `next` unchanged, because
 * `errorConverter` keys on the instance to decide whether to mask it.
 */
describe("catchAsync", () => {
  const req = {} as Request;
  const res = {} as Response;

  it("does not call next when the handler resolves", async () => {
    const next = jest.fn() as NextFunction;
    await catchAsync(async () => undefined)(req, res, next);
    expect(next).not.toHaveBeenCalled();
  });

  it("forwards a rejection to next", async () => {
    const next = jest.fn() as NextFunction;
    const boom = new Error("boom");

    await catchAsync(async () => {
      throw boom;
    })(req, res, next);

    expect(next).toHaveBeenCalledWith(boom);
  });

  it("does NOT catch a synchronous throw — it propagates to Express", () => {
    // Worth pinning because it is surprising. `Promise.resolve(fn(req,…))`
    // evaluates `fn` first, so a handler that throws before returning a
    // promise throws straight out of the wrapper; `.catch` never attaches.
    //
    // Not a live defect: every controller here is `async`, and an `async`
    // function converts a throw into a rejection, which the test above
    // covers. Express 5 also catches a synchronous throw from a handler and
    // routes it to the error middleware. The combination is why this has
    // never surfaced — but if a controller ever stops being `async`, this
    // spec says where the handling actually comes from.
    const next = jest.fn() as NextFunction;

    expect(() =>
      catchAsync((() => {
        throw new Error("sync boom");
      }) as never)(req, res, next),
    ).toThrow("sync boom");

    expect(next).not.toHaveBeenCalled();
  });

  it("preserves the ApiError instance rather than wrapping it", async () => {
    // `errorConverter` checks `instanceof ApiError` to decide whether to
    // trust the status code. Re-wrapping here would turn every deliberate
    // 404 into a masked 500.
    const next = jest.fn() as NextFunction;
    const apiError = new ApiError(404, "Not found");

    await catchAsync(async () => {
      throw apiError;
    })(req, res, next);

    expect(next).toHaveBeenCalledWith(apiError);
    expect((next as jest.Mock).mock.calls[0][0]).toBeInstanceOf(ApiError);
  });

  it("passes req, res and next through to the handler", async () => {
    const handler = jest.fn(async () => undefined);
    const next = jest.fn() as NextFunction;

    await catchAsync(handler)(req, res, next);

    expect(handler).toHaveBeenCalledWith(req, res, next);
  });
});
