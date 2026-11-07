import httpStatus from "http-status";
import { buildCorsOptions } from "../../src/config/cors";
import ApiError from "../../src/utils/api-error";

/**
 * The cross-origin policy. `credentials: true` is what makes this security
 * rather than configuration: whatever origin is allowed here may send the
 * visitor's auth cookies AND read the response.
 */
type OriginFn = (
  origin: string | undefined,
  cb: (err: Error | null, allow?: boolean) => void,
) => void;

/** Run the origin callback and return what it answered. */
const check = (
  allowedOrigins: string[],
  origin: string | undefined,
): { error: unknown; allowed: boolean | undefined } => {
  const { origin: policy } = buildCorsOptions(allowedOrigins);
  let error: unknown;
  let allowed: boolean | undefined;

  (policy as OriginFn)(origin, (err, allow) => {
    error = err;
    allowed = allow;
  });

  return { error, allowed };
};

describe("buildCorsOptions", () => {
  describe("with an allow-list", () => {
    const ALLOWED = ["https://admin.example.com"];

    it("allows a listed origin", () => {
      expect(check(ALLOWED, "https://admin.example.com")).toEqual({
        error: null,
        allowed: true,
      });
    });

    it("refuses an unlisted origin with a 403, not a 500", () => {
      // THE REGRESSION. A bare `Error` carries no statusCode, so
      // `errorConverter` classified a policy decision as a non-operational
      // 500 — masked to "Internal Server Error" in production, counted
      // against the 5xx budget, and indistinguishable from a crash.
      const { error } = check(ALLOWED, "https://evil.example.com");

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).statusCode).toBe(httpStatus.FORBIDDEN);
      expect((error as ApiError).isOperational).toBe(true);
    });

    it("does not echo the rejected origin back in the message", () => {
      const { error } = check(ALLOWED, "https://evil.example.com");
      expect((error as ApiError).message).not.toContain("evil.example.com");
    });

    it("allows a request with no Origin header", () => {
      // curl, a server-to-server call, a same-origin navigation. There is
      // no cross-site request for CORS to protect against.
      expect(check(ALLOWED, undefined).allowed).toBe(true);
    });

    it("matches the origin exactly", () => {
      // Not a prefix or suffix test: `admin.example.com.evil.com` and a
      // scheme or port change are all different origins.
      for (const origin of [
        "https://admin.example.com.evil.com",
        "http://admin.example.com",
        "https://admin.example.com:8443",
        "https://evil.com/?x=https://admin.example.com",
      ]) {
        expect(check(ALLOWED, origin).error).toBeInstanceOf(ApiError);
      }
    });
  });

  describe("with an empty allow-list", () => {
    it("reflects any origin", () => {
      // The permissive development default. config.ts refuses to boot with
      // this in production — see the spec in r2-client/config coverage —
      // because together with `credentials: true` it is a blanket grant.
      expect(buildCorsOptions([]).origin).toBe(true);
    });
  });

  it("always sends credentials, which is why the list matters", () => {
    expect(buildCorsOptions([]).credentials).toBe(true);
    expect(buildCorsOptions(["https://a.example.com"]).credentials).toBe(true);
  });
});
