import dotenv from "dotenv";
import os from "node:os";
import path from "path";
import Joi from "joi";

dotenv.config({ path: path.join(__dirname, "../../.env") });

interface DatabaseConfig {
  URL: string;
  /** Maximum pooled connections held by this process. */
  POOL_MAX: number;
  /**
   * How long to wait for a connection from the pool before failing.
   *
   * node-pg defaults this to "wait forever". Against a database that is
   * unreachable but not actively refusing — a dropped firewall rule, a dead
   * host, a failover in progress — that default makes every request hang
   * indefinitely instead of returning an error, and the process quietly
   * accumulates them until it dies.
   */
  CONNECT_TIMEOUT_MS: number;
  IDLE_TIMEOUT_MS: number;
  /** Server-side cap on a single statement. 0 disables it. */
  STATEMENT_TIMEOUT_MS: number;
  /** Boot-time connection attempts before the process gives up and exits. */
  CONNECT_RETRIES: number;
  CONNECT_RETRY_DELAY_MS: number;
}

interface JwtConfig {
  SECRET: string;
  ACCESS_EXPIRATION_MINUTES: number;
  REFRESH_EXPIRATION_MINUTES: number;
  RESET_PASSWORD_EXPIRATION_MINUTES: number;
  USER_INVITE_EXPIRATION_MINUTES: number;
}

interface CronConfig {
  TOKEN_CLEANUP: string;
  SESSION_CLEANUP: string;
  FILE_CLEANUP: string;
}

interface AuthConfig {
  MAX_LOGIN_ATTEMPTS: number;
  LOCK_TIME_MINUTES: number;
  /**
   * bcrypt work factor for password hashing.
   *
   * Each step doubles the work. 8 — the value this started at — is roughly
   * 2016-era and 16x cheaper to attack than 12; OWASP's current floor is 10,
   * which the Joi schema enforces as a minimum so the setting cannot be
   * turned down below it from the environment.
   *
   * Existing hashes carry their own cost inside the string, so raising this
   * does not invalidate them and does not, on its own, improve them either —
   * `auth.service` rehashes on the next successful login instead.
   */
  BCRYPT_ROUNDS: number;
  /**
   * Lifetime of a native login authorization code, in SECONDS.
   *
   * It exists only to survive the round trip from the login response to the
   * next request, so it is measured in seconds rather than minutes and the
   * Joi schema caps it at 300. A long-lived single-use code is a bearer
   * credential with extra steps — the whole point is that the window in
   * which an intercepted code is worth anything is too short to act on.
   */
  CODE_EXPIRATION_SECONDS: number;
  /**
   * Whether an unverified mailbox blocks login.
   *
   * Off by default, and deliberately so: nothing sends a verification email
   * yet, so switching this on with no way to complete the round-trip would
   * lock out every account that exists. The transport is now real
   * (`services/email.service`) but no caller issues a VERIFY_EMAIL token or
   * sends the mail — that is todo/sugestion-1.md step 3. The gate itself is
   * wired and tested, see `assertEmailVerificationPolicy` in
   * services/auth.service, so turning it on is this one flag once the flow
   * lands. ADMIN is exempt either way (config/constants).
   */
  REQUIRE_EMAIL_VERIFICATION: boolean;
}

interface CookieConfig {
  DOMAIN?: string;
}

interface CorsConfig {
  ALLOWED_ORIGINS: string[];
}

interface GoogleConfig {
  CLIENT_ID?: string;
}

interface RedisConfig {
  ENABLED: boolean;
  URL: string;
  /**
   * BullMQ's own `prefix` option — NOT ioredis's `keyPrefix`, which BullMQ
   * documents as incompatible with it.
   */
  QUEUE_PREFIX: string;
}

/**
 * Cloudflare R2 object storage, reached through its S3-compatible API.
 *
 * Signed with `aws4fetch` rather than the AWS SDK: the SDK adds an
 * `x-amz-checksum-crc32` header by default from v3.729 onward and R2 answers
 * `501 NotImplemented` (aws/aws-sdk-js-v3#6810, still open). aws4fetch has no
 * checksum middleware to misbehave, and is ~88 KB with zero dependencies.
 */
