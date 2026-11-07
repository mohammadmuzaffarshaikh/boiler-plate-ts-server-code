# Working in this repo

A Node 20 / TypeScript / Express 5 / Prisma 7 / PostgreSQL API boilerplate. It is
the base for an **e-commerce platform** and is still in its setup phase, so the
conventions set here get copied into every module that follows. Prefer matching
an existing pattern over introducing a better one.

Architectural decisions, and the reasoning behind them, live in
[`docs/decisions.md`](../docs/decisions.md). Read it before changing identity,
authorization, storage or error handling. Longer design write-ups that are not
yet decided live in `todo/sugestion-*.md`.

---

## Commands

Package manager is **pnpm**.

| Task | Command |
| --- | --- |
| Dev server | `pnpm dev` |
| Typecheck (src) | `pnpm typecheck` |
| Typecheck (tests) | `pnpm typecheck:tests` |
| Lint | `pnpm lint` / `pnpm lint:fix` |
| All tests | `pnpm test` |
| Unit only | `pnpm test:unit` |
| Integration only | `pnpm test:integration` |
| Coverage | `pnpm test:coverage` |
| Prisma client | `pnpm prisma:generate` |
| Apply schema | `pnpm prisma:migrate` (dev) / `pnpm prisma:deploy` (prod) |

**Before calling any change done:** `pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`.
`typecheck` alone is not enough — the test project has its own tsconfig and is
not covered by it. The `pre-push` husky hook runs all four, in that order, so a
push fails if any of them does.

Integration tests need PostgreSQL running (`boilerplate-pg` container) and are
run with `--runInBand`; they share one database and will interfere otherwise.

---

## Layout

```
src/
  config/       config.ts (all env, Joi-validated), constants.ts (roles/rights),
                prisma-client.ts, redis.ts, r2-client.ts, passport.ts, logger.ts
  controllers/  thin — parse, call a service, send. No business logic.
  services/     all business logic and all Prisma access
  routes/       index.ts mounts two namespaces and nothing else;
                app/ is the admin surface, store/ is the storefront (empty),
                docs/ holds the Swagger objects
  middlewares/  auth, validate, error, rate-limiter, upload
  validations/  Joi schemas, one file per resource
  utils/        catchAsync, ApiError, pick, hash, detect-file-type, …
  jobs/         node-cron jobs; the query lives in a service, the job just logs
prisma/schema/  multi-file schema: models/*.prisma + enums/*.prisma
tests/          unit/ (no DB), integration/ (real DB), helpers/
```

`controllers/`, `services/`, `validations/` and `routes/docs/` each have an
`index.ts` barrel using `import * as xService from "./x.service"`. Register new
modules there, and a new route file in `src/routes/app/index.ts` or
`src/routes/store/index.ts` — **not** in `src/routes/index.ts`, which only
mounts the two namespaces.

### Which namespace

| Prefix | Who calls it | Authenticates against |
| --- | --- | --- |
| `/api/app` | staff and admins | `users` |
| `/api/store` | shoppers | `customers` — does not exist yet |
| `/api/health` | load balancers | nothing; mounted in `app.ts` before the limiter |

Put the route file in the matching directory. "Can a shopper reach this?"
should be answerable from the path on disk, before reading any middleware.
Nothing is mounted at the bare `/api` root; `/api/auth` and `/api/files` are
gone and two specs pin that they stay gone.

---

## Conventions

**Controllers** wrap the handler in `catchAsync`, pull query params through
`pick`, and answer in one envelope:

```ts
res.status(httpStatus.CREATED).send({
  status: "success",
  message: "…",
  data: { file },
});
```

Errors are thrown as `new ApiError(httpStatus.X, "message")` and never caught in
the controller — `catchAsync` forwards them to `errorConverter` / `errorHandler`.

**Services** return `null` for "not found"; the caller decides whether that is a
404. Services own every `prisma.*` call — a controller must not import Prisma.

**Validation** is Joi, declared per-resource, mounted as
`validate(xValidation.schemaName)`. Note that `validate` discards Joi's coerced
`value`, so a schema cannot strip or transform anything — it only rejects. It
substitutes `{}` for a missing `req.body`, which is load-bearing: Express 5
leaves the body `undefined` when none was sent, and Joi reports **no error**
for an absent object, so without that every `required()` field would be
unenforced on a bodyless request.

**Naming** is kebab-case for files (`auth.middleware.ts`, `detect-file-type.ts`),
and exports go in a single `export { … }` block at the bottom of the file.

