import { redactUrl, redactUrlPassword } from "../../src/utils/redact";

/**
 * Connection strings get logged at startup and on failure, and logs travel
 * further than the people writing them expect — aggregators, tickets,
 * screenshots, pasted terminal output.
 */
describe("redactUrlPassword", () => {
  it("removes the password from a Postgres URL", () => {
    const out = redactUrlPassword(
      "postgres://admin:s3cr3t@db.example.com:5432/shop",
    );

    expect(out).not.toContain("s3cr3t");
    expect(out).toContain("admin");
    expect(out).toContain("db.example.com");
    expect(out).toContain("/shop");
  });

  it("removes the password from a rediss URL", () => {
    expect(redactUrlPassword("rediss://default:p4ss@cache.example.com:6379")).
      not.toContain("p4ss");
  });

  it("leaves a URL with no password alone", () => {
    const url = "postgres://localhost:5432/test";
    expect(redactUrlPassword(url)).toContain("localhost:5432");
    expect(redactUrlPassword(url)).not.toContain("***");
  });

  it("does not leak the string when it will not parse", () => {
    // The fallback is the dangerous path: a malformed URL is exactly the
    // case someone is debugging, and echoing it would put the credential in
    // the log by the very code meant to keep it out.
    const out = redactUrlPassword("postgres//admin:s3cr3t@oops", "DATABASE_URL");

    expect(out).not.toContain("s3cr3t");
    expect(out).toContain("DATABASE_URL");
  });

  it("names the setting in the fallback so the log is still useful", () => {
    expect(redactUrlPassword("nonsense", "REDIS_URL")).toBe(
      "<un-parseable REDIS_URL>",
    );
  });

  it("handles a password containing URL-significant characters", () => {
    const out = redactUrlPassword("postgres://u:p%40ss%3Aword@host:5432/db");
    expect(out).not.toContain("p%40ss");
    expect(out).toContain("***");
  });
});

/**
 * A credential in a query string is written down in more places than anyone
 * reviewing the handler is thinking about: morgan's `:url`, the error
 * handler's `originalUrl`, stdout, the log aggregator, and the access log of
 * every proxy and CDN in front of the API.
 *
 * The reset token that used to travel that way has moved into the request
 * body. This is the backstop that stops the next one repeating it — not the
 * control, because it only covers the logs this process writes.
 */
describe("redactUrl", () => {
  it("masks a token", () => {
    const out = redactUrl("/api/app/auth/reset-password?token=eyJhbGciOi.J9.x");

    expect(out).not.toContain("eyJhbGciOi");
    expect(out).toBe("/api/app/auth/reset-password?token=***");
  });

  it.each([
    "access_token",
    "refresh_token",
    "id_token",
    "code",
    "secret",
    "password",
    "api_key",
    "signature",
  ])("masks %s", (param) => {
    expect(redactUrl(`/callback?${param}=s3cr3t`)).toBe(`/callback?${param}=***`);
  });

  it("ignores case in the parameter name", () => {
    expect(redactUrl("/x?Token=s3cr3t")).toBe("/x?Token=***");
  });

  it("leaves everything else legible", () => {
    // A redacted log that cannot be debugged from is its own kind of
    // failure, so the path, the other parameters and the parameter names
    // all survive.
    const out = redactUrl("/api/app/files?folder=product_images&limit=20");
    expect(out).toBe("/api/app/files?folder=product_images&limit=20");
  });

  it("keeps the non-secret parameters alongside a masked one", () => {
    const out = redactUrl("/api/app/files?folder=product_images&token=abc");

    expect(out).toContain("folder=product_images");
    expect(out).toContain("token=***");
    expect(out).not.toContain("abc");
  });

  it("does not mask a parameter that merely contains a secret word", () => {
    // Whole-name matching, not substring. A substring rule starts hiding
    // `next_page_token` and ends with logs nobody can read.
    expect(redactUrl("/x?next_page_token=abc")).toBe("/x?next_page_token=abc");
    expect(redactUrl("/x?tokenType=bearer")).toBe("/x?tokenType=bearer");
  });

  it("returns a URL with no query string untouched", () => {
    expect(redactUrl("/api/health")).toBe("/api/health");
  });

  it("does not rewrite escaping when there was nothing to hide", () => {
    // Re-serialising would turn `%20` into `+` and make the logged line
    // differ from the request the client actually sent.
    const url = "/search?q=red%20shoes";
    expect(redactUrl(url)).toBe(url);
  });

  it("masks every copy of a repeated secret parameter", () => {
    expect(redactUrl("/x?token=a&token=b")).toBe("/x?token=***");
  });

  it("masks an absolute URL as readily as a path", () => {
    expect(redactUrl("https://api.example.com/reset?token=abc")).toBe(
      "https://api.example.com/reset?token=***",
    );
  });
});