interface StorageConfig {
  ENABLED: boolean;
  /**
   * Base URL of the S3-compatible API, with no bucket and no trailing slash
   * — `storage.service` appends `/<bucket>/<key>`. Held in the environment
   * rather than derived from ACCOUNT_ID in code so that a different R2
   * jurisdiction, an S3-compatible provider, or a local MinIO can be pointed
   * at without a code change.
   */
  ENDPOINT: string;
  ACCOUNT_ID: string;
  ACCESS_KEY_ID: string;
  SECRET_ACCESS_KEY: string;
  BUCKET: string;
  /**
   * Public base URL for reads — the bucket's custom domain or r2.dev address.
   * Not the S3 endpoint: that one requires a signature on every request, so
   * it can never be handed to a browser.
   */
  PUBLIC_URL: string;
  MAX_IMAGE_MB: number;
  MAX_VIDEO_MB: number;
  MAX_DOCUMENT_MB: number;
  /**
   * Where multer writes a file while it is being streamed to R2. Defaults to
   * the system temp directory; point it at a mounted volume when the root
   * disk is small, since peak usage here is (concurrent uploads x file size).
   */
  TMP_DIR: string;
  /**
   * How long an UNUSED row is left alone before the sweep deletes it. The
   * window exists so a file uploaded seconds before a product is saved is
   * never swept out from under the form that is still being filled in.
   */
  UNUSED_GRACE_HOURS: number;
}

/**
 * Transactional email through Resend.
 *
 * Off by default for the same reason R2 is: the app has to boot, and every
 * route that is not about email has to work, without anybody having
 * provisioned a sending domain first. With it off `email.service` refuses
 * with a 503 rather than pretending to have sent something.
 */
interface EmailConfig {
  ENABLED: boolean;
  API_KEY: string;
  /** Display name on the From header. Blank sends a bare address. */
  FROM_NAME: string;
  /**
   * The sender address. Resend verifies the *domain*, not the mailbox, so
   * the local part can be anything — but an unverified domain means every
   * send comes back `validation_error` with a 403.
   */
  FROM_ADDRESS: string;
  /** Where replies go, when that is not the sender. */
  REPLY_TO?: string;
}

interface RateLimitWindow {
  WINDOW_MINUTES: number;
  MAX: number;
}

interface RateLimitConfig {
  GLOBAL: RateLimitWindow;
  AUTH: RateLimitWindow;
  UPLOAD: RateLimitWindow;
  PASSWORD_RESET: {
    WINDOW_MINUTES: number;
    IP_MAX: number;
    EMAIL_MAX: number;
  };
}

interface Config {
  ENV: string;
  PORT: number;
  SITE_URL?: string;
  TRUST_PROXY: number;
  BODY_LIMIT: string;
  DATABASE: DatabaseConfig;
  JWT: JwtConfig;
  CRON: CronConfig;
  AUTH: AuthConfig;
  COOKIE: CookieConfig;
  CORS: CorsConfig;
  GOOGLE: GoogleConfig;
  REDIS: RedisConfig;
  STORAGE: StorageConfig;
  EMAIL: EmailConfig;
  RATE_LIMIT: RateLimitConfig;
}

