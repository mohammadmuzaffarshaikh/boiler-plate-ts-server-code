# Tests

Jest + ts-jest, split into specs that need nothing and specs that need a database.

```
tests/
  helpers/
    env.ts        environment applied before anything is imported
    samples.ts    real file bytes (JPEG/PNG/MP4/DOCX/XLS/…) embedded as base64
    r2-stub.ts    an in-memory stand-in for R2's S3 API
    google.ts     stubs googleClient.verifyIdToken, plus a payload builder
    db.ts         user fixtures, cleanup, a readable "database is down" error
  unit/           no database, no network
  integration/    needs Postgres; uses the R2 stub, never Cloudflare
```

## Running them

```bash
pnpm test              # everything, serially
pnpm test:unit         # no database needed
pnpm test:integration  # needs Postgres
pnpm test:watch
pnpm test:coverage     # text summary + coverage/lcov-report/index.html
pnpm typecheck:tests   # type-check src + tests without running anything
```

A single file or a single test:

```bash
npx jest tests/unit/detect-file-type.test.ts
npx jest -t "rename attack"
```

### Prerequisites for the integration specs

They need Postgres on the URL in `DATABASE_URL` with the schema migrated:

```bash
# first time
sudo docker run --name boilerplate-pg \
  -e POSTGRES_PASSWORD=mysecretpassword -e POSTGRES_DB=test \
  -d -p 5432:5432 -v postgres_data1:/var/lib/postgresql postgres

# afterwards
sudo docker start boilerplate-pg

pnpm prisma:migrate
```

> The volume is mounted at `/var/lib/postgresql`, **not** `/var/lib/postgresql/data`.
> The `postgres:18+` images changed the layout and refuse the old mount point.

If the database is unreachable the specs fail immediately with instructions rather than a
Prisma stack trace. `pnpm test:unit` keeps working regardless.

## How the environment is set up

`helpers/env.ts` runs in jest's `setupFiles`, which is the last moment before
`src/config/config.ts` is imported — that module reads `process.env` exactly once, at import,
so anything set later is ignored. `dotenv` does not overwrite variables that are already
present, so these win over `.env`:

| Variable | Value | Why |
| --- | --- | --- |
| `NODE_ENV` | `test` | Disables the rate limiters, whose counters are process-global and would otherwise leak between specs |
| `R2_ENABLED` | `true` | So the real upload path runs. Requests go to the local stub, never to Cloudflare |
| `UPLOAD_TMP_DIR` | a dedicated temp directory | So "no temp file was left behind" assertions cannot be confused by unrelated files |
| `UPLOAD_MAX_*_MB` | fixed | So size-limit assertions do not depend on your `.env` |

## The R2 stub

`helpers/r2-stub.ts` starts a real HTTP server implementing enough of the S3 API
(`PUT`, `DELETE`, `HEAD`, `ListObjectsV2` with prefixes and pagination). Call
`stub.install()` from `beforeEach` to point `getR2Endpoint()` at it — not from
`beforeAll`, because `restoreMocks` tears the spy down before the first test.

It verifies `Content-MD5` and answers `400 BadDigest` on a mismatch, the way R2
does. That is the one piece of R2 behaviour the integrity story rests on
(`docs/decisions.md` §7), so a stub that accepted anything would let a regression
in the signing path through. `respondNext()` returns a canned status, body and
headers for the paths the bucket cannot produce — a missing `ETag`, a weak
validator — and `hangNext()` accepts a connection and never answers it, which is
how the upload timeout is reached without waiting two minutes.

It is a server rather than a mocked module on purpose: several of the things worth asserting
only exist on the wire. That the upload sends `Content-Length` rather than chunked encoding
(the S3 API rejects chunked for a plain `PUT`); that `Content-MD5` is covered by the SigV4
signature; and that **no `x-amz-checksum-*` header is sent**, because R2 answers those with
`501 NotImplemented`. A mock would assert none of that.

The endpoint is derived from the account id as an `https://….r2.cloudflarestorage.com` host,
so no environment variable can redirect it — overriding the accessor is the narrowest seam,
and leaves signing, transport and response handling completely real.

## Fixtures

`helpers/samples.ts` embeds genuine 1×1 JPEG/PNG/GIF/WebP files as base64, plus real
container headers for MP4, MOV, AVIF, WebM and PDF, and the things that must be refused
(SVG, CSV, plain text, a bare ZIP header, empty). Embedded rather than checked in as
binaries or generated at run time, so the suite is self-contained and byte-identical
everywhere.

The raster images come from a real encoder rather than being hand-written headers —
otherwise the magic-byte detector would only be tested against a copy of its own table.