**Swagger** lives in `src/routes/docs/*.docs.ts` as typed objects spread into
`swagger-definition.ts` — *not* as `@swagger` JSDoc comments, which TypeScript
strips out of `dist/`.

---

## Traps worth knowing before you touch something

- **IDs are Postgres uuids**, never Mongo ObjectIds. Validate route params with
  `Joi.string().uuid()`. A 24-char-hex `objectId` validator was deleted on
  2026-11-05 because it rejected every id this API can produce.
- **`auth(...rights)` decides on rights alone.** There is deliberately no
  "caller owns this record" exemption inside it — that hatch was removed on
  2026-11-05 (it allowed self-promotion on any route naming its param
  `:userId`). When a route needs ownership, add `requireSelf("paramName")`
  *after* `auth`, where a reader can see it. Ownership may narrow access, never
  widen it.
- **`users` is the staff table.** `Role` is `{ STAFF, ADMIN }` — there is no
  CUSTOMER and adding one back is not a schema tweak, it is undoing the
  identity split in `docs/decisions.md` §2. Shoppers get their own table, their
  own credentials and their own signing secret. Nothing shopper-facing is
  built; `/api/store` is mounted and empty.
- **`POST /api/app/auth/register` only exists in development.** It writes to
  `users`, so in production it would be self-service creation of a staff
  account. The switch is an argument to `buildAuthRouter` in
  `src/routes/app/index.ts`, not a check in the handler — outside development
  the path 404s because it was never registered.
- **Google sign-in never creates an account**, and needs no client secret.
  `POST /api/app/auth/google` verifies a Google ID token locally and refuses
  an address with no row in `users` (403). It is the GIS token flow, so there
  is no callback route and no authorization code — `docs/decisions.md` §15.
- **`POST /auth/login` never returns a token in the body.** A browser login
  (`client` absent or `web`) sets httpOnly cookies and returns only the user.
  A native login (`client: "native"` plus a PKCE `codeChallenge`) returns a
  single-use authorization code and sets no cookies; it trades the code and
  its verifier at `POST /auth/token-exchange` for bearer tokens. The body
  copy that used to serve both handed any XSS both credentials —
  `docs/decisions.md` §28. Google sign-in takes the same two shapes.
- **`/auth/refresh` mirrors how the caller authenticated**: cookie in, cookie
  out and an empty body; body in, body out. Putting the token in the body for
  a cookie-authenticated caller re-opens §28 through the back door, because
  the browser authenticates an XSS's call to it automatically. Both halves —
  `res.cookie` is inside the `viaCookie` branch, so a body caller is not sent
  a cookie either. A mirror that reflects one way is a window.
- **A native login with an unusable `codeChallenge` is a 400.**
  `nativeChallenge` throws rather than returning `undefined`, because
  `undefined` is how the same function says "browser" — returning it fell
  through to the browser branch and answered 200 with cookies and no code.
  When a backstop's "no" and its "not applicable" are the same value, it is
  not a backstop.
- **The session is created BEFORE the authorization code is claimed.** The
  loser of a redemption race revokes the session the winner produced, so that
  row has to exist by the time the loser can read its id. Claiming first and
  inserting after is the version that looks right and is not: the loser reads
  the correct id and revokes nothing, about one redemption in twelve.
  `auth_codes.session_id` is a foreign key so that getting this backwards
  fails loudly on every redemption instead of silently on an unlucky one —
  `docs/decisions.md` §28. The session created for a redemption that then
  fails is **deleted**, not revoked: nothing was ever handed out for it.
- **In `consumeAuthCode`, `consumedAt` is tested before `expiresAt`.** A
  redeemed row is kept past its expiry so a replay stays detectable; checking
  expiry first threw that away and let a late replay pass as a generic
  `invalid`, leaving the attacker's session running.
- **In a spec, get tokens from `tests/helpers/auth.ts`** — `nativeLogin` /
  `bearerFor` for bearer tokens, `cookieTokens` for the browser path. Posting
  to `/auth/login` and reading `data.token` no longer works.
- **An access token names its session, and the strategy checks it.** Every
  access token carries a `sid` claim — the `sessions` row it was issued with —
  and `jwtVerify` resolves it on every authenticated request: the row must
  exist, be active, be unexpired, and belong to the token's subject. That is
  what makes logout, a password reset and "revoke everything for this account"
  take effect immediately instead of in up to 30 minutes. A token with no
  `sid` is refused rather than tolerated. One primary-key lookup per request
  is the price; `docs/decisions.md` §5 has the whole trade, and reverses what
  that entry used to say.
