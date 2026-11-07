import express, { Express } from "express";
import request from "supertest";
import httpStatus from "http-status";
import cookieParser from "cookie-parser";
import { requireTrustedOrigin } from "../../src/middlewares/csrf.middleware";
import {
  errorConverter,
  errorHandler,
} from "../../src/middlewares/error.middleware";
import config from "../../src/config/config";
import logger from "../../src/config/logger";

/**
 * THE HOLE THIS CLOSES.
 *
 * In production the auth cookies are `SameSite=None` and CORS runs with
 * `credentials: true`, because the admin frontend is on a different origin.
 * CORS does not stop a cross-site request — it only hides the response from
 * a script that was not granted the origin. For a request the browser treats
 * as "simple" that distinction is the vulnerability: a `multipart/form-data`
 * POST is sent with no preflight, the server executes it, and the attacker
 * never needed to read the reply.
 *
 * So any page a signed-in staff member visited could make their browser run
 * `POST /api/app/files` or `POST /api/app/auth/logout` with their cookies
 * attached. PATCH and DELETE are preflighted and were always safe. POST was
 * not, and nothing in `src/`, `docs/` or `README.md` mentioned CSRF at all.
 */
const buildApp = (): Express => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(requireTrustedOrigin);
  app.all("/api/app/files", (_req, res) => {
    res.status(httpStatus.OK).send({ status: "success" });
  });
  app.use(errorConverter, errorHandler);
  return app;
};

const TRUSTED = "https://admin.example.com";
const ATTACKER = "https://evil.example.com";

describe("the trusted-origin check", () => {
  let previousEnv: string;
  let previousOrigins: string[];

  beforeEach(() => {
    previousEnv = config.ENV;
    previousOrigins = config.CORS.ALLOWED_ORIGINS;
    config.ENV = "production";
    config.CORS.ALLOWED_ORIGINS = [TRUSTED];
    jest.spyOn(logger, "warn").mockImplementation(() => logger);
  });

  afterEach(() => {
    config.ENV = previousEnv;
    config.CORS.ALLOWED_ORIGINS = previousOrigins;
  });

  describe("a cookie-bearing request from another site", () => {
    it("refuses a simple POST, which CORS never would have", async () => {
      // THE REGRESSION. `multipart/form-data` needs no preflight, so the
      // browser sends it and the server used to run it.
      await request(buildApp())
        .post("/api/app/files")
        .set("Origin", ATTACKER)
        .set("Cookie", "token=a-real-session")
        .field("folder", "avatars")
        .expect(httpStatus.FORBIDDEN);
    });

    it("refuses a JSON POST too", async () => {
      await request(buildApp())
        .post("/api/app/files")
        .set("Origin", ATTACKER)
        .set("Cookie", "token=a-real-session")
        .send({ any: "thing" })
        .expect(httpStatus.FORBIDDEN);
    });

    it("refuses when the refresh cookie is the one attached", async () => {
      // `POST /auth/logout` and `/auth/refresh` read that cookie, so it is
      // just as much a browser-attached credential as the access cookie.
      await request(buildApp())
        .post("/api/app/files")
        .set("Origin", ATTACKER)
        .set("Cookie", "refreshToken=a-real-refresh")
        .expect(httpStatus.FORBIDDEN);
    });

    it("refuses PUT, PATCH and DELETE as well", async () => {
      for (const method of ["put", "patch", "delete"] as const) {
        const agent = request(buildApp());
        await agent[method]("/api/app/files")
          .set("Origin", ATTACKER)
          .set("Cookie", "token=a-real-session")
          .expect(httpStatus.FORBIDDEN);
      }
    });

    it("does not name the allowlist in the response", async () => {
      // Client-facing messages stay vague; the detail goes to the log.
      const res = await request(buildApp())
        .post("/api/app/files")
        .set("Origin", ATTACKER)
        .set("Cookie", "token=a-real-session");

      expect(JSON.stringify(res.body)).not.toContain(TRUSTED);
    });

    it("logs the refusal, with the origin that was refused", async () => {
      const warn = jest.spyOn(logger, "warn").mockImplementation(() => logger);

      await request(buildApp())
        .post("/api/app/files")
        .set("Origin", ATTACKER)
        .set("Cookie", "token=a-real-session");

      expect(warn).toHaveBeenCalledWith(expect.stringContaining(ATTACKER));
    });
  });

  describe("what must keep working", () => {
    it("allows the real frontend", async () => {
      await request(buildApp())
        .post("/api/app/files")
        .set("Origin", TRUSTED)
        .set("Cookie", "token=a-real-session")
        .expect(httpStatus.OK);
    });

    it("allows a native client, which sends a bearer token and no Origin", async () => {
      // CSRF is only about credentials the browser attaches by itself. A
      // bearer token has to be handed over by someone, and no third-party
      // page can make a browser produce one. Requiring an Origin from these
      // callers would break every native client for no gain.
      await request(buildApp())
        .post("/api/app/files")
        .set("Authorization", "Bearer some-access-token")
        .expect(httpStatus.OK);
    });

    it("allows a cookieless request with no Origin at all", async () => {
      await request(buildApp()).post("/api/app/files").expect(httpStatus.OK);
    });

    it("leaves GET alone, cookies and hostile origin included", async () => {
      // Safe methods are not this middleware's business, and blocking them
      // would break every ordinary cross-origin read the CORS policy allows.
      await request(buildApp())
        .get("/api/app/files")
        .set("Origin", ATTACKER)
        .set("Cookie", "token=a-real-session")
        .expect(httpStatus.OK);
    });

    it("does nothing outside production", async () => {
      // Outside production the cookies are SameSite=Lax, which already
      // withholds them from a cross-site POST, and a frontend on an
      // arbitrary port is the normal case.
      config.ENV = "development";

      await request(buildApp())
        .post("/api/app/files")
        .set("Origin", ATTACKER)
        .set("Cookie", "token=a-real-session")
        .expect(httpStatus.OK);
    });
  });

  describe("a cookie-bearing request with no Origin header", () => {
    it("is refused in production", async () => {
      // Browsers have sent Origin on every state-changing request for years,
      // and a page cannot suppress it. A cookie arriving without one is not
      // a browser doing something ordinary.
      await request(buildApp())
        .post("/api/app/files")
        .set("Cookie", "token=a-real-session")
        .expect(httpStatus.FORBIDDEN);
    });
  });
});
