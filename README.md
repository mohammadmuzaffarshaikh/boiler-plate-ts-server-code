# Boiler Plate Code for express server with prisma

A TypeScript Express boilerplate using Prisma 7 (Postgres via pg driver adapter), JWT + cookie-based auth, sessions persisted in DB, login-attempt lockout, and scheduled cleanup jobs.

## Steps to run

1. Clone or fork the repo and install dependencies:

   ```bash
   pnpm install
   ```

2. Install Docker if you don't have it already.

3. Create a Docker volume for Postgres:

   ```bash
   sudo docker volume create postgres_data1
   ```

4. Start a Postgres container:

   ```bash
   sudo docker run -e POSTGRES_PASSWORD=mysecretpassword -d -p 5432:5432 -v postgres_data1:/var/lib/postgresql/data postgres
   ```

5. Create your `.env` file (see [Environment variables](#environment-variables) below):

   ```bash
   cp .env.example .env
   ```

6. Migrate the database:

   ````bash
   pnpm prisma:migrate
   ```;

   ````

7. Start the dev server:

   ```bash
   pnpm dev
   ```

## Environment variables

Copy `.env.example` to `.env` and fill in the values. Required keys are marked **required**; everything else has a sensible default.

### Core

| Variable       | Required | Default | Description                                                                 |
| -------------- | -------- | ------- | --------------------------------------------------------------------------- |
| `NODE_ENV`     | ✅       | —       | One of `development`, `production`, `test`                                  |
| `PORT`         |          | `8080`  | HTTP port the server binds to                                               |
| `SITE_URL`     |          | —       | Public site URL used in password reset links (e.g. `http://localhost:5173`) |
| `DATABASE_URL` | ✅       | —       | Postgres connection string used by Prisma and the `pg` driver adapter       |

### Database connection

| Variable                    | Default | Description                                                                 |
| --------------------------- | ------- | --------------------------------------------------------------------------- |
| `DB_POOL_MAX`               | `10`    | Maximum pooled connections per process                                       |
| `DB_CONNECT_TIMEOUT_MS`     | `10000` | Wait for a pooled connection. node-pg defaults to **unlimited**, which turns an unreachable database into hung requests |
| `DB_IDLE_TIMEOUT_MS`        | `10000` | How long an unused connection is kept open                                   |
| `DB_STATEMENT_TIMEOUT_MS`   | `15000` | Server-side cap on one statement; `0` disables                               |
| `DB_CONNECT_RETRIES`        | `5`     | Boot-time attempts before the process exits non-zero                         |
| `DB_CONNECT_RETRY_DELAY_MS` | `1000`  | Base delay between attempts; doubles each time                               |

**The server does not start without a database.** `connectDatabase()` opens the pool and then
round-trips a real `SELECT 1`, because `prisma.$connect()` is *not* a connectivity check when a
driver adapter is in use — it resolves against a port with nothing listening, and the first real
query is what fails. Relying on it meant logging "Connected to PostgreSQL", accepting traffic, and
answering every request with a 500.

Retries cover the one common case where the app and the database start together and Postgres is a
second or two behind. They are bounded: after the last attempt the process exits non-zero so the
orchestrator restarts it, rather than sitting in a permanent "starting" state.

**Worst-case boot time is worth knowing before you set a health-check grace period.** A refused
connection fails instantly, so the defaults give up in about a second. A host that *drops* packets
instead is the slow case: each attempt waits `DB_CONNECT_TIMEOUT_MS`, so with the defaults
(6 attempts × 10s, plus 31s of backoff) the process can take roughly 90 seconds to exit. Lower
`DB_CONNECT_RETRIES` or `DB_CONNECT_TIMEOUT_MS` if your orchestrator is less patient than that.

`GET /api/health` uses a much shorter probe timeout (2s) than the pool's connect timeout, so a
black-holed database is reported as down rather than hanging the check past the load balancer's own
timeout. Its answer is cached for a second: the endpoint is unauthenticated and exempt from the
rate limiter, so without that, every request anyone sent would be a database round-trip.

Once running, `GET /api/health` reports **503** whenever Postgres is unreachable, so an instance
that loses its database is pulled out of rotation instead of serving errors. Redis is reported but
never fails the check — it backs deferred side-effects only.

### JWT

| Variable                                | Required | Default      | Description                                                       |
| --------------------------------------- | -------- | ------------ | ----------------------------------------------------------------- |
| `JWT_SECRET`                            | ✅       | —            | Secret used to sign access/refresh JWTs. Use a long random string |
| `JWT_ACCESS_EXPIRATION_MINUTES`         |          | `30`         | Access token lifetime                                             |
| `JWT_REFRESH_EXPIRATION_MINUTES`        |          | `10080` (7d) | Refresh token / session lifetime                                  |
| `JWT_RESET_PASSWORD_EXPIRATION_MINUTES` |          | `10`         | Password reset token lifetime                                     |
| `JWT_INVITE_USER_EXPIRATION_MINUTES`    |          | `10080` (7d) | Invite token lifetime                                             |

### Auth — login lockout

| Variable                    | Default | Description                                                |
| --------------------------- | ------- | ---------------------------------------------------------- |
| `MAX_LOGIN_ATTEMPTS`        | `10`    | Failed login attempts before the account locks             |
| `ACCOUNT_LOCK_TIME_MINUTES` | `15`    | How long an account stays locked — and, as the same span, how long a failed attempt counts toward the limit |
| `AUTH_REQUIRE_EMAIL_VERIFICATION` | `false` | Refuse login for an account with no `emailVerifiedAt`. ADMIN is exempt |

The failed-attempt counter is a **sliding window**, not a lifetime total:
failures older than `ACCOUNT_LOCK_TIME_MINUTES` no longer count. Using the
same span for both is what makes a lock self-clearing — once it expires the
window has expired with it, so the next mistyped password starts from one
rather than re-locking the account. A password reset also clears the lockout,
because resetting is the documented way out of one.

`AUTH_REQUIRE_EMAIL_VERIFICATION` is off deliberately. Nothing sends a
verification email yet, so switching it on today would lock out every account
with no way to complete the round-trip. The gate itself is wired and tested —
see `assertEmailVerificationPolicy` in `src/services/auth.service.ts`.

### Google sign-in (optional)

| Variable           | Default | Description                                                                 |
| ------------------ | ------- | --------------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID` | —       | OAuth **web** client ID. Leave blank and Google sign-in is disabled — the endpoint answers `501` |

One variable, and no client secret: this is the Google Identity Services
**ID-token** flow, so the API verifies a signed assertion locally rather than
exchanging an authorization code. `GOOGLE_CLIENT_SECRET` is read by nothing —
do not put one in `.env`.

The frontend posts the GIS `credential` string to `POST /api/app/auth/google`
as `{ "idToken": "..." }`. In the Google Cloud console, set
**Authorised JavaScript origins** to your frontend origins and leave
**Authorised redirect URIs** empty — there is no callback route and the
browser never navigates to the API.

Note that Google sign-in **cannot create an account**. An address with no row
in `users` is refused with a `403`; it is a login method for staff who already
exist, not a signup path. See [`docs/decisions.md`](docs/decisions.md) §15.

### Cookies & CORS

| Variable          | Default | Description                                                                                               |
| ----------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `COOKIE_DOMAIN`   | —       | Optional domain for production cross-subdomain cookies (e.g. `.example.com`). Leave blank for same-origin |
| `ALLOWED_ORIGINS` | —       | Comma-separated list of allowed CORS origins. **Required in production** — see below |

**`ALLOWED_ORIGINS` is mandatory when `NODE_ENV=production`; the app refuses to
start without it.** Left blank, CORS reflects whatever `Origin` the caller sent,
and because `credentials: true` is always set that lets any website make
credentialed requests as the visitor and read the replies. In development the
permissive default stays, since a frontend on an arbitrary port is the normal
case, and the app logs a warning at startup so it is visible.

### Cron schedules (UTC)

| Variable                | Default     | Description                                                                   |
| ----------------------- | ----------- | ----------------------------------------------------------------------------- |
| `CLEANUP_TOKENS_CRON`   | `0 0 * * *` | When to delete expired reset-password tokens (default: daily at 00:00 UTC)    |
| `CLEANUP_SESSIONS_CRON` | `0 2 * * *` | When to delete expired or long-revoked sessions (default: daily at 02:00 UTC) |
| `CLEANUP_FILES_CRON`    | `0 3 * * *` | When to sweep unattached files and report orphaned objects (daily 03:00 UTC) |

### Redis / queues (optional)

| Variable             | Default | Description                                                              |
| -------------------- | ------- | ------------------------------------------------------------------------ |
| `REDIS_ENABLED`      | `false` | Whether queues are registered. Off by default; the API boots without it. |
| `REDIS_URL`          | —       | Connection string. `rediss://` enables TLS. Required when enabled.       |
| `REDIS_QUEUE_PREFIX` | `bull`  | BullMQ key namespace, so one Redis can host several environments.        |

### Cloudflare R2 / file uploads (optional)

| Variable                | Default | Description                                                                      |
| ----------------------- | ------- | -------------------------------------------------------------------------------- |
| `R2_ENABLED`            | `false` | Whether uploads are accepted. Off by default; upload routes then answer `503`.   |
| `R2_ENDPOINT`           | —       | Base URL of the S3 API, e.g. `https://<account>.r2.cloudflarestorage.com`. **Origin only** — no bucket, no trailing slash; both are appended per request. Required when enabled. |
| `R2_ACCOUNT_ID`         | —       | Cloudflare account ID. Not used to reach the bucket (`R2_ENDPOINT` is), but needed for the Cloudflare API and Images transformations. Required when enabled. |
| `R2_ACCESS_KEY_ID`      | —       | R2 API token access key ID. Required when enabled.                               |
| `R2_SECRET_ACCESS_KEY`  | —       | R2 API token secret. Required when enabled.                                      |
| `R2_BUCKET`             | —       | Bucket name. Required when enabled.                                              |
| `R2_PUBLIC_URL`         | —       | Public base URL for reads (custom domain or `r2.dev`). Required when enabled.    |
| `UPLOAD_MAX_IMAGE_MB`   | `10`    | Largest accepted image                                                           |
| `UPLOAD_MAX_VIDEO_MB`   | `95`    | Largest accepted video. See [Deploying behind a proxy](#deploying-behind-a-proxy) before raising it |
| `UPLOAD_MAX_DOCUMENT_MB`| `20`    | Largest accepted document (PDF)                                                  |
| `UPLOAD_TMP_DIR`        | system temp | Where an upload is spooled while streaming to R2. Point at a volume if the root disk is small |
| `FILE_UNUSED_GRACE_HOURS` | `24`  | How long an unattached file survives before the nightly sweep removes it         |

### Transactional email (optional)

Sent through [Resend](https://resend.com). Optional in the same way R2 is: with
`EMAIL_ENABLED=false` (the default) the app boots with no key and `email.service`
answers `503` instead of pretending to send.

| Variable                | Default | Description                                                                      |
| ----------------------- | ------- | -------------------------------------------------------------------------------- |
| `EMAIL_ENABLED`         | `false` | Whether mail is sent. Off by default; sends then answer `503`.                   |
| `RESEND_API_KEY`        | —       | From [resend.com/api-keys](https://resend.com/api-keys). Must start with `re_` — checked at boot. Required when enabled. |
| `EMAIL_FROM_NAME`       | —       | Display name on the From header. Blank sends a bare address.                     |
| `EMAIL_FROM_ADDRESS`    | —       | Sender address. Its **domain** must be verified in Resend; the local part can be anything. Required when enabled. |
| `EMAIL_REPLY_TO`        | —       | Where replies go, when that is not the sender.                                   |

Two things about this integration are not like the rest of the codebase, and
both are load-bearing:

- **The Resend SDK does not throw on an API error.** `emails.send()` resolves to
  a discriminated `{ data, error }`, and Resend's own docs say not to wrap it in
  `try/catch`. A `try` block around a send therefore catches a DNS failure and
  sails straight past a `403` for an unverified sending domain.
  `services/email.service.ts` is the only place allowed to call `send`, and
  converting that result into a thrown `EmailSendError` is its job.
- **Every send carries an `AbortSignal`.** The SDK sets no timeout, so without
  one a provider that accepts a connection and then goes quiet holds an HTTP
  request — or a BullMQ job and its worker slot — indefinitely. Default 15s,
  raise it per send with `timeoutMs` for a large attachment.
- **The provider's HTTP status is `providerStatusCode`, never `statusCode`.**
  `errorConverter` duck-types on `statusCode`, so naming it that handed Resend's
  403s and 429s — and their messages — straight to the caller.
- **`EmailSendError` carries `retryable`.** A rate limit or a 5xx is worth
  trying again; an unverified domain or a malformed payload is not, and retrying
  it five times only buries the real error under four identical ones. Quota
  exhaustion returns `429` but is *not* retryable — a daily quota resets at
  midnight UTC, long after the job gives up. When the provider says how long to
  wait, `retryAfterMs` carries it, ready for BullMQ's `worker.rateLimit(ms)`.

Templates are not part of this. `utils/render-template.ts` renders a string it
is handed; where templates are stored is [`todo/sugestion-5.md`](./todo/sugestion-5.md).


## Available scripts

### Run / build

| Script            | What it does                                                                  |
| ----------------- | ----------------------------------------------------------------------------- |
| `pnpm dev`        | nodemon → `ts-node src/index.ts`, watches `src/`, sets `NODE_ENV=development` |
| `pnpm build`      | `tsc` — emits `dist/`                                                         |
| `pnpm start`      | `node dist/index.js` (run `pnpm build` first)                                 |
| `pnpm start:prod` | pm2 daemonless using `ecosystem.config.json` (uses `dist/index.js`)           |

### Code quality

| Script                 | What it does                               |
| ---------------------- | ------------------------------------------ |
| `pnpm typecheck`       | `tsc --noEmit` — type-check without emit   |
| `pnpm typecheck:tests` | the same, including the specs under `tests/` |
| `pnpm lint`            | ESLint flat config                         |
| `pnpm lint:fix`        | ESLint with autofix                        |

### Tests

See [`tests/README.md`](./tests/README.md) for the layout, prerequisites and conventions.

| Script                  | What it does                                               |
| ----------------------- | ---------------------------------------------------------- |
| `pnpm test`             | the whole suite, serially                                   |
| `pnpm test:unit`        | specs that need no database and no network                  |
| `pnpm test:integration` | specs that need Postgres (uses a local R2 stub, not Cloudflare) |
| `pnpm test:watch`       | watch mode                                                  |
| `pnpm test:coverage`    | coverage summary plus `coverage/lcov-report/index.html`     |

### Prisma

| Script                 | What it does                                                        |
| ---------------------- | ------------------------------------------------------------------- |
| `pnpm prisma:generate` | regenerate Prisma client (also runs automatically on `postinstall`) |
| `pnpm prisma:migrate`  | `prisma migrate dev` — interactive dev migration                    |
| `pnpm prisma:deploy`   | `prisma migrate deploy` — apply migrations in production            |
| `pnpm prisma:push`     | `prisma db push` — sync schema without migration files (fast dev)   |
| `pnpm prisma:studio`   | open Prisma Studio                                                  |

### Docker compose

| Script             | What it does                    |
| ------------------ | ------------------------------- |
| `pnpm docker:dev`  | bring up the dev compose stack  |
| `pnpm docker:prod` | bring up the prod compose stack |
| `pnpm docker:test` | bring up the test compose stack |

## Typical flows

- **First-time setup**: `pnpm install` → copy `.env.example` to `.env` and fill values → `pnpm prisma:push` (or `pnpm prisma:migrate --name init`) → `pnpm dev`
- **Production deploy**: `pnpm install` → `pnpm build` → `pnpm prisma:deploy` → `pnpm start` (or `pnpm start:prod` for pm2)

## Redis and background queues

`src/config/redis.ts` provides the Redis connections that BullMQ needs. BullMQ itself is not
installed yet — queues and workers are built on top of this.

Redis is **optional**. With `REDIS_ENABLED=false` (the default) the app boots and every route
works; only queued work is skipped. Unlike the Postgres connection, an unreachable Redis does not
stop startup — `initRedis()` logs the failure and returns, and ioredis reconnects on its own.

### Two connections, not one

| Role     | Accessor                | `maxRetriesPerRequest` | `enableOfflineQueue` | Used by                      |
| -------- | ----------------------- | ---------------------- | -------------------- | ---------------------------- |
| Producer | `getQueueConnection()`  | `1`                    | `false`              | `new Queue(...)`             |
| Consumer | `getWorkerConnection()` | `null`                 | `true`               | `new Worker` / `QueueEvents` |

The two sets of settings are contradictory, which is why one shared client cannot serve both.
A producer runs on the HTTP request path and must fail fast: with these settings an enqueue
against a dead Redis rejects in ~0 ms instead of hanging the request. A consumer uses blocking
commands that are _supposed_ to sit idle, so it must have no per-request retry ceiling — BullMQ
requires `null` there.

Within a role the client is shared, so N queues still cost one connection. Each worker costs
roughly two, because BullMQ duplicates the connection internally for its blocking socket.

```ts
import {
  isRedisEnabled,
  getQueueConnection,
  getWorkerConnection,
} from "./config/redis";

if (isRedisEnabled()) {
  const emailQueue = new Queue("email", {
    connection: getQueueConnection(),
    prefix: config.REDIS.QUEUE_PREFIX,
  });
}
```

Gate on `isRedisEnabled()` once, where queues are registered. The accessors **throw** when Redis
is disabled rather than returning `null`, so you never need a null check at a call site.

### Operational requirements

- The Redis instance must run with **`maxmemory-policy=noeviction`**. BullMQ calls this "the only
  setting that guarantees the correct behavior of the queues" — under any evicting policy Redis
  drops queue keys and jobs vanish with no error anywhere.
- Enable AOF persistence if jobs must survive a Redis restart.
- Never set ioredis's `keyPrefix`. BullMQ does its own key prefixing and documents the two as
  incompatible. Use `REDIS_QUEUE_PREFIX` (BullMQ's `prefix` option) instead.

### Shutdown order

Workers first, then queues, then the connection:

```ts
await worker.close(); // stop accepting, let in-flight jobs finish
await queue.close();
await closeRedis(); // already wired into src/index.ts
```

Closing the shared connection first strands in-flight jobs, which another worker then has to
recover as stalled ~30 s later.

## File uploads (Cloudflare R2)

Staff and admins upload through `POST /api/app/files`. The API proxies the upload to Cloudflare R2
— the browser never talks to R2 directly, so the bucket credentials never leave the server.

The request carries two things: the bytes in `file`, and the destination in `folder`.

| `folder` | Accepts | Cap |
| --- | --- | --- |
| `product_images` | JPEG, PNG, GIF, WebP, AVIF | `UPLOAD_MAX_IMAGE_MB` |
| `product_videos` | MP4, MOV, WebM | `UPLOAD_MAX_VIDEO_MB` |
| `documents` | PDF, DOCX, XLSX, PPTX, DOC, XLS, PPT | `UPLOAD_MAX_DOCUMENT_MB` |
| `profile_images` | JPEG, PNG, GIF, WebP, AVIF | `UPLOAD_MAX_IMAGE_MB` |

```bash
curl -X POST http://localhost:8080/api/app/files \
  -H "Authorization: Bearer $TOKEN" \
  -F folder=product_images \
  -F file=@blue-hoodie-front.jpg
```

`folder` is **required** and is matched against a closed allowlist (`uploadFolders` in
`src/config/constants.ts`) — it is never concatenated into a path, which is the only safe way to
turn a request field into a prefix. It decides two things: where the object lands, and which file
types are accepted there. Sending an MP4 to `product_images` is a `415`.

It is also recorded on the row, so `GET /api/app/files?folder=product_images` does not have to
pattern-match the key column.

### The object key

```
<folder>/<slug>-<uuid>.<extension>
product_images/blue-hoodie-front-0a6b2d44-0b1e-4b0e-9a6f-6b0c6b2d4401.jpg
```

Each part is decided server-side. The folder is an allowlist lookup; the extension comes from the
sniffed type, not the filename; the uuid is what makes the key unique.

The slug is the uploaded filename reduced to lowercase ASCII letters, digits and single hyphens,
capped at 48 characters — and it is the one piece the request influences. That is a deliberate
change from "nothing in the key comes from the client": these URLs are public product media, and a
readable one is worth more to a storefront than a bare uuid. Every property the stricter rule
protected still holds, because the slug cannot contain `/`, `.` or `%`, and uniqueness was never
its job. A name with no Latin characters in it slugs to nothing and the key is just the uuid.

`originalName` is stored separately for display, sanitised but not transliterated: path segments
dropped, control characters and bidirectional overrides stripped, whitespace collapsed, length
capped. `Größentabelle.pdf` is kept as it is; `../../etc/pass<RLO>wd.png` is not.

Uploads are **optional**. With `R2_ENABLED=false` (the default) the app boots normally and the
upload routes answer `503`; nothing else is affected.

### Why aws4fetch and not the AWS SDK

R2 speaks the S3 API, so `@aws-sdk/client-s3` is the obvious choice and is the wrong one here.
From v3.729 the SDK adds an `x-amz-checksum-crc32` header to every PUT by default, and R2 answers
`501 NotImplemented` ([aws-sdk-js-v3#6810](https://github.com/aws/aws-sdk-js-v3/issues/6810), still
open). `aws4fetch` — which Cloudflare's own R2 docs use — has no middleware stack to inject
anything: it signs the request and nothing else. It is ~88 KB with zero dependencies, and ships a
CommonJS build, which this Node 20 / CJS project needs.

Integrity is not lost in the trade. `storage.service` sends `Content-MD5`, which R2 *does*
implement, and the header is covered by the SigV4 signature.

### The file type is read from the bytes, never from the request

Both things a browser tells you about a file — the filename, so the extension, and the multipart
`Content-Type` — are chosen by the client. `src/utils/detect-file-type.ts` ignores both and matches
the file's leading bytes against a closed allowlist: JPEG, PNG, GIF, WebP, AVIF, MP4, MOV, WebM,
PDF. Anything else is refused.

**Office documents need a second pass.** Every OOXML file (`.docx`, `.xlsx`, `.pptx`) is a ZIP and
every legacy one (`.doc`, `.xls`, `.ppt`) is an OLE compound file, so no byte prefix can tell them
apart — `.docx` and `.xlsx` have the identical signature. `src/utils/detect-container-type.ts`
opens the container and reads its index: the OOXML main part name (`word/document.xml`,
`xl/workbook.xml`, `ppt/presentation.xml`) or the CFB stream name (`WordDocument`, `Workbook`).
It takes a path rather than a buffer because a ZIP keeps its index at the *end* of the file.

Being a container is not enough. A plain `.zip` or `.jar` matches nothing and is refused, and so is
a **macro-enabled document** (`.docm`, `.xlsm`) — byte-identical to its safe sibling apart from a
`vbaProject.bin` part, and accepting it would mean this API distributing executable content under
a content type that looks inert. ZIP64 archives and compound files that hide their main stream
past the first directory sector are refused rather than guessed at.

**SVG is excluded on purpose.** An SVG is an XML document that may contain `<script>`; served back
from your own domain it is stored XSS wearing a picture icon. Renaming `payload.svg` to `photo.jpg`
and declaring `image/jpeg` gets past the filename check and is then refused by the sniffer.

The size cap is applied *after* sniffing, so a 90 MB file named `clip.mp4` that is really a JPEG is
measured against the image limit.

Which types are reachable depends on the folder, not on the endpoint — see `folderPolicy` in
`src/config/constants.ts`. There is one upload route and it serves all four folders.

### Memory stays flat

multer writes to `diskStorage` in the system temp directory and the file is piped from there to R2.
`memoryStorage` with a 100 MB video cap would mean 100 MB of heap per concurrent upload. The temp
file is removed in a `finally`, including when R2 rejects the upload.

The upload PUT is the one request in `storage.service.ts` that does **not** go through `fetch`.
undici's `fetch` buffers a streaming request body instead of applying backpressure, so on Node 20 a
100 MB upload grows RSS by ~125 MB whether the body is passed as a Node `Readable` or converted
with `Readable.toWeb` — which would undo the entire reason multer writes to disk. Measured against
a local sink:

| Transport | 10 MB | 100 MB | 200 MB |
| --- | --- | --- | --- |
| `fetch` (either body form) | +25 MB | +125 MB | — |
| `http.request` + `pipe` | +14 MB | +39 MB | +39 MB |

Growth stops tracking file size, which is the property that matters. aws4fetch still does the
signing: the request is signed *without* the body, which is exact rather than a shortcut — for S3
aws4fetch sets `X-Amz-Content-Sha256: UNSIGNED-PAYLOAD`, so the signature never covers the payload.
`Content-Type` and `Content-Length` are added after signing because aws4fetch treats both as
unsignable; `Content-MD5` is passed before signing because it is covered.

The other verbs (`DELETE`, `HEAD`, `GET` for listing) send no request body and stay on `fetch`.

### Lifecycle, and why deletes are crash-safe

| Status | Meaning |
| --- | --- |
| `UNUSED` | Uploaded, attached to nothing. Swept after `FILE_UNUSED_GRACE_HOURS`. |
| `IN_USE` | Referenced by a product. Never swept. |
| `PENDING_DELETE` | A delete is in progress, or crashed partway. |

Deleting is three steps in this order: mark the row `PENDING_DELETE`, delete the object from R2,
delete the row. Removing the object first would leave, on a crash, a live row pointing at nothing.
This ordering leaves work the nightly sweep finishes instead. The object delete is idempotent, so
the retry costs nothing.

When the `Product` model lands, the product service should call `fileService.markFilesInUse` inside
the same transaction that saves the product — doing it afterwards leaves a window where the product
is saved and its images are still sweepable.

### The nightly sweep

`CLEANUP_FILES_CRON` (03:00 UTC by default) does two things:

1. Deletes `UNUSED` rows older than the grace period, and finishes any `PENDING_DELETE`. The grace
   period is what stops it racing a staff member who has uploaded an image and not yet pressed Save.
2. **Reports** objects in R2 with no database row, without deleting them. An unexplained object is
   more likely to be something a human put there than something worth destroying unattended.

### Where uploads are spooled

multer writes to `UPLOAD_TMP_DIR` (the system temp directory unless set) and the file is piped
from there to R2, then unlinked in a `finally`. Peak usage is **concurrent uploads x max file
size** — twenty staff uploading 95 MB videos at once is about 2 GB — so on a small root disk,
point `UPLOAD_TMP_DIR` at a mounted volume. The path is created if missing and checked for
writability **at startup**, so a typo or an unmounted volume stops the process at boot with a
message naming the path, rather than surfacing as a 500 on the first upload days later.

One thing worth confirming on any new host:

```bash
findmnt /tmp     # or: df -h /tmp
```

If `/tmp` is `tmpfs` it is RAM-backed, and writing uploads there silently undoes the entire reason
multer uses `diskStorage` — a 95 MB video goes straight back into memory. Ubuntu's DigitalOcean
images keep `/tmp` on the root disk, but distros differ. Set `UPLOAD_TMP_DIR` to a real disk path
if yours doesn't.

### Deploying behind a proxy

The app itself handles large uploads on a modest box — RSS growth is ~40 MB whether the file is 10
MB, 95 MB or 200 MB, because nothing is buffered. The limits that actually bite are in front of it:

| Layer | Limit | What to do |
| --- | --- | --- |
| **Cloudflare** | Proxied request body: **100 MB** Free/Pro, 200 MB Business, 500 MB Enterprise. Over it, Cloudflare returns 413 **before the app sees the request**. | Why `UPLOAD_MAX_VIDEO_MB` defaults to 95 and not 100 — multipart framing adds to the file's own size, so a 100 MB cap rejects genuine 100 MB videos. Raise it only on a DNS-only (grey-cloud) upload hostname or a larger plan. |
| **nginx** | `client_max_body_size` defaults to **1 MB** → 413 on nearly every upload. | `client_max_body_size 110m;` plus a raised `proxy_read_timeout`. The most common cause of "works locally, 413 in production". |
| **DO Load Balancer** | Idle timeout defaults to 60s. | Raise it (up to 600s) if slow clients upload large video. |
| **Node** | `server.requestTimeout` is 300s, so a 95 MB upload needs ~2.6 Mbps sustained or the request is cut off. | Fine on office broadband. Raise `server.requestTimeout` in `src/index.ts` if staff upload from mobile. |

`BODY_LIMIT` does **not** apply here — `express.json()` only parses JSON content types, so multipart
passes straight through to multer.

### Thumbnails

There are none, by design — no `sharp`, no variant objects, no variant rows. The frontend requests
a size from the same public URL using Cloudflare Images transformations:

```
https://media.example.com/cdn-cgi/image/width=400/product_images/blue-hoodie-front-<uuid>.jpg
```

Worth confirming once that the transformation zone and the R2 custom domain are the same zone
before relying on this.