const envVarsSchema = Joi.object({
  NODE_ENV: Joi.string().valid("production", "development", "test").required(),
  PORT: Joi.number().default(8080),
  // `.uri()` so a value that is present but malformed fails at boot rather
  // than inside a link someone is waiting on in their inbox.
  SITE_URL: Joi.string()
    .uri()
    .description("Public site URL; required in production"),
  DATABASE_URL: Joi.string().required().description("DB url"),
  DB_POOL_MAX: Joi.number()
    .integer()
    .min(1)
    .default(10)
    .description("Maximum pooled Postgres connections per process"),
  DB_CONNECT_TIMEOUT_MS: Joi.number()
    .integer()
    .min(0)
    .default(10_000)
    .description(
      "How long to wait for a pooled connection. node-pg's own default is " +
        "unlimited, which turns an unreachable database into hung requests " +
        "rather than errors.",
    ),
  DB_IDLE_TIMEOUT_MS: Joi.number()
    .integer()
    .min(0)
    .default(10_000)
    .description("How long an unused pooled connection is kept open"),
  DB_STATEMENT_TIMEOUT_MS: Joi.number()
    .integer()
    .min(0)
    .default(15_000)
    .description(
      "Server-side cap on one statement; 0 disables. Stops a single runaway " +
        "query holding a pooled connection indefinitely.",
    ),
  DB_CONNECT_RETRIES: Joi.number()
    .integer()
    .min(0)
    .default(5)
    .description(
      "Boot-time connection attempts before exiting. Lets the app come up " +
        "alongside a database that is still starting, without ever serving " +
        "traffic before the connection is proven.",
    ),
  DB_CONNECT_RETRY_DELAY_MS: Joi.number()
    .integer()
    .min(0)
    .default(1_000)
    .description("Base delay between boot-time attempts; doubles each time"),

  // A length floor, because every other security-relevant knob in this file
  // has one — BCRYPT_ROUNDS min 10, AUTH_CODE_EXPIRATION_SECONDS min 10 —
  // and this is the one with the widest blast radius. HS256 signs every
  // access token with this string, so a short secret is brute-forceable
  // offline from a single captured token, and whoever recovers it can mint a
  // token for any `sub` with any `role`. Nothing downstream can compensate:
  // the session lookup in `jwtVerify` trusts a valid signature.
  //
  // 20 is a floor, not a recommendation. Generate the real thing with
  // `openssl rand -base64 32` and never hand-write it.
  JWT_SECRET: Joi.string()
    .min(20)
    .required()
    .description("JWT signing secret; at least 20 characters"),
  // NO `.required()` on the four below. Joi lets `.default()` and
  // `.required()` coexist and `.required()` wins, so the defaults were dead
  // code and a deployment that set only JWT_SECRET — exactly what the README
  // documents — crashed at import. JWT_SECRET keeps `.required()` because it
  // has no default and must never acquire one.
  JWT_ACCESS_EXPIRATION_MINUTES: Joi.number()
    .default(30)
    .description("minutes after which access tokens expire"),
  // 10080 (7 days), matching README.md and .env.example. The previous 1770
  // was neither documented anywhere nor a round interval.
  JWT_REFRESH_EXPIRATION_MINUTES: Joi.number()
    .default(60 * 24 * 7)
    .description("minutes after which refresh token expire"),
  JWT_RESET_PASSWORD_EXPIRATION_MINUTES: Joi.number()
    .default(10)
    .description("minutes after which reset password token expires"),
  JWT_INVITE_USER_EXPIRATION_MINUTES: Joi.number()
    .default(60 * 24 * 7)
    .description("minutes after which invite user token expires"),

  CLEANUP_TOKENS_CRON: Joi.string()
    .description("CRON expression for token cleanup job")
    .default("0 0 * * *"),
  CLEANUP_SESSIONS_CRON: Joi.string()
    .description("CRON expression for session cleanup job")
    .default("0 2 * * *"),
  CLEANUP_FILES_CRON: Joi.string()
    .description("CRON expression for the orphaned-file sweep")
    .default("0 3 * * *"),

  AUTH_REQUIRE_EMAIL_VERIFICATION: Joi.boolean()
    .default(false)
    .description(
      "Whether login is refused for an account that has not verified its " +
        "email. Off until a verification email is actually sent.",
    ),
  MAX_LOGIN_ATTEMPTS: Joi.number()
    .default(10)
    .description("Failed login attempts before account is locked"),
  ACCOUNT_LOCK_TIME_MINUTES: Joi.number()
    .default(15)
    .description("Minutes to lock the account after exceeding attempts"),
  // Floor of 10 is OWASP's current recommendation and is enforced here rather
  // than documented, because a work factor is exactly the kind of number that
  // gets turned down to make a slow test suite or a slow laptop feel better.
  // The ceiling is a guard against a typo locking the process into
  // multi-second logins — 15 is already ~8x the default.
  AUTH_CODE_EXPIRATION_SECONDS: Joi.number()
    .integer()
    .min(10)
    .max(300)
    .default(60)
    .description(
      'Lifetime of a native login authorization code, in seconds. It covers ' +
        'one round trip, so the ceiling is deliberately low.',
    ),
  BCRYPT_ROUNDS: Joi.number()
    .integer()
    .min(10)
    .max(15)
    .default(12)
    .description(
      "bcrypt work factor for password hashing. Each step doubles the cost.",
    ),

  COOKIE_DOMAIN: Joi.string()
    .allow("")
    .description(
      "Optional cookie domain (e.g. .example.com) for production cross-subdomain cookies",
    )
    .optional(),

  ALLOWED_ORIGINS: Joi.string()
    .default("")
    .description("Comma-separated list of allowed CORS origins"),

  TRUST_PROXY: Joi.number()
    .integer()
    .min(0)
    .default(0)
    .description(
      "Number of trusted reverse-proxy hops in front of the app. 0 = direct. " +
        "Behind Cloudflare -> DigitalOcean LB -> app, this is 2. Never use a " +
        "blanket 'true': it lets any caller spoof X-Forwarded-For and walk " +
        "straight past every IP-based rate limit.",
    ),

  BODY_LIMIT: Joi.string()
    .default("100kb")
    .description("Maximum accepted request body size"),

  RATE_LIMIT_GLOBAL_WINDOW_MINUTES: Joi.number().default(15),
  RATE_LIMIT_GLOBAL_MAX: Joi.number()
    .default(300)
    .description("Requests per IP per window across the whole API"),

  RATE_LIMIT_AUTH_WINDOW_MINUTES: Joi.number().default(15),
  RATE_LIMIT_AUTH_MAX: Joi.number()
    .default(20)
    .description("Failed auth attempts per IP per window"),

  RATE_LIMIT_UPLOAD_WINDOW_MINUTES: Joi.number().default(15),
  RATE_LIMIT_UPLOAD_MAX: Joi.number()
    .default(60)
    .description("File uploads per IP per window"),

  RATE_LIMIT_PASSWORD_RESET_WINDOW_MINUTES: Joi.number().default(60),
  RATE_LIMIT_PASSWORD_RESET_IP_MAX: Joi.number()
    .default(10)
    .description("Password reset requests per IP per window"),
  RATE_LIMIT_PASSWORD_RESET_EMAIL_MAX: Joi.number()
    .default(3)
    .description("Password reset requests per email address per window"),

  GOOGLE_CLIENT_ID: Joi.string()
    .allow("")
    .description(
      "Google OAuth web client ID; when unset or empty, Google sign-in is disabled",
    )
    .optional(),

  REDIS_ENABLED: Joi.boolean()
    .default(false)
    .description(
      "Whether BullMQ queues are registered. Off by default so the app boots " +
        "without Redis; only queued work is skipped.",
    ),
  REDIS_URL: Joi.string()
    .allow("")
    .default("")
    .description("Redis connection string; rediss:// enables TLS"),
  REDIS_QUEUE_PREFIX: Joi.string()
    .default("bull")
    .description(
      "BullMQ key namespace. Change it to share one Redis across environments.",
    ),

  // Every R2_* string carries .allow("").default("") so the blank
  // .env.example placeholders boot the app. The real requirement is enforced
  // by the explicit cross-check below, not by Joi — see the comment there.
  R2_ENABLED: Joi.boolean()
    .default(false)
    .description(
      "Whether file uploads are accepted. Off by default so the app boots " +
        "without R2 credentials; upload routes then return 503.",
    ),
  R2_ENDPOINT: Joi.string()
    .allow("")
    .default("")
    // Without this a value pasted without a scheme reaches `new URL` below
    // and throws a raw ERR_INVALID_URL at import, naming config.ts and not
    // the variable at fault.
    .uri({ scheme: ["http", "https"] })
    .description(
      "Base URL of the S3 API, e.g. https://<account>.r2.cloudflarestorage.com. " +
        "No bucket and no trailing slash — both are appended per request.",
    ),
  R2_ACCOUNT_ID: Joi.string()
    .allow("")
    .default("")
    .description(
      "Cloudflare account ID. Not used to reach the bucket — R2_ENDPOINT is " +
        "— but needed for the Cloudflare API and Images transformations.",
    ),
  R2_ACCESS_KEY_ID: Joi.string()
    .allow("")
    .default("")
    .description("R2 API token access key ID"),
  R2_SECRET_ACCESS_KEY: Joi.string()
    .allow("")
    .default("")
    .description("R2 API token secret access key"),
  R2_BUCKET: Joi.string().allow("").default("").description("R2 bucket name"),
  R2_PUBLIC_URL: Joi.string()
    .allow("")
    .default("")
    .description(
      "Public base URL for reads (custom domain or r2.dev). Never the S3 " +
        "endpoint — that one needs a signature on every request.",
    ),

  UPLOAD_MAX_IMAGE_MB: Joi.number()
    .default(10)
    .description("Largest accepted image, in MB"),
  UPLOAD_MAX_VIDEO_MB: Joi.number()
    .default(95)
    .description(
      "Largest accepted video, in MB. A policy limit, not a platform one — " +
        "R2 accepts 5 GiB in a single PUT. The default is 95 rather than a " +
        "round 100 because Cloudflare caps a proxied request body at 100 MB " +
        "on Free and Pro plans (200 MB on Business), and multipart framing " +
        "adds to the file size — so a 100 MB cap means genuine 100 MB videos " +
        "are rejected with a 413 by Cloudflare before they ever reach this " +
        "app. Raise it only if the upload hostname bypasses the proxy or the " +
        "plan allows more; past a few hundred MB, add multipart upload.",
    ),
  UPLOAD_MAX_DOCUMENT_MB: Joi.number()
    .default(20)
    .description("Largest accepted document (PDF), in MB"),
  UPLOAD_TMP_DIR: Joi.string()
    .allow("")
    .default("")
    .description(
      "Directory multer writes to while streaming an upload to R2. Blank " +
        "means the system temp directory. Set it to a mounted volume when " +
        "the root disk is small — peak usage is concurrent uploads x file " +
        "size, and a full disk fails uploads.",
    ),
  FILE_UNUSED_GRACE_HOURS: Joi.number()
    .default(24)
    .description(
      "How long an UNUSED file is kept before the sweep deletes it. Must " +
        "comfortably exceed the time between uploading a product image and " +
        "saving the product, or the sweep races the form.",
    ),
  // --- Transactional email (Resend) ---
  // Same shape as the R2 block: every string carries .allow("").default("")
  // so the blank .env.example placeholders boot the app, with the real
  // requirement enforced by the explicit cross-check further down.
  EMAIL_ENABLED: Joi.boolean()
    .default(false)
    .description(
      "Whether transactional email is sent. Off by default so the app boots " +
        "without a Resend key; email.service then refuses with a 503.",
    ),
  RESEND_API_KEY: Joi.string()
    .allow("")
    .default("")
    .description(
      "Resend API key, from resend.com/api-keys. Starts with re_ and is " +
        "server-side only — it can send mail as your domain, so it never " +
        "reaches a browser and never goes in a job payload.",
    ),
  EMAIL_FROM_NAME: Joi.string()
    .allow("")
    .default("")
    .description("Display name on the From header; blank sends a bare address"),
  EMAIL_FROM_ADDRESS: Joi.string()
    .allow("")
    .default("")
    // tlds off: Joi checks the TLD against a bundled copy of the IANA list,
    // which rejects internal domains, newly delegated TLDs, and the RFC 2606
    // reserved ones the tests use (`.invalid`, `.test`). The list also goes
    // stale with the package. Shape is what is worth checking here — whether
    // the domain can actually send is Resend's verification, not ours.
    .email({ tlds: { allow: false } })
    .description(
      "Sender address. Its DOMAIN must be verified in Resend; the local " +
        "part can be anything.",
    ),
  EMAIL_REPLY_TO: Joi.string()
    .allow("")
    .default("")
    .email({ tlds: { allow: false } })
    .description("Optional Reply-To, when replies belong somewhere other than the sender"),
}).unknown();

