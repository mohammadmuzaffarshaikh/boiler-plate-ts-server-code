import express, { Express, Request, Response, NextFunction } from "express";
import request from "supertest";
import fileRoute from "../../src/routes/app/file.routes";

/**
 * Where `cleanupUpload` sits in the upload chain, and why it has to be
 * there.
 *
 * It registers a `res.once("close")` hook that deletes the spooled temp
 * file. It used to be mounted *after* multer and after `handleMulterError`,
 * which reads sensibly and does not work: once anything calls `next(err)`,
 * Express skips every remaining non-error middleware — all of them, not
 * merely the ones before the error handler. So in the one case the hook
 * exists for, multer rejecting an oversized file, it was never registered.
 *
 * Nothing leaked, but only because multer 2.x happens to unlink the file
 * itself on abort. The app's own safety net was not in the path its own
 * comment claimed.
 */
describe("the upload middleware chain", () => {
  interface Layer {
    route?: { path: string; stack: { name: string }[] };
  }

  /** Handler names on `POST /`, in order. */
  const chain = (): string[] => {
    const layers = (fileRoute as unknown as { stack: Layer[] }).stack;
    const post = layers.find(
      (layer) => layer.route?.path === "/" && layer.route.stack.length > 3,
    );

    if (!post?.route) throw new Error("POST / not found on the file router");
    return post.route.stack.map((handler) => handler.name || "<anonymous>");
  };

  const indexOf = (name: string): number => {
    const at = chain().indexOf(name);
    expect(at).toBeGreaterThanOrEqual(0);
    return at;
  };

  it("registers cleanupUpload before multer", () => {
    // THE REGRESSION. `cleanupUpload` reads `req.file?.path` lazily inside
    // its close hook, so running first costs nothing — and it is the only
    // position from which the hook survives a multer rejection.
    expect(indexOf("cleanupUpload")).toBeLessThan(indexOf("multerMiddleware"));
  });

  it("registers handleMulterError immediately after multer", () => {
    // A four-argument error handler: skipped on the happy path, and the
    // only thing that turns LIMIT_FILE_SIZE into a 413 rather than a
    // masked 500.
    expect(indexOf("handleMulterError")).toBe(indexOf("multerMiddleware") + 1);
  });

  it("still runs multer before validate and the controller", () => {
    // `validate` reads `req.body`, which does not exist on a multipart
    // request until multer has parsed it.
    const names = chain();
    expect(names.indexOf("multerMiddleware")).toBeLessThan(names.length - 2);
  });

  describe("the Express behaviour that forces the order", () => {
    /**
     * Demonstrated directly, because the reasoning is the part that is easy
     * to get wrong in review — and the fix looks backwards without it.
     */
    const ran: string[] = [];

    const appWith = (before: boolean): Express => {
      const app = express();
      const record =
        (label: string) =>
        (_req: Request, _res: Response, next: NextFunction) => {
          ran.push(label);
          next();
        };

      app.get(
        "/boom",
        ...(before ? [record("before")] : []),
        (_req: Request, _res: Response, next: NextFunction) =>
          next(new Error("multer rejected it")),
        ...(before ? [] : [record("after")]),
        (
          err: Error,
          _req: Request,
          res: Response,
          _next: NextFunction,
        ) => {
          res.status(413).send({ message: err.message });
        },
      );

      return app;
    };

    beforeEach(() => {
      ran.length = 0;
    });

    it("skips a plain middleware registered after the failing one", async () => {
      await request(appWith(false)).get("/boom").expect(413);
      expect(ran).toEqual([]);
    });

    it("runs one registered before it", async () => {
      await request(appWith(true)).get("/boom").expect(413);
      expect(ran).toEqual(["before"]);
    });
  });
});
