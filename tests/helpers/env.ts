/**
 * Environment for every test run. Loaded by jest's `setupFiles`, which is the
 * last moment before `src/config/config.ts` is imported — that module reads
 * `process.env` exactly once, at import, so anything set later is ignored.
 *
 * `dotenv` does not overwrite variables already present, so everything set
 * here wins over `.env`.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// dotenv prints a banner to stderr on load, which jest surfaces as a
// console.error on every spec file. Nothing to do with the tests.
process.env.DOTENV_CONFIG_QUIET = "true";

// Switches off the rate limiters (`skip: () => config.ENV === "test"`), which
// would otherwise leak counters between specs and fail whichever one happened
// to exhaust a bucket first.
process.env.NODE_ENV = "test";

// Storage is switched ON so the file specs exercise the real code path. No
// request ever leaves the machine: the specs point `getR2Endpoint` at a local
// stub (see `tests/helpers/r2-stub.ts`).
process.env.R2_ENABLED = "true";
process.env.R2_ENDPOINT = "https://test-account.r2.cloudflarestorage.com";
process.env.R2_ACCOUNT_ID = "test-account";
process.env.R2_ACCESS_KEY_ID = "test-access-key";
process.env.R2_SECRET_ACCESS_KEY = "test-secret-key";
process.env.R2_BUCKET = "test-bucket";
process.env.R2_PUBLIC_URL = "https://media.test.invalid";

process.env.UPLOAD_MAX_IMAGE_MB ??= "10";
process.env.UPLOAD_MAX_VIDEO_MB ??= "95";
process.env.UPLOAD_MAX_DOCUMENT_MB ??= "20";
process.env.FILE_UNUSED_GRACE_HOURS ??= "24";

// A directory of its own, so a spec that asserts "no temp file was left
// behind" cannot be confused by unrelated junk in the system temp directory.
const tmpDir = path.join(os.tmpdir(), "boilerplate-tests");
fs.mkdirSync(tmpDir, { recursive: true });
process.env.UPLOAD_TMP_DIR = tmpDir;

// Keep the boot-time connection retries short; the defaults back off to
// ~31 seconds, which is correct in production and useless in a test.
process.env.DB_CONNECT_RETRIES ??= "1";
process.env.DB_CONNECT_RETRY_DELAY_MS ??= "10";

// Forced, not defaulted. Google sign-in is only enabled when a client ID is
// present (`isGoogleAuthConfigured`), so without this the Google specs would
// pass or fail depending on whether the developer running them happens to
// have a real GOOGLE_CLIENT_ID in their `.env` — and any assertion about the
// `audience` passed to Google would be asserting against their credential.
// Nothing reaches Google: `googleClient.verifyIdToken` is mocked in every
// spec that touches it.
process.env.GOOGLE_CLIENT_ID = "test-google-client-id.apps.googleusercontent.com";

// Email is switched ON so the email specs exercise the real service, the
// same way R2 is. Nothing leaves the machine: every spec mocks the Resend
// client, and the key is a syntactically valid fake (config.ts checks the
// `re_` prefix at boot, so a placeholder like "test-key" would refuse to
// start the whole suite).
process.env.EMAIL_ENABLED = "true";
process.env.RESEND_API_KEY = "re_test_key_not_real";
process.env.EMAIL_FROM_NAME = "Boilerplate Test";
process.env.EMAIL_FROM_ADDRESS = "no-reply@test.invalid";

// Forced blank, not defaulted. A developer with a reply-to in their own .env
// would otherwise silently change what the send specs assert.
process.env.EMAIL_REPLY_TO = "";

// The ENFORCED FLOOR, not a convenience value. `BCRYPT_ROUNDS` has a Joi
// `.min(10)`, so the suite still runs against a work factor that is valid in
// production — it is simply the cheapest valid one. The default is 12, and at
// 12 the hundred-odd accounts these specs create cost about 30 extra seconds
// on `bcryptjs`, which is a pure-JS implementation and several times slower
// than a native binding. Anything below 10 would be testing a configuration
// the application refuses to start with.
process.env.BCRYPT_ROUNDS ??= "10";

process.env.JWT_SECRET ??= "test-only-secret-not-used-anywhere-real";
process.env.SITE_URL ??= "http://localhost:5173";