const { value: envVars, error } = envVarsSchema
  .prefs({ errors: { label: "key" } })
  .validate(process.env);

if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

// Checked here rather than with Joi's .when(), on purpose. REDIS_URL carries
// .allow("") so the blank .env.example placeholder does not refuse to boot the
// app — the exact bug GOOGLE_CLIENT_ID and COOKIE_DOMAIN both shipped with.
// Layering a conditional .required() over .allow("") re-opens that trap,
// because "" stays in the valid set. An explicit check reads plainly and
// fails with a message that names the fix.
// CORS fails CLOSED in production.
//
// `ALLOWED_ORIGINS` defaults to "", and app.ts reads an empty list as
// `origin: true` — reflect whatever Origin the caller sent. Combined with
// `credentials: true` that is a blanket grant: any site gets
// `Access-Control-Allow-Origin: <itself>` plus
// `Access-Control-Allow-Credentials: true`, so a page on any domain can make
// credentialed calls with the victim's cookies attached and read the
// answers. Forgetting one environment variable should not silently do that,
// and nothing in the logs said it had.
//
// Outside production the permissive default stays, because a developer
// running a frontend on an arbitrary port is the normal case; app.ts warns
// at startup so it is at least visible.
if (envVars.NODE_ENV === "production" && !envVars.ALLOWED_ORIGINS) {
  throw new Error(
    "Config validation error: ALLOWED_ORIGINS is required when " +
      "NODE_ENV=production. Leaving it blank allows any origin to make " +
      "credentialed cross-site requests. Set it to a comma-separated list " +
      "of the frontend origins that may call this API.",
  );
}