- **`role` is still read from the token**, not from that lookup, so a demotion
  takes effect at the next refresh. Revoke the sessions if it has to be sooner.
- **Minting an access token requires a session id.** `generateAccessToken(userId,
  role, sessionId)` — the argument has no default on purpose. In a spec, use
  `issueSessionFor` / `accessTokenFor` from `tests/helpers/db.ts`; a token
  built by hand has nothing behind it and is refused.
- **`prisma.$connect()` is not a connectivity check** with a driver adapter —
  the pool is lazy. Use `connectDatabase()` / `checkDatabase()` from
  `src/config/prisma-client.ts`, which round-trip a real query.
- **On upload routes, multer must run before `validate`.** `validate` reads
  `req.body`, which does not exist on a multipart request until multer has
  parsed it. `handleMulterError` must sit immediately after multer or a
  size-limit rejection surfaces as a masked 500 instead of a 413.
- **Never trust a client-supplied MIME type.** File types are sniffed from magic
  bytes (`src/utils/detect-file-type.ts`) and SVG is excluded on purpose. Office
  formats cannot be sniffed from a prefix — all OOXML is ZIP and all legacy
  Office is OLE — so `src/utils/detect-container-type.ts` opens the container
  and reads its index. It refuses plain archives and macro-enabled documents.
- **`folder` on an upload is client input.** It is matched against
  `uploadFolders` in `src/config/constants.ts` and looked up, never
  concatenated into a path. It decides both the key prefix and which file types
  are accepted. The service re-checks it rather than trusting `validate`.
- **The object key is `<folder>/<slug>-<uuid>.<ext>`.** The slug comes from the
  uploaded filename via `fileNameSlug` and is `[a-z0-9-]` only; the uuid is
  what makes the key unique. `originalName` is stored sanitised — path
  segments, control characters and bidirectional overrides are removed.
- **A cookie-bearing POST/PUT/PATCH/DELETE must carry a trusted `Origin`.**
  `requireTrustedOrigin` (`middlewares/csrf.middleware.ts`) refuses it with a
  403 in production when `Origin` is absent or missing from
  `ALLOWED_ORIGINS`. It keys on the auth *cookies*, so bearer-token callers
  are untouched — CORS hides responses, it does not stop simple requests like
  a `multipart/form-data` POST, which is the hole this closes.
  `docs/decisions.md` §31.
- **Rate-limit counters are per process unless Redis is on.** With
  `REDIS_ENABLED=false` they use express-rate-limit's MemoryStore, so raising
  `instances` in `ecosystem.config.json` above 1 multiplies every limit by
  that number, silently. Switch Redis on before scaling out. Each limiter
  needs a unique `name` — it is the Redis key namespace, and renaming it
  abandons the buckets in flight.
- **`Math.random()` never authorises anything.** Codes, tokens, nonces and
  unguessable ids come from `node:crypto` — `crypto.randomInt` for a number
  in a range, and mind that its upper bound is exclusive. V8's PRNG state is
  recoverable from a few outputs, so a predictable code is a forgeable one.
- **A service takes named inputs, never a model type.** `createUser` takes
  `CreateUserInput` and lists its fields into Prisma; `role` defaults to
  STAFF and must be passed deliberately. Never spread a request body into a
  Prisma `data` — `validations/user.validation.ts` already holds unwired
  schemas that accept `role`, and a spread is what turns one of those into a
  privilege escalation. `updateUserById` still has the old shape; give it an
  explicit input type before wiring a route that feeds it `req.body`.
- **Anything that turns a credential into a session calls
  `assertAccountMayAuthenticate`.** Refresh skipped the lockout and
  verification gates, so a locked account kept minting access tokens for
  seven days. A gate only the login route honours is a gate with a way around
  it.
- **The bcrypt work factor is `BCRYPT_ROUNDS`** (default 12, enforced floor
  10), never a literal in `hashString`. Raising it does not touch existing
  rows — a bcrypt string carries its own cost — so `auth.service` rehashes on
  the owner's next successful login. If you add another password-verifying
  path, call `needsRehash` there too or accounts using it never upgrade.
