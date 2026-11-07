/**
 * Boot-time configuration rules.
 *
 * `dotenv` is stubbed out for this file. config.ts loads `.env` from a
 * hardcoded path and dotenv fills in any variable that is absent, so without
 * the stub a test that deletes a variable to prove its default would simply
 * have it put back from the developer's own `.env` — and the spec would pass
 * while proving nothing.
 */
jest.mock("dotenv", () => ({
  __esModule: true,
  default: { config: jest.fn() },
}));

type Config = (typeof import("../../src/config/config"))["default"];

/** Load config.ts fresh under a modified environment. */
const loadConfig = async (
  overrides: Record<string, string | undefined> = {},
): Promise<Config> => {
  const previous: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    let loaded: Config | undefined;
    await jest.isolateModulesAsync(async () => {
      loaded = (await import("../../src/config/config")).default;
    });
    return loaded!;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

beforeAll(() => {
  // Normally supplied by `.env`, which is stubbed out above.
  process.env.DATABASE_URL ??= "postgres://postgres:x@localhost:5432/test";
});

describe("JWT expiry settings", () => {
  // Each carried `.default(X)` AND `.required()`. Joi lets both coexist and
  // `.required()` wins, so every default was dead code and a deployment
  // following the README — which documents them as optional with defaults —
  // crashed at import with `"JWT_ACCESS_EXPIRATION_MINUTES" is required`.
  it("boots with only JWT_SECRET set", async () => {
    const config = await loadConfig({
      JWT_ACCESS_EXPIRATION_MINUTES: undefined,
      JWT_REFRESH_EXPIRATION_MINUTES: undefined,
      JWT_RESET_PASSWORD_EXPIRATION_MINUTES: undefined,
      JWT_INVITE_USER_EXPIRATION_MINUTES: undefined,
    });

    expect(config.JWT.SECRET).toBeTruthy();
  });

  it("applies the documented defaults", async () => {
    const config = await loadConfig({
      JWT_ACCESS_EXPIRATION_MINUTES: undefined,
      JWT_REFRESH_EXPIRATION_MINUTES: undefined,
      JWT_RESET_PASSWORD_EXPIRATION_MINUTES: undefined,
    });

    expect(config.JWT.ACCESS_EXPIRATION_MINUTES).toBe(30);
    // 7 days, matching README.md and .env.example. It used to be 1770
    // minutes — 29.5 hours — which was documented nowhere.
    expect(config.JWT.REFRESH_EXPIRATION_MINUTES).toBe(60 * 24 * 7);
    expect(config.JWT.RESET_PASSWORD_EXPIRATION_MINUTES).toBe(10);
  });

  it("still refuses to boot without JWT_SECRET", async () => {
    // The one that genuinely is required, because it has no default and
    // must never acquire one.
    await expect(loadConfig({ JWT_SECRET: undefined })).rejects.toThrow(
      /JWT_SECRET/,
    );
  });

  it("honours an explicit value over the default", async () => {
    const config = await loadConfig({ JWT_ACCESS_EXPIRATION_MINUTES: "5" });
    expect(config.JWT.ACCESS_EXPIRATION_MINUTES).toBe(5);
  });
});

describe("JWT_SECRET", () => {
  /**
   * HS256 signs every access token with this string. Recover it offline from
   * one captured token and you can mint a token for any `sub` with any
   * `role` — the session lookup in `jwtVerify` trusts a valid signature, so
   * nothing downstream catches it.
   *
   * It was `Joi.string().required()`: a one-character secret booted
   * production without comment, while BCRYPT_ROUNDS right beside it enforced
   * a floor of 10.
   */
  it("refuses a secret short enough to brute-force", async () => {
    // THE REGRESSION.
    await expect(loadConfig({ JWT_SECRET: "x" })).rejects.toThrow(/JWT_SECRET/);
  });

  it("refuses one character below the floor", async () => {
    await expect(loadConfig({ JWT_SECRET: "a".repeat(19) })).rejects.toThrow(
      /JWT_SECRET/,
    );
  });

  it("accepts the floor itself", async () => {
    const config = await loadConfig({ JWT_SECRET: "a".repeat(20) });
    expect(config.JWT.SECRET).toHaveLength(20);
  });

  it("still refuses an absent secret", async () => {
    // The floor must not have replaced `.required()` with a default.
    await expect(loadConfig({ JWT_SECRET: undefined })).rejects.toThrow(
      /JWT_SECRET/,
    );
  });

  it("refuses a short secret in development too", async () => {
    // A secret that is weak is weak everywhere, and a developer who gets
    // used to "abc" is the one who copies it into a deploy.
    await expect(
      loadConfig({ NODE_ENV: "development", JWT_SECRET: "abc" }),
    ).rejects.toThrow(/JWT_SECRET/);
  });
});

describe("SITE_URL", () => {
  /**
   * The origin every outbound link is built against. Unset, the reset link
   * reads `undefined/reset-password?token=<live token>` — a working
   * single-use credential pointing nowhere, sent to someone who by
   * definition has no other way into their account.
   */
  it("refuses to boot in production when it is unset", async () => {
    // THE REGRESSION.
    await expect(
      loadConfig({
        NODE_ENV: "production",
        ALLOWED_ORIGINS: "https://admin.example.com",
        SITE_URL: undefined,
      }),
    ).rejects.toThrow(/SITE_URL/);
  });

  it("names the consequence, not just the variable", async () => {
    let caught: unknown;
    try {
      await loadConfig({
        NODE_ENV: "production",
        ALLOWED_ORIGINS: "https://admin.example.com",
        SITE_URL: undefined,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/undefined\/|reset/i);
  });

  it("boots in production once it is set", async () => {
    const config = await loadConfig({
      NODE_ENV: "production",
      ALLOWED_ORIGINS: "https://admin.example.com",
      SITE_URL: "https://admin.example.com",
    });

    expect(config.SITE_URL).toBe("https://admin.example.com");
  });

  it("stays optional outside production", async () => {
    // Development returns the reset link in the response body rather than
    // mailing it, so there is nothing to build an absolute URL for.
    const config = await loadConfig({
      NODE_ENV: "development",
      SITE_URL: undefined,
    });

    expect(config.SITE_URL).toBeUndefined();
  });

  it("rejects a value that is present but not a URL", async () => {
    // Catching this at boot beats catching it in somebody's inbox.
    await expect(loadConfig({ SITE_URL: "not a url" })).rejects.toThrow(
      /SITE_URL/,
    );
  });
});

describe("ALLOWED_ORIGINS", () => {
  it("refuses to boot in production when it is unset", async () => {
    // THE REGRESSION. Blank means `origin: true` in app.ts — reflect any
    // origin — and with `credentials: true` that lets any website make
    // credentialed calls as the visitor and read the replies. It was the
    // Joi default, so forgetting one variable silently did that, and
    // nothing logged it.
    await expect(
      loadConfig({ NODE_ENV: "production", ALLOWED_ORIGINS: undefined }),
    ).rejects.toThrow(/ALLOWED_ORIGINS/);
  });

  it("names the consequence, not just the variable", async () => {
    let caught: unknown;
    try {
      await loadConfig({ NODE_ENV: "production", ALLOWED_ORIGINS: undefined });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/credentialed|any origin/i);
  });

  it("boots in production once it is set", async () => {
    const config = await loadConfig({
      NODE_ENV: "production",
      ALLOWED_ORIGINS: "https://admin.example.com",
    });

    expect(config.CORS.ALLOWED_ORIGINS).toEqual(["https://admin.example.com"]);
  });

  it("still allows an unset list outside production", async () => {
    // The permissive default stays in development, where a frontend on an
    // arbitrary port is the normal case. app.ts warns about it at startup.
    const config = await loadConfig({
      NODE_ENV: "development",
      ALLOWED_ORIGINS: undefined,
    });

    expect(config.CORS.ALLOWED_ORIGINS).toEqual([]);
  });
});

describe("AUTH_REQUIRE_EMAIL_VERIFICATION", () => {
  it("is off unless asked for", async () => {
    // Deliberately: nothing sends a verification email yet, so switching it
    // on would lock out every account with no way back in.
    const config = await loadConfig({
      AUTH_REQUIRE_EMAIL_VERIFICATION: undefined,
    });

    expect(config.AUTH.REQUIRE_EMAIL_VERIFICATION).toBe(false);
  });

  it("can be switched on", async () => {
    const config = await loadConfig({
      AUTH_REQUIRE_EMAIL_VERIFICATION: "true",
    });

    expect(config.AUTH.REQUIRE_EMAIL_VERIFICATION).toBe(true);
  });
});