// SITE_URL is how this API addresses the frontend: the password-reset link
// today, and every transactional link after it. Left unset, the link is
// assembled as `undefined/reset-password?token=<live token>` — a working,
// single-use credential pointing nowhere, mailed to someone who by
// definition cannot get into their account another way.
//
// It fails silently and late: nothing reads SITE_URL at boot, so the first
// sign of trouble is a production user reporting a dead link. Optional
// outside production, where the reset flow returns the link in the response
// body instead of mailing it.
if (envVars.NODE_ENV === "production" && !envVars.SITE_URL) {
  throw new Error(
    "Config validation error: SITE_URL is required when NODE_ENV=production. " +
      "Password-reset and verification links are built against it; without " +
      "it they are sent to users as 'undefined/...' and cannot be opened.",
  );
}

if (envVars.REDIS_ENABLED && !envVars.REDIS_URL) {
  throw new Error(
    "Config validation error: REDIS_URL is required when REDIS_ENABLED=true",
  );
}

// Same pattern, same reason. Naming every missing key in one message beats
// five boots that each fail on the next one.
if (envVars.R2_ENABLED) {
  const missing = [
    "R2_ENDPOINT",
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET",
    "R2_PUBLIC_URL",
  ].filter((key) => !envVars[key]);

  if (missing.length > 0) {
    throw new Error(
      `Config validation error: ${missing.join(", ")} ${
        missing.length === 1 ? "is" : "are"
      } required when R2_ENABLED=true`,
    );
  }

  // Cloudflare's dashboard labels `https://<account>.r2.cloudflarestorage.com/<bucket>`
  // as the "S3 API" value, so pasting it verbatim is the obvious mistake.
  // The bucket is appended per request, so that path would address
  // `/<bucket>/<bucket>/<key>` and every upload would land somewhere nobody
  // looks. Caught at boot rather than as a puzzling 404 later.
  let endpoint: URL;
  try {
    endpoint = new URL(envVars.R2_ENDPOINT as string);
  } catch {
    // Joi's .uri() above catches the ordinary cases; this is the backstop,
    // because the two parsers are not guaranteed to agree and a config
    // failure must never surface as a stack trace with no variable named.
    throw new Error(
      `Config validation error: R2_ENDPOINT is not a valid URL ` +
        `(got "${envVars.R2_ENDPOINT as string}"). Expected something like ` +
        "https://<account>.r2.cloudflarestorage.com",
    );
  }

  if (endpoint.pathname !== "/" || endpoint.search !== "") {
    throw new Error(
      "Config validation error: R2_ENDPOINT must be an origin with no path " +
        `(got "${endpoint.pathname}${endpoint.search}"). The bucket is ` +
        "appended per request — set R2_BUCKET instead.",
    );
  }
}