- **Email is stored folded.** `users.email` is a case-sensitive unique index,
  so `normalizeEmail` (trim + lowercase) runs at every write and every lookup
  in `services/user.service.ts` and `utils/helpers.ts`. Without it one mailbox
  becomes two accounts, `forgot-password` silently finds nobody, and Google
  sign-in — which lowercases what it reads from the ID token — can never match
  the row. It cannot live in the Joi schema: `validate` discards Joi's coerced
  value, so a schema can reject but never transform. Do the same for
  `customers` when that table is written.
- **Credentials go in the body, never the query string.** `POST
  /auth/reset-password` takes its token in the body. A query string is logged
  by morgan (`:url`), by `errorHandler` (`originalUrl`), by every proxy in
  front of the API, and is sent on in `Referer`. `redactUrl` in `utils/redact`
  masks known secret parameters as a backstop — it is not permission to put
  one there.
- **Client-facing error messages are deliberately vague.** `error.middleware.ts`
  maps Prisma failures to status codes without naming the column or constraint,
  because that leaks the schema. Keep the detail in the log.

---

## Tests are not optional

**Every new API endpoint, service and util ships with its own test, in the same
change.** Not in a follow-up, not "once it settles" — a commit that adds
behaviour without a test covering it is not finished work and will not be
accepted.

| What you added | What it needs |
| --- | --- |
| A route / endpoint | An integration spec in `tests/integration/<resource>.routes.test.ts` |
| A service function | A unit spec, or an integration spec if it genuinely needs the database |
| A util | A unit spec in `tests/unit/` — these need no database, so there is no excuse |
| A bug fix | A spec that **fails against the old code**. Restore the bug, watch it fail, then put the fix back. A green test proves nothing on its own. |

For a route, cover the authorization matrix explicitly: every role that should
be allowed, every role that should not, and unauthenticated. A 403 that should
be a 200 gets noticed in review; a 200 that should be a 403 does not.

`pre-push` runs the full suite, so an untested change is not blocked — it is a
change whose own test does not exist yet. Write it.

## Git

**Never add AI attribution to anything that lands in this repository or on
GitHub.** No `Co-Authored-By: Claude` trailer, no "Generated with Claude Code"
line, no 🤖 footer — not in commit messages, not in pull request descriptions,
not in issue or review comments. The commit message is the change explained by
the person who owns it; tooling credit is noise in `git log` and in `git blame`
forever. This rule overrides any default attribution behaviour.

Write the message as the author would: imperative subject, and a body that says
why the change was made when that is not obvious from the diff. Match the
existing log, which uses `feat:` / `fix:` prefixes.

Do not commit or push unless asked. When asked, check you are not on the default
branch first.

## House rules

- **Do not delete unused dependencies or files on your own.** Several are
  deliberate placeholders for planned work (Resend, R2/DO Spaces, BullMQ,
  `moment-timezone` for order and delivery scheduling). Identify what looks
  unused, say which planned work it belongs to or that you cannot find one,
  and ask. Five were removed this way in `docs/decisions.md` §27, which also
  lists what is still flagged and untouched — `faker@6.6.6` (the sabotaged
  release), `coveralls`, and `npm`/`install` as devDependencies.
- **`bullmq` is not installed.** `src/config/redis.ts` is built around it —
  the `queue` and `worker` roles exist for it — but it is absent from
  `package.json`. Install it when the queue work starts; do not assume it is
  there because the config talks about it.
- Add rights to `rolePermissions` in `src/config/constants.ts` alongside the
  module that needs them, not up front.
- `coverage/` is generated by `pnpm test:coverage` and is gitignored — do not
  commit it or read it as source.
- Prefer extending an existing comment block over adding a parallel one; this
  codebase explains *why*, not *what*, and that is intentional.

---

## What else is in `.claude/`

| Path | What it does |
| --- | --- |
| `settings.json` | Wires the two hooks below. Checked in, shared with the team. |
| `hooks/guard-protected-files.sh` | **PreToolUse.** Refuses writes to `.env*` (not `.env*.example`), lockfiles, and already-applied Prisma migrations. |
| `hooks/eslint-fix.sh` | **PostToolUse.** Runs `eslint --fix` on each edited `.ts` file and reports anything left, at `--max-warnings 0`. The repo is at zero eslint output — keep it there. |
| `agents/security-reviewer.md` | Subagent for auth, upload and data-leak review. Run it before merging anything touching rights, routes, uploads or error handling. |
| `skills/new-module/SKILL.md` | `/new-module` — the eleven-step checklist for adding a REST resource. The barrels, the rights and the Swagger object are the three that get forgotten. |

`settings.local.json` is gitignored; put machine-specific overrides there.