The Office samples follow the same rule as far as it goes. `docx`, `xlsx`, `pptx` and `docm`
are produced by a real ZIP writer — deflated members, a proper central directory — carrying
only the parts that identify them, because the main part name is the whole discriminator.
The three compound files (`doc`, `xls`, `oleOther`) are assembled by hand, since the standard
library has no OLE writer: a 512-byte header, one FAT sector and one directory sector. Each
format also has its counter-sample: `docm` is a valid `.docx` with a macro project beside it,
`zipArchive` is a real archive that is not a document, and `oleOther` is a compound file
naming a stream no Office format uses. All three must be refused.

## What is and is not covered

Covered: every util in `src/utils/` and every middleware; the magic-byte detector
including the rename attack and the ISO brand table; the container pass that tells `.docx`
from `.xlsx` and refuses macros; filename sanitising and key slugs; the folder allowlist;
multer's limits and error translation; temp-file cleanup on every failure path; the storage
layer's wire format, key encoding, retry bound, timeout and error mapping; the signing
contract aws4fetch is relied on for (`region=auto`, `UNSIGNED-PAYLOAD`, `Content-MD5` signed
while content-type and content-length are not); the 503 every verb gives when R2 is switched
off; the auth surface end to end; the `/api/app/files` role matrix; Google sign-in with
`verifyIdToken` stubbed; and the file lifecycle — grace window, crash recovery, concurrent
delete, orphan reporting.

Also pinned, each guarding a defect found in review:

| Spec | Guards |
| --- | --- |
| `unit/validate-middleware.test.ts` | A bodyless request is rejected. Express 5 leaves `req.body` undefined and Joi passes an absent object, so every `required()` field was unenforced and the handler 500'd on a TypeError |
| `unit/config.test.ts` | The JWT expiries boot from their defaults (`.default()` + `.required()` made them dead code); production refuses to start without `ALLOWED_ORIGINS` |
| `unit/cors.test.ts` | A refused origin answers 403, not a masked 500 |
| `unit/cron-schedule.test.ts` | Every schedule is pinned to UTC; node-cron otherwise uses the host timezone |
| `unit/redis-ping.test.ts` | The health probe gives up instead of hanging `/api/health` forever |
| `unit/upload-route-order.test.ts` | `cleanupUpload` is registered *before* multer — Express skips all non-error middleware after `next(err)`, so any later position never runs |
| `unit/error-middleware.test.ts` | An unexpected failure is logged in **production**, where the response is masked and the log is the only record |
| `integration/auth.hardening.test.ts` | Reset and refresh tokens are stored as digests; the lockout window decays and a reset lifts a lock; the email-verification gate |
| `unit/upload-folders.test.ts` | `folder` is a closed allowlist and always resolves to a prefix by lookup — the sibling api repo concatenates it and "sanitises" with a non-recursive `.replace(/\.\.\//g, "")` that `....//` walks through |
| `unit/sanitize-filename.test.ts` | A filename cannot carry a path, a CRLF into a header, or a bidirectional override into a listing; a slug cannot contain `/`, `.` or `%` |
| `unit/detect-container-type.test.ts` | Being a ZIP or a compound file is not enough: a plain archive, an installer and a macro-enabled `.docm` are all refused, as are truncated and ZIP64 containers |

Not covered, deliberately:

- **Rate limiting.** `NODE_ENV=test` disables it, because process-global counters leak
  between specs and fail whichever one happens to exhaust a bucket first. Verified by hand
  against a running server instead.
- **Google's half of Google sign-in.** `helpers/google.ts` stubs
  `googleClient.verifyIdToken`, so the signature, `iss` and `exp` checks inside
  google-auth-library are taken on trust — re-testing them would be testing the library.
  Everything this API decides *after* that point is covered: the `email_verified` assertion,
  `sub`-over-email identity, the `audience` check, refusal to create an account, the lockout,
  and the `emailVerifiedAt` stamp. What remains unproven is that a genuine Google token
  parses as expected, which needs one manual sign-in against a real client ID.
- **Cloudflare R2 itself.** The stub proves our requests are well-formed; it cannot prove R2
  accepts them. Worth one manual upload against a real bucket before going live.
- **Memory behaviour of large uploads.** Asserting RSS is too flaky for CI. The streaming
  claim is documented in the main README with the measurements behind it.

## Conventions

- Each spec creates its own rows with unique identifiers and removes them in `afterAll`.
  Nothing truncates a shared table, so a run will not wipe your development data and two
  spec files cannot destroy each other's fixtures.
- Email fixtures use `@example.com`. Joi's `.email()` checks the TLD against the IANA list,
  so `@test.invalid` and friends are rejected before reaching any handler.
- Integration specs run with `--runInBand`. They share one database, and running the files in
  parallel makes them race.
- `restoreMocks` is on, so a `jest.spyOn` is undone between tests. Specs that need the R2
  endpoint override call `stub.install()` in `beforeEach`.