// Same pattern as R2 above, and the same reason: name every missing key in
// one message rather than failing on the next one at the next boot.
if (envVars.EMAIL_ENABLED) {
  const missing = ["RESEND_API_KEY", "EMAIL_FROM_ADDRESS"].filter(
    (key) => !envVars[key],
  );

  if (missing.length > 0) {
    throw new Error(
      `Config validation error: ${missing.join(", ")} ${
        missing.length === 1 ? "is" : "are"
      } required when EMAIL_ENABLED=true`,
    );
  }

  // Resend keys are prefixed `re_`. Checked at boot because the alternative
  // is finding out at the first real send — and once sending moves onto a
  // queue (todo/sugestion-2.md) that is five retries and a dead job instead
  // of one line at startup. The usual paste mistakes are a webhook signing
  // secret (`whsec_...`) or a key belonging to a different provider.
  if (!(envVars.RESEND_API_KEY as string).startsWith("re_")) {
    throw new Error(
      "Config validation error: RESEND_API_KEY does not look like a Resend " +
        'API key (expected it to start with "re_"). Check it is the key ' +
        "from resend.com/api-keys and not a webhook signing secret.",
    );
  }
}

const config: Config = {
  ENV: envVars.NODE_ENV,
  PORT: envVars.PORT,
  SITE_URL: envVars.SITE_URL,
  TRUST_PROXY: envVars.TRUST_PROXY,
  BODY_LIMIT: envVars.BODY_LIMIT,
  DATABASE: {
    URL: `${envVars.DATABASE_URL}`,
    POOL_MAX: envVars.DB_POOL_MAX,
    CONNECT_TIMEOUT_MS: envVars.DB_CONNECT_TIMEOUT_MS,
    IDLE_TIMEOUT_MS: envVars.DB_IDLE_TIMEOUT_MS,
    STATEMENT_TIMEOUT_MS: envVars.DB_STATEMENT_TIMEOUT_MS,
    CONNECT_RETRIES: envVars.DB_CONNECT_RETRIES,
    CONNECT_RETRY_DELAY_MS: envVars.DB_CONNECT_RETRY_DELAY_MS,
  },
  JWT: {
    SECRET: envVars.JWT_SECRET,
    ACCESS_EXPIRATION_MINUTES: envVars.JWT_ACCESS_EXPIRATION_MINUTES,
    REFRESH_EXPIRATION_MINUTES: envVars.JWT_REFRESH_EXPIRATION_MINUTES,
    RESET_PASSWORD_EXPIRATION_MINUTES:
      envVars.JWT_RESET_PASSWORD_EXPIRATION_MINUTES,
    USER_INVITE_EXPIRATION_MINUTES: envVars.JWT_INVITE_USER_EXPIRATION_MINUTES,
  },
  CRON: {
    TOKEN_CLEANUP: envVars.CLEANUP_TOKENS_CRON,
    SESSION_CLEANUP: envVars.CLEANUP_SESSIONS_CRON,
    FILE_CLEANUP: envVars.CLEANUP_FILES_CRON,
  },
  AUTH: {
    MAX_LOGIN_ATTEMPTS: envVars.MAX_LOGIN_ATTEMPTS,
    LOCK_TIME_MINUTES: envVars.ACCOUNT_LOCK_TIME_MINUTES,
    BCRYPT_ROUNDS: envVars.BCRYPT_ROUNDS,
    CODE_EXPIRATION_SECONDS: envVars.AUTH_CODE_EXPIRATION_SECONDS,
    REQUIRE_EMAIL_VERIFICATION: envVars.AUTH_REQUIRE_EMAIL_VERIFICATION,
  },
  COOKIE: {
    // Normalise the blank .env.example placeholder to undefined; Joi.string()
    // rejects "" outright, which otherwise refuses to boot the whole app.
    DOMAIN: envVars.COOKIE_DOMAIN || undefined,
  },
  CORS: {
    ALLOWED_ORIGINS: (envVars.ALLOWED_ORIGINS as string)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
  GOOGLE: {
    // Normalise "" (the .env.example placeholder) to undefined so the
    // "is Google configured?" check is a single truthiness test.
    CLIENT_ID: envVars.GOOGLE_CLIENT_ID || undefined,
  },
  REDIS: {
    ENABLED: envVars.REDIS_ENABLED,
    URL: envVars.REDIS_URL,
    QUEUE_PREFIX: envVars.REDIS_QUEUE_PREFIX,
  },
  STORAGE: {
    ENABLED: envVars.R2_ENABLED,
    // Trailing slash stripped for the same reason as PUBLIC_URL below.
    ENDPOINT: (envVars.R2_ENDPOINT as string).replace(/\/+$/, ""),
    ACCOUNT_ID: envVars.R2_ACCOUNT_ID,
    ACCESS_KEY_ID: envVars.R2_ACCESS_KEY_ID,
    SECRET_ACCESS_KEY: envVars.R2_SECRET_ACCESS_KEY,
    BUCKET: envVars.R2_BUCKET,
    // Trailing slash stripped once here, so every caller can build a URL as
    // `${PUBLIC_URL}/${key}` without producing a double slash.
    PUBLIC_URL: (envVars.R2_PUBLIC_URL as string).replace(/\/+$/, ""),
    MAX_IMAGE_MB: envVars.UPLOAD_MAX_IMAGE_MB,
    MAX_VIDEO_MB: envVars.UPLOAD_MAX_VIDEO_MB,
    MAX_DOCUMENT_MB: envVars.UPLOAD_MAX_DOCUMENT_MB,
    // Blank placeholder normalised to the system temp directory, the same
    // way COOKIE_DOMAIN and GOOGLE_CLIENT_ID are handled.
    TMP_DIR: envVars.UPLOAD_TMP_DIR || os.tmpdir(),
    UNUSED_GRACE_HOURS: envVars.FILE_UNUSED_GRACE_HOURS,
  },
  EMAIL: {
    ENABLED: envVars.EMAIL_ENABLED,
    API_KEY: envVars.RESEND_API_KEY,
    FROM_NAME: envVars.EMAIL_FROM_NAME,
    FROM_ADDRESS: envVars.EMAIL_FROM_ADDRESS,
    // Blank placeholders normalised to undefined, as COOKIE_DOMAIN and
    // GOOGLE_CLIENT_ID are, so "is it set?" stays one truthiness test.
    REPLY_TO: envVars.EMAIL_REPLY_TO || undefined,
  },
  RATE_LIMIT: {
    GLOBAL: {
      WINDOW_MINUTES: envVars.RATE_LIMIT_GLOBAL_WINDOW_MINUTES,
      MAX: envVars.RATE_LIMIT_GLOBAL_MAX,
    },
    AUTH: {
      WINDOW_MINUTES: envVars.RATE_LIMIT_AUTH_WINDOW_MINUTES,
      MAX: envVars.RATE_LIMIT_AUTH_MAX,
    },
    UPLOAD: {
      WINDOW_MINUTES: envVars.RATE_LIMIT_UPLOAD_WINDOW_MINUTES,
      MAX: envVars.RATE_LIMIT_UPLOAD_MAX,
    },
    PASSWORD_RESET: {
      WINDOW_MINUTES: envVars.RATE_LIMIT_PASSWORD_RESET_WINDOW_MINUTES,
      IP_MAX: envVars.RATE_LIMIT_PASSWORD_RESET_IP_MAX,
      EMAIL_MAX: envVars.RATE_LIMIT_PASSWORD_RESET_EMAIL_MAX,
    },
  },
};

export default config;
