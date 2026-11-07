# Decision record

Why this codebase is the way it is. One entry per decision that would otherwise
be re-litigated, or re-made differently, by whoever touches the code next.

Each entry says what was decided, what it rules out, and **what it costs** —
an entry with no cost listed is usually an entry that has not been thought
through. Longer, still-undecided design write-ups live in `todo/sugestion-*.md`.

Status vocabulary:

| Status | Meaning |
| --- | --- |
| **Implemented** | Decided and in the code today. |
| **Partly implemented** | Half of it is in the code; the entry says which half. |
| **Decided, not built** | Agreed; no code yet. Build it this way. |
| **Open** | Not decided. Do not pick one by instinct — raise it. |
| **Open — researched, not built** | Options compared and a leaning recorded, but not chosen. The leaning is not permission. |

Last reviewed: 2026-11-06.

---

## 1. PostgreSQL + Prisma 7 with the `pg` driver adapter

**Implemented** · 2026-11-04 · `src/config/prisma-client.ts`

Prisma 7 with `@prisma/adapter-pg` rather than Prisma's own connection handling,
and a multi-file schema under `prisma/schema/` (`models/`, `enums/`) rather than
one `schema.prisma`.

The adapter is what makes the pool configurable, and three of those settings are
load-bearing: `connectionTimeoutMillis` (node-pg's default is *wait forever*, so
against a dead-but-not-refusing host every request hangs until the process falls
over), `statement_timeout`, and `application_name` (the only practical way to
identify this process in `pg_stat_activity` on a shared instance).

**Cost / consequence:** `prisma.$connect()` stops being a connectivity check —
the pool is lazy, so it resolves happily against a port with nothing listening
and the *first real query* is what fails. A server that trusts it logs
"Connected", accepts traffic, and 500s everything. `connectDatabase()` and
`checkDatabase()` round-trip a real `SELECT 1` instead. Never reintroduce a
bare `$connect()` as a health signal.

---

## 2. Identity is split in two: `User` (staff) and `Customer` (storefront)

**Partly implemented** · 2026-11-05 · design in `todo/sugestion-3.md`

The `users` side is built: the table is staff-only, `Role` is `{ STAFF, ADMIN }`
and the admin API sits under its own namespace. The `customers` side is not
written yet — see §13 for the part that has to be designed before it can be.

Staff and admins live in `users`; shoppers live in a separate `customers` table.
A staff member who also shops has a row in each, with **no foreign key between
them**. The administration app authenticates against `users`; the storefront
authenticates against `customers`.

This came out of one requirement: a deactivated staff member must still be able
to buy things. That is only coherent if "deactivated" is a fact about an
employee, not about a shopper — two independent lifecycles, so two tables.
Shopify, Magento (`admin_user` / `customer_entity`) and Medusa all split the
same way; WooCommerce and Saleor do not, and inherit exactly this problem.

Consequences that follow and are **not** optional:

- `Role` loses `CUSTOMER` and becomes `{ STAFF, ADMIN }`. Every row in `users`
  is staff. **Done** — migration `20261105120000_staff_only_role`. The enum
  value was dropped rather than left unused on purpose: an unused value is an
  invitation to put a shopper back in the staff table, and `Record<Role, …>`
  in `src/config/constants.ts` would have gone on compiling if someone did.
- `UserStatus { INVITED, ACTIVE, DEACTIVATED }` applies to `users` only.
  Customers have their own, separate states.
- Two sets of credentials, deliberately unlinked. Linking them re-creates the
  single account the split exists to avoid.
- **Separate JWT secrets** per principal. A structural control: a storefront
  token cannot be replayed against the admin API even if a claim check is
  forgotten. A `principal` claim alone is a code control, and code controls get
  skipped on the route somebody adds in a hurry.
- `Session` and `Token` become two tables each, for the same reason. The
  shape of that is **§13**, which is still open.
- Routes namespace as `/api/app/...` and `/api/store/...`. **Done** — §12.
  (An earlier draft of this entry said `/api/admin`; the prefix chosen was
  `/api/app`.)

**Cost:** more tables, two auth paths to maintain, and a person who is both
employee and shopper has two passwords. That is the price of the requirement.

**Open sub-questions (do not guess):**

1. Rename `User` → `Staff` / `AdminUser`? Twelve files import the type today.
2. Does inviting a staff member auto-create a `Customer` row? Leaning **no** —
   it conflates the two lifecycles again.

---

## 3. Registration creates customers only; staff arrive by invitation

**Decided, not built** · 2026-11-05 · design in `todo/sugestion-3.md`

Staff and admin accounts are created through an invite flow by someone who
already holds the right. Customer registration is a storefront endpoint under
`/api/store`, against the `customers` table, and does not exist yet.

**Where that leaves `POST /api/app/auth/register` today:** it writes to
`users`, so it now mints a STAFF account. That is the hole this entry exists to
close, and until the invite flow is built the route is mounted only when
`NODE_ENV=development` — see §14. It is the local way to get a first account
without running the seed, and it is absent in every other environment.

When customer registration is written, enforce "customer only" **in the
service, not in the Joi schema**. A schema that forbids a `role` field is one
`allowUnknown` change away from being a privilege escalation; a service that
never reads a client-supplied role cannot be.

An invite also doubles as proof of the mailbox: the invitee only ever arrives by
clicking a link sent to that address, so a separate email-verification
round-trip for staff is redundant.

**Related, still unresolved:** an `INVITED` user is a row with no password, and
`bcryptjs.compare(text, null)` **throws** (`Illegal arguments: string, object`)
rather than returning false — verified empirically. That turns a login attempt
against an invited account into a 500 where every other wrong login is a 401,
which is a usable account-enumeration oracle. Whichever way the row is created,
the login path must check for a null password *before* reaching bcrypt.

---

## 4. Authorization is rights-only; ownership is opt-in and explicit

**Implemented** · 2026-11-05 · `src/middlewares/auth.middleware.ts`

`auth(...requiredRights)` grants on rights and nothing else. Ownership, when a
route needs it, is a separate `requireSelf("param")` mounted after it.

This replaced an implicit escape hatch inside `auth`:

```ts
if (!hasRights && req.params.userId !== user.id) { reject(403) }
```

— which skipped the rights check entirely whenever a route happened to name its
parameter `userId` and the value happened to equal the caller's own id. It was
harmless on the routes that existed, and would have stopped being harmless the
moment `PATCH /staff/:userId/role` was wired up: self-promotion to ADMIN, and
self-reactivation after dismissal. `validations/user.validation.ts` already
carried those schemas, keyed on `:userId`, waiting for routes.

The general rule, and the reason this is a decision rather than a bugfix: **a
rule that grants privilege based on a parameter name is invisible at the route
definition**, which is the one place a reader looks to find out who may call
something. Ownership may narrow access. It may never widen it.

Pinned by `tests/integration/auth-middleware.test.ts` (a unit spec until §5
made authentication touch the database); three of its specs were
confirmed to fail against the old line before the fix was kept.

---

## 5. Access tokens are bound to a session row, and the strategy resolves it

**Implemented** · 2026-11-06 · `src/config/passport.ts`,
`src/services/token.service.ts`, `src/services/session.service.ts`

**This reverses the original decision, which was that the JWT strategy never
reads the database.** That version built `req.user` from the signed payload
alone and accepted, as a recorded limitation, that nothing about an account
took effect until the access token expired.

The limitation turned out to be worse than the entry claimed. It did not only
affect features that had not been built — it silently voided one that had:

- `POST /api/app/auth/logout` returned 200, flipped `sessions.is_active`, and
  the same bearer token went on working on `/auth/self` and `/api/app/files`
  for the rest of its 30 minutes. Confirmed against a running instance.
- `revokeAllForUser`, called after a password reset, did nothing to the tokens
  already in somebody else's hands — which is the one moment it exists for.
- Deleting a user left their token fully valid.

An endpoint that reports success while doing nothing is worse than an absent
one, because the operator stops looking.

**What it is now.** `generateAccessToken` writes the session's id into the
token as a `sid` claim, and `jwtVerify` resolves it on every authenticated
request: the row must exist, be `isActive`, be unexpired, and belong to the
token's subject. Anything else is 401, and all four failure modes fail closed.

Three details that are deliberate:

- **The session row is written before the access token is minted**
  (`issueAuthSession`). The other order hands out a token naming a row that
  does not exist yet.
- **A token with no `sid` is refused**, not waved through. "Unbound" and
  "unrevocable" are the same thing, and a compatibility branch for old tokens
  would be a permanent bypass. Tokens issued before this change stop working
  at deploy — they were the problem.
- **Refresh reuses the same `sid`.** Minting a new one would strand the old
  row, so "log out everywhere" would miss the session actually in use.

**Cost:** one primary-key lookup per authenticated request. That is the price,
and it is paid on every route. Caching it in Redis was considered and rejected
for now: Redis is explicitly allowed to be down (§ the `initRedis` comment),
so it cannot be the authority on whether a token is still good, and a cache
that fails open is not a revocation mechanism. If the query ever shows up in a
profile, the shape to reach for is a short-TTL *negative* cache of revoked
session ids, which fails closed when Redis is unavailable.

**What this still does NOT fix:** `role` is read from the token, not from the
lookup. A demotion therefore takes effect at the next refresh, not instantly.
Narrowing that means fetching the user too, which doubles the per-request cost
for a much rarer event — and the sessions of someone being demoted can be
revoked today, which is the blunt instrument that works now. Anything needing
an instant role change must still say so and do its own lookup.

**Pinned by** `tests/integration/auth.revocation.test.ts`, every spec of which
was confirmed to fail against the previous strategy.

### Knock-on: `tests/unit/auth-middleware.test.ts` moved to `tests/integration/`

That spec's rights matrix was a unit test precisely because authentication
touched nothing. It now needs real users and real sessions, so it lives in
`tests/integration/auth-middleware.test.ts`. The subject has not changed; the
session is setup.

### Knock-on: a strategy error is no longer a 401

`verifyCallback` collapsed `err`, `info` and `!user` into one "Please
authenticate." That was free when the strategy could not throw. It can now, so
a Postgres outage would have answered every request with a client-looking 401
and nothing in the log. `err` is forwarded intact and becomes a logged 500.

---

## 6. Every id is a Postgres uuid

**Implemented** · 2026-11-05 · `src/validations/`

Route params are validated with `Joi.string().uuid()`, which accepts v4 (what
Prisma's `@default(uuid())` generates) and v7.

A shared `objectId` custom validator — a 24-character hexadecimal Mongo matcher
carried over from a Mongoose codebase — was deleted. It would have rejected
every id this API can produce. Worse, two of its five call sites were written
`Joi.required().custom(objectId)`, which is `Joi.any().required()`: the base
schema checked no type at all, so the Mongo matcher was the only thing looking.

If you are porting code from the sibling Mongo project, this is the class of
thing to look for.

---

## 7. Object storage is Cloudflare R2, accessed with `aws4fetch`

**Implemented** · 2026-11-05 · `src/config/r2-client.ts`, `src/services/storage.service.ts`

R2 over S3 + CloudFront on egress cost: R2 egress is free, CloudFront is $0.085/GB
past its 1 TB free tier. At 3 TB/month that is $185 → $8, and product video is
what pushes past the free tier, so the gap widens rather than closes.

`aws4fetch` over the AWS SDK for two reasons. It is what Cloudflare documents for
R2, it is zero-dependency and 88 KB against the SDK's bulk — and, decisively, the
AWS SDK from 3.729 onward sends `x-amz-checksum-crc32` by default, which R2
answers with `501 NotImplemented` (`aws/aws-sdk-js-v3#6810`, still open) — and
every current SDK release is past that point. aws4fetch has no checksum
middleware to misbehave. `@aws-sdk/*` is no longer a dependency of this repo. Integrity instead comes from `Content-MD5`, which R2 *does* implement.

A storage backend swap should only ever touch `storage.service.ts`.

**Still outstanding:** one manual upload against a real R2 bucket before go-live,
and a check that the Cloudflare Images transform zone and the R2 custom domain
are the same zone.

---

## 8. Uploads are proxied through the API, typed by magic bytes, spooled to disk

**Implemented** · 2026-11-05 · `src/middlewares/upload.middleware.ts`, `src/services/file.service.ts`

Multer receives the file and the API forwards it to R2 — not a presigned direct
upload. Three things about how are deliberate:

- **`diskStorage`, not `memoryStorage`.** A 100 MB video must never sit in the
  heap; `memoryStorage` costs 100 MB of RAM per concurrent upload. The temp file
  is unlinked in a `finally`, including on the R2 failure path.
- **The type is sniffed from the first bytes** (`src/utils/detect-file-type.ts`,
  a ~60-line closed allowlist) and the stored `Content-Type` is the sniffed
  value, never the client's. `fileFilter` and the file extension are a cheap
  pre-screen only. This is what defeats `payload.svg` renamed to `photo.jpg`.
- **SVG is excluded from the allowlist.** An SVG is a script container; served
  from a domain you control it is stored XSS. Same reasoning excludes Office
  formats. PDF is detectable but gated by upload category, so it cannot reach a
  product-media route today.

Size caps are enforced **after** sniffing, per category — a 90 MB file named
`photo.jpg` has to be measured against the image cap it really is, not the video
cap it claims. Multer's own `limits.fileSize` is only the outer absurdity guard.

Object keys are `products/<uuid>.<ext>`. **No client-controlled path component
anywhere**, which makes path traversal unexpressible rather than filtered.

---

## 9. File lifecycle: a status column and a grace-period sweep

**Implemented** · 2026-11-05 · `src/jobs/file-cleanup.job.ts`

`FileStatus { UNUSED, IN_USE, PENDING_DELETE }`. An upload lands `UNUSED`;
attaching it to a product marks it `IN_USE`; a cron deletes `UNUSED` rows older
than `FILE_UNUSED_GRACE_HOURS`. There is no FK to `Product` because no `Product`
model exists yet — `status` stands in until it does.

Two details that are the whole point:

- **The grace period is not optional.** Sweeping `UNUSED` with no age check
  races an upload that has not been attached to a product yet, and deletes it.
- **Delete order is `PENDING_DELETE` → delete object → delete row.** A crash
  then leaves a row the cron retries, rather than a live row pointing at an
  object that is gone. `deleteObject` is idempotent, so the retry is safe.

The orphan sweep (objects in R2 with no row) **logs and does not delete**,
deliberately, until it has been watched for a while.

`onDelete: SetNull` on `uploadedBy`: removing a staff account must not delete the
product photography they uploaded.

**Deletion is role-gated, not owner-gated** — any STAFF or ADMIN may delete any
file. Product media is shared catalogue content, not personal property. This is
a requirement, not an oversight.

---

## 10. Database failures are mapped to HTTP, and the detail stays in the log

**Implemented** · `src/middlewares/error.middleware.ts`

Prisma errors carry no `statusCode`, so without a mapping every one of them is
an identical, unexplained 500 — a unique constraint lost to a race reads the
same as a crash, and an unreachable database reads the same as a bug in our
code. P2002 → 409, P2003 → 400, P2025 → 404, connection failures → 503 (an
unreachable database is not a bug in the request and should not count against
the 5xx budget), everything unmapped → a non-operational 500.

Client-facing messages are **deliberately vague about which column or constraint
was involved** — naming it leaks the schema to anyone who can trigger a
conflict. Prisma's own message is a multi-line code frame quoting our source;
it goes to the log and never to the client.

A library 4xx (body-parser's 413, a malformed-JSON 400) is marked operational so
its status and message survive, rather than being masked to a generic 500.

---

## 11. Testing: unit tests run anywhere, integration tests use a real database

**Implemented** · `tests/`, `jest.config.ts`

`tests/unit/` needs neither database nor network — middleware, the type sniffer,
the storage service against a local stub. `tests/integration/` runs against a
real PostgreSQL (`boilerplate-pg`) with `--runInBand`, because the suites share
one database.

No mock of Prisma, and no mock of R2 beyond a local HTTP stub. A mocked database
mostly asserts that the mock was called.

When fixing a bug, **restore the bug and confirm the new test fails** before
keeping it. A green test proves nothing about whether it would have caught the
thing it was written for.

**A test is part of the change, not a follow-up** (decided 2026-11-05). Every
new endpoint, service function and util ships with its own spec in the same
commit; a commit that adds behaviour without one is not accepted. Route specs
must cover the whole authorization matrix — each role allowed, each role
refused, and unauthenticated — because a 200 that should have been a 403 is the
failure review is worst at catching.

The `pre-push` hook enforces the floor: `typecheck` → `typecheck:tests` → `lint`
→ `test`, cheapest first, and the push aborts on the first failure.

**Cost:** a push now needs PostgreSQL running and migrated, because the gate
includes the integration suite. That is deliberate — a gate that silently skips
the specs needing a database would pass in exactly the situation where it
matters. The suite says what to start if it is down. `git push --no-verify`
exists for the case where you know why.

`coverage/` is generated output, gitignored, safe to delete.

---

## 12. The API has two namespaces: `/api/app` and `/api/store`

**Implemented** · 2026-11-05 · `src/routes/index.ts`, `src/routes/app/`,
`src/routes/store/`

Every endpoint lives under one of two prefixes, and which one it is under is a
statement about who may call it:

| Prefix | Principal | Authenticates against |
| --- | --- | --- |
| `/api/app` | staff and admins | `users` |
| `/api/store` | shoppers | `customers` (does not exist yet) |

`/api/health` stays outside both, mounted in `src/app.ts` ahead of the global
rate limiter so a load balancer cannot be throttled out of its own health
check. Nothing is mounted at the bare `/api` root any more.

The old paths were `/api/auth` and `/api/files` — unprefixed, and therefore
silent about their audience. That is fine while there is one audience and
becomes a trap the moment there are two: the storefront's login would have
been `/api/auth/login` as well, and the only thing distinguishing the two
would have been which handler happened to be mounted first.

The prefix is also where the separation is *enforceable* rather than merely
described. Directory layout mirrors it — `src/routes/app/*` and
`src/routes/store/*` — so "can a shopper reach this?" is answered by which
folder the file is in, before reading a line of middleware. `/api/store` is
mounted and empty today; the first customer-facing endpoint is a new file in
that directory rather than a fresh argument about where it belongs.

**What this does not do:** a prefix is a routing fact, not a security control.
Nothing stops a future `/api/store/...` route from calling `auth("read:users")`
and authenticating a shopper against the staff table. The control that makes
that impossible is the separate signing secret in §13, which is not built.

**Cost:** every client URL changed, and the Swagger paths with them. Two specs
(`tests/integration/auth.routes.test.ts`) pin that the old unprefixed paths now
404, because a path that quietly keeps working is how two namespaces drift back
into one.

---

## 13. Sessions and tokens are per principal, never shared

**Open — researched, not built** · 2026-11-05 · `prisma/schema/models/session.prisma`,
`token.prisma`

`Session` and `Token` both carry `userId → users.id` today. Customers will need
both. The question is whether they get their own rows in those tables or their
own tables, and it has to be answered before the `customers` table is written,
because the answer decides the shape of three migrations and of
`session.service.ts`.

### The three ways to hold both

| | Shape | Referential integrity | Expressible in Prisma 7 |
| --- | --- | --- | --- |
| **A. Two tables each** | `sessions` + `customer_sessions`, `tokens` + `customer_tokens` | Full, per side | Yes, today |
| **B. One table, two FKs** | nullable `user_id` *and* `customer_id`, plus a `principal` column | Full, but "exactly one is set" is not enforceable in the schema language | Partly |
| **C. One table, polymorphic** | `principal_type` + `principal_id`, no FK | None | No |

**C is not available.** Prisma has no polymorphic relations; the long-standing
request ([prisma/prisma#1644](https://github.com/prisma/prisma/issues/1644), 373
upvotes) is listed as resolved in [Prisma ORM 8](https://www.prisma.io/blog/prisma-orm-8-closes-330-most-requested-issues),
checked against `8.0.0-rc.16` (7 Oct 2026). This repo pins Prisma 7, so taking C
now means hand-written SQL, no `onDelete: Cascade`, and nothing preventing a
session row that points at a customer who no longer exists.

**B leaks its invariant.** Prisma's schema language has no `CHECK`, so "exactly
one of `user_id` / `customer_id` is non-null" has to live in a hand-edited
migration, invisible to the generated client. Every read then has to defend
against a row with both set or neither — a state the type system says is
possible and the database says is not.

### Leaning: A, two tables each

Beyond "it is the only one that type-checks", three reasons that are about
security rather than tooling:

1. **The refresh token *is* the session.** One shared `refresh_token @unique`
   index means a stolen storefront refresh token is looked up in the same index
   the admin refresh path queries. Resolving it correctly then depends on also
   checking the discriminator — a code control, and code controls get skipped on
   the route somebody adds in a hurry. With two tables the admin path queries
   `sessions`, does not find a customer row, and the mistake is unrepresentable.
2. **Cascade semantics genuinely differ.** Deleting a staff account must not
   touch that human's shopping sessions, and vice versa. Free with two tables;
   a trigger-shaped problem with one.
3. It is what the identity split in §2 already committed to, and it is the
   shape the ecosystem uses — next-auth's admin-split adapter defines
   `AdminUser`/`AdminSession` beside `User`/`Session` rather than discriminating
   one table. Medusa v2 likewise separates the two surfaces outright, with
   `/admin/*` and `/store/*` routes and per-actor auth.

**Cost:** two near-identical tables, and every column added to one has to be
added to the other or they drift. `session.service.ts` becomes either two
modules or one generic over a Prisma delegate, and the generic version is worse
to read than the duplication it saves. "Every session belonging to this human,
across both apps" becomes a `UNION` — acceptable, because only support tooling
that does not exist yet asks that question.

### What else has to be per-principal, and is easy to miss

- **The signing secret.** §2 already requires one secret per principal. It is
  the control that makes a storefront token structurally useless against
  `/api/app`, rather than merely unprivileged. Config gains a second secret and
  `src/config/passport.ts` gains a second strategy; `auth()` then has to name
  which strategy it wants, and the default must be the admin one, because a
  route that forgets should fail closed on the storefront side.
- **Cookie names.** `COOKIE_NAMES.access` is `access` today. If both apps are
  served from one host, the storefront's cookie and the admin app's cookie have
  the same name and overwrite each other — logging into the store logs you out
  of the admin panel, intermittently and inexplicably. Distinct names
  (`app_access` / `store_access`), not `Path` scoping: path is not a security
  boundary for cookies and the failure mode is just as confusing.
- **The session-cleanup cron** has to sweep both tables, or the one nobody
  remembers grows forever.
- **`TokenTypes`** (`RESET_PASSWORD`, `VERIFY_EMAIL`) applies to both sides and
  can stay one enum; it describes the purpose of a token, not its owner.

### Why this cannot be deferred past the `customers` table

§5 — `role` is still read from the token rather than from the session lookup —
means a token stays valid, with whatever role it was signed with, until it
expires or its session is revoked. That already bit once: dropping
`CUSTOMER` from `Role` left signed tokens carrying a role the server could no
longer resolve. They fail closed on any route that requires a right
(`Role rights for CUSTOMER are undefined.`, pinned in
`tests/integration/auth-middleware.test.ts`), but a route calling bare `auth()` never
looks the role up and lets them straight through. A shared secret across two
principals turns that same gap into a cross-surface one.

**Open sub-questions (do not guess):**

1. Do customers get refresh-token sessions at all, or short-lived access tokens
   with silent re-auth? Cart persistence usually argues for long sessions.
2. Does a cart exist before a `Customer` row does? A guest cart needs an
   identifier that is not a customer id, which may mean a session row with no
   principal at all — the one case that argues for B.
3. Does the customer side reuse `tokens` for verification and reset, or
   one-time codes?

---

## 14. Self-service registration exists only in development

**Implemented** · 2026-11-05 · `src/routes/app/index.ts`,
`src/routes/app/auth.routes.ts`

`POST /api/app/auth/register` is mounted only when `NODE_ENV=development`.

`register` writes a row to `users`, and after §2 every row in `users` is staff.
Leaving it reachable in production is self-service creation of a staff account
by anyone who can reach the API — the exact hole the invitation flow in §3
exists to close. Deleting the route outright would leave no way to get a first
account locally except the seed, which is a worse day-to-day experience for no
security gain in an environment that has no real data.

Two details that are deliberate:

- **It is a mount-time decision, not a check inside the handler.** Outside
  development the path does not exist and answers 404. A handler returning 403
  would confirm to a prober that the endpoint is there.
- **The switch is an argument to `buildAuthRouter`, not a `config.ENV` read
  inside the route file.** The policy is then visible at the mount site, where
  a reader goes to find out what is exposed — and the specs can exercise the
  endpoint itself rather than only being able to prove it is absent. Both the
  endpoint and the gate are covered in
  `tests/integration/auth.routes.test.ts`.

**Cost:** one production-only code path that local development never executes,
which is the shape of bug that reaches production unnoticed. It is bounded
here: the only difference is whether one `router.post` call runs, and a spec
asserts the route 404s under the test environment.

**Updated 2026-11-07.** This left production with no way to create *any*
account, since the seed also refused to run there. The seed now bootstraps the
first ADMIN from the environment — see §29. The invitation flow in §3 is still
the intended way to create every account after that one.

---

## 15. Google sign-in is an ID-token login, and only for staff who already exist

**Implemented** · 2026-11-05 · `src/config/google-client.ts`,
`src/services/auth.service.ts`, `POST /api/app/auth/google`

Google Identity Services' **ID-token** flow, not the OAuth authorization-code
flow. The browser obtains a signed assertion of identity from Google and posts
it to the API, which verifies the signature locally. There is no redirect, no
callback route and no client secret.

### The endpoint the frontend calls

| | |
| --- | --- |
| **Endpoint** | `POST /api/app/auth/google` |
| **Body** | `{ "idToken": "<the `credential` string from GIS>" }` |
| **Success** | `200`, the same envelope as password login: `data.user`, `data.token`, `data.refreshToken`, plus httpOnly access and refresh cookies |
| **Server config** | `GOOGLE_CLIENT_ID` only. Absent or empty → the endpoint answers `501` and the feature is off |

```js
google.accounts.id.initialize({
  client_id: GOOGLE_CLIENT_ID,          // public by design; it is the `aud` claim
  callback: ({ credential }) =>
    fetch("/api/app/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",           // the API also sets httpOnly cookies
      body: JSON.stringify({ idToken: credential }),
    }),
});
```

`validate` rejects unknown body keys, so `idToken` is the only field the
endpoint accepts. Nothing about the account — not the email, not the role —
is taken from the request.

In the Google Cloud console, for the OAuth web client:

- **`javascript_origins` must list every frontend origin** (`http://localhost:5173`
  in development, the real origin in production). This is the field that
  matters.
- **`redirect_uris` are unused — leave them empty.** They belong to the code
  flow. There is no `/callback` route in this API and the browser never
  navigates to it. A redirect URI configured here is a misleading no-op.
- **The client secret is unused.** `new OAuth2Client()` is constructed with no
  credentials; `verifyIdToken` is a local signature check against Google's
  cached JWKS. A `GOOGLE_CLIENT_SECRET` in `.env` buys nothing and is a
  credential to leak.

### Why the token flow rather than the code flow

The code flow exists to obtain **refresh tokens and offline access to Google
APIs on the user's behalf**. We want neither. We want one thing — an assertion
that this browser controls this Google account — and the ID token is exactly
that, with no state parameter, no callback route, no pre-login session, and no
secret to store or rotate.

**Cost:** the login is browser-only. A native app or a server-to-server client
cannot use this endpoint, and adding one later means adding the code flow
*alongside* this, not replacing it. Also one more script on the login page
(`accounts.google.com/gsi/client`), which is a third-party dependency on the
critical path of signing in.

### Rules that follow, each pinned by a test

1. **It never creates an account.** `resolveGoogleUser` answers `403` for an
   unknown address rather than inserting. With registration mounted only in
   development (§14), an endpoint here that created rows would be the one way
   left to mint a STAFF account in production, from nothing but a Google
   account. `tests/integration/auth.google.test.ts` asserts no row appears.
2. **`email_verified` is asserted here, because `verifyIdToken` does not check
   it.** An unverified address is one anybody can claim, and the first-link
   path below matches on email.
3. **`sub` is the identity; email is only how the first link is found.** A
   Google account's address can change and be reassigned, its `sub` cannot.
   Once `googleId` is stored, lookups go through it.
4. **`audience` is always our client ID.** Without it a token minted for a
   different Google application verifies here — the signature is Google's
   either way.
5. **The account lockout applies.** A lockout earned by password guessing
   cannot be sidestepped by switching to Google.
6. **A successful login stamps `emailVerifiedAt`, and never moves an existing
   stamp.** Reaching the success path *is* the proof; re-stamping would turn
   the column into "last verified login".
7. **The client-facing error never carries Google's reason.** Expired, forged
   and wrong-audience all answer the same `401 Invalid Google credential`; the
   real reason is logged.

### What this costs, and the risk to keep in view

Linking by email on first sign-in is the takeover surface: whoever can prove a
staff member's address to Google inherits that account. The control standing
in front of it is Google's own `email_verified`, which is solid for a Workspace
domain you administer and thin for arbitrary consumer Gmail. If staff addresses
are not on a domain you control, the mitigation is to require linking to be
initiated from an already-authenticated session rather than performed at login
— **not built**, and worth revisiting before go-live.

**Open (do not guess):**

1. **Google sign-in for customers.** The storefront is a different principal
   with a different signing secret (§13). Same Google OAuth client or a second
   one? A shared client means one `aud` for both surfaces, so the ID token
   itself cannot say which app it was for — the separation would rest entirely
   on which endpoint received it.
2. **Unlinking.** There is no way to clear `googleId` today, so an account
   linked by mistake stays linked.

---

## 16. Transactional email is Resend, and the SDK's result is converted to a throw

**Implemented** · 2026-11-06 · `src/config/resend-client.ts`,
`src/services/email.service.ts`, `src/utils/render-template.ts`

Mail goes out through Resend rather than SES + nodemailer, which is what the
sibling api repo uses. That stack assembles the MIME message locally with
nodemailer's `streamTransport` and hands the raw bytes to `SendRawEmailCommand`.
It works, but it puts MIME assembly — encodings, boundaries, inline-image
content ids — inside this codebase for no benefit, and it needs an IAM
principal with `ses:SendRawEmail`. Resend takes `{ html, text, attachments }`
as JSON and builds the message itself.

**The part that is not a preference.** The Resend SDK does *not* throw on an
API error: `emails.send()` resolves to a discriminated `{ data, error }`, and
Resend's own documentation says not to wrap it in `try/catch`. Written the
obvious way, a `try` block around a send catches a DNS failure and sails
straight past a 403 for an unverified sending domain — the call "succeeds" and
the caller records a message that was never accepted. `email.service` is
therefore the only module permitted to call `send`, and converting that result
into a thrown `EmailSendError` is the reason it exists.

`EmailSendError` carries `retryable`, because the queue work in
`todo/sugestion-2.md` needs it and the classification is not obvious from the
status code alone. A rate limit or a 5xx is worth another attempt; an
unverified domain, a revoked key or a malformed payload is not, and retrying
those five times buries the real error under four identical copies of itself.
Quota exhaustion is the case that looks wrong and is not: `daily_quota_exceeded`
returns 429, but a daily quota resets at midnight UTC, so a retry inside a job's
window is only a slower failure.

Rendering is separate again, in `utils/render-template`, and is deliberately
not the api repo's three-line `compileTemplate`. That function returns `""`
when compilation fails, so a broken template sends a blank email and logs a
line nobody reads — and because Handlebars does not throw for a missing
variable by default, the most common mistake never reaches its `catch` at all.
Here the variables a template *prints* are read out of its parsed AST and
checked against the context before anything renders. Printing and testing are
distinguished: `{{orderNumber}}` must exist, `{{#if trackingUrl}}` need not,
and `{{#each items}}` must — Handlebars silently renders nothing for an absent
loop subject, which is the same silent blank in a different costume.

**Two traps that are easy to reintroduce.**

`EmailSendError` names its provider status `providerStatusCode`, not
`statusCode`. `errorConverter` duck-types on `err.statusCode`: anything
carrying one has that number used as the HTTP status, and a 4xx is marked
operational, so its message is *not* masked in production. Called
`statusCode`, a Resend 403 reached the caller as an HTTP 403 reading "The
acme.com domain is not verified" — our infrastructure described to a
customer, with a status inviting them to fix it. Resend's status describes
our relationship with Resend; to a caller every one of them is a 500.

Every send passes an `AbortSignal`. The Resend SDK sets no timeout — it calls
`fetch`, and Node's default is effectively "wait as long as the socket stays
open", the same trap as node-pg's unlimited `connectionTimeoutMillis` in §1.
Without it, a provider that accepts a connection and then goes quiet holds an
HTTP request, or a BullMQ job and its worker slot, indefinitely: BullMQ's
stalled-job check does not help, because a worker blocked in `await fetch` is
still renewing its lock.

**Cost / consequence:**

- A second provider account to hold, verify a domain in, and pay.
  `EMAIL_ENABLED=false` keeps the app booting without one, the same way
  `R2_ENABLED` does, and sends answer 503.
- `nodemailer` was kept as a placeholder for a future SMTP fallback and has
  since been removed (§27) — it was carrying advisories for a fallback nobody
  had designed. If SMTP is ever wanted, add it back then, against a decision
  that says why SMTP rather than a second API provider.
- Handlebars' own `strict: true` is *not* used, because it throws on a tested
  variable as readily as on a printed one and so makes `{{#if optional}}`
  impossible. The cost is that this repo now owns an AST walk — about 90 lines
  — that has to keep up with Handlebars' grammar. Partials are not handled;
  they are not registered anywhere, and resolving their variables needs the
  partial's own source.
- There is no retry inside `sendEmail`. One attempt, then it throws. Retrying
  is the queue's job (`todo/sugestion-2.md`), which is also the only layer that
  can space attempts out across minutes — but until sending moves onto a queue,
  a caller on the HTTP path gets exactly one try.
- Composed header values (subject, display name) have control characters
  stripped; addresses with control characters are *rejected* instead. An
  address with a newline is not an address needing tidying, and quietly
  turning it into a different address is the worse of the two outcomes.
- Recipient addresses are redacted in the log (`redactEmail`, beside the
  existing URL-password redaction): a log line is the one place a customer's
  address reliably outlives the request. The provider id is logged in full, so
  a support question is still answerable from Resend's dashboard.
- There is no "divert every recipient to one mailbox" rail. A developer
  running against a restored database dump can therefore mail real customers,
  and the only thing standing in the way is `EMAIL_ENABLED=false` being the
  default. Considered and left out on 2026-11-06 as unnecessary for now.

---

## 17. Deliberately deferred

Not oversights. Each is a decision to not build something yet.

| Deferred | Where it is written up |
| --- | --- |
| Email verification — transport and rendering exist (§16); nothing sends the mail | `todo/sugestion-1.md` |
| BullMQ queues for email / WhatsApp, Redis-backed rate limiting | `todo/sugestion-2.md` |
| Where notification templates are stored, for email and WhatsApp | `todo/sugestion-5.md` |
| Staff invite flow, `Customer` table, account status | `todo/sugestion-3.md` |
| Shopper-submitted review media and return documents | `todo/sugestion-4.md` |
| Customer sessions and tokens — which table shape | §13, open |
| Everything under `/api/store` — the namespace is mounted and empty | §12 |
| Google sign-in for *customers* on `/api/store` | §15, open. Staff sign-in is built. |
| Multipart upload (unnecessary at ≤ 100 MB; addable without a schema change) | — |

Some unused dependencies in `package.json` are **intentional placeholders**
for the above — Resend and the R2 client are both real, and `moment-timezone`
is held for order and delivery scheduling. Others were not placeholders for
anything, and were removed in §27.

The rule is unchanged and is the reason §27 exists as a decision rather than a
commit: **do not remove an unused dependency as housekeeping.** Identify what
looks unused, say which planned work it belongs to or that you cannot find
one, and ask.

---

## 18. Email is folded to one canonical form before it is stored or looked up

**Implemented** · 2026-11-06 · `src/utils/normalize-email.ts`,
`src/services/user.service.ts`, `prisma/migrations/20261106140000_normalize_user_email`

`users.email` is a case-sensitive unique index — that is what Postgres gives
you for a plain `String @unique` — and nothing lowercased on the way in. So
`Ada@Shop.example` and `ada@shop.example` were **two accounts for one
mailbox**. Confirmed against a running instance: both registrations succeeded,
and the second address could then not log in at all.

The duplicate row is the least of it. What it actually broke:

- `forgot-password` for a casing that misses returns the deliberately generic
  200 (§ the enumeration hardening in `auth.controller.ts`) and sends nothing.
  From outside, a reset that found nobody is indistinguishable from one that
  worked, so the user waits for mail that is never coming.
- `config/google-client.ts` lowercases the address it reads out of the ID
  token, so a mixed-case row can never be matched **or linked** by Google
  sign-in — it answers 403 "no account found" for an account that exists.

`normalizeEmail` is trim + lowercase, applied at every write and every lookup
in the service, and again inside `isEmailTakenUser`. Two things it does not do,
on purpose: it does not strip dots, and it does not cut a `+tag` suffix. Those
are provider-specific rewrites — `a.b@gmail.com` and `ab@gmail.com` are one
mailbox at Google and two almost everywhere else — so applying them would merge
accounts that are genuinely distinct, and plus-addressing is how people
separate their own sign-ups.

**It cannot live in the Joi schema.** `validate` discards Joi's coerced value,
so a schema can reject an address but never transform one. The service is the
only choke point that covers every caller.

**Cost / consequence:** an address is no longer stored as the user typed it,
so a display that wants the original casing has to keep it separately. Nobody
needs that today.

**Still open:** a `CHECK (email = lower(email))` constraint would make the
invariant unbreakable rather than merely enforced. Left out because Prisma's
schema language cannot express CHECK, so one added by hand shows up as drift
on the next `prisma migrate dev` and invites a reset. Worth revisiting if the
project ever adopts a convention for schema-invisible constraints.

**When `customers` is written (§2), it gets the same treatment.** This is
exactly the kind of convention the setup phase exists to settle.

---

## 19. A credential never travels in a URL

**Implemented** · 2026-11-06 · `src/validations/auth.validation.ts`,
`src/utils/redact.ts`

`POST /api/app/auth/reset-password` took its token as `?token=<jwt>`. morgan's
format is `:method :url :status` where `:url` is `originalUrl`, and
`errorHandler` logs `originalUrl` too. So every password reset wrote a live,
single-use account-takeover credential to stdout, to whatever aggregator
collects it, and to the access log of every reverse proxy, load balancer and
CDN in front of this API — none of which are ours to redact. The browser also
puts the full URL in `Referer` on any request the reset page makes.

The token is now a required **body** field. The old call shape 400s rather than
being quietly accepted: a client still sending it in the query has to be
changed, instead of going on logging the credential.

**The emailed link still carries `?token=`**, deliberately. That URL belongs to
the front end, which reads the parameter and posts it here. Moving it to a
fragment (`#token=`) would keep it out of `Referer` and out of the front end's
own server logs, which is strictly better — but it is a breaking change to a
client that does not live in this repo, so it is a conversation, not a commit.

`redactUrl` masks known secret parameters in both log paths as a **backstop**,
so the next person to reach for a query parameter does not repeat this. It is
not the control and it is not permission: it only covers the logs this process
writes, and nothing upstream of it.

---

## 20. Every stored token carries a nonce

**Implemented** · 2026-11-06 · `src/services/token.service.ts`

A token was a pure function of `(sub, type, iat, exp)`, and `iat`/`exp` have
one-second resolution. Two tokens minted for the same user inside the same
second were therefore **byte-identical**.

`sessions.refresh_token` is a unique index on the digest of that value, so the
second one failed on a unique constraint and the user got a 409. Not a
contrived race: a double-submitted login form does it, and so does signing in
on a phone and a laptop at the same moment. `tokens.token` has no unique index,
so the reset path did not throw — it quietly wrote two rows holding the same
digest, which makes "the token cannot be reused" mean less than it says.

Every token type that gets **stored** now carries a `crypto.randomUUID()`
`jti`. Access tokens do not need one: nothing stores them, and they already
differ by `sid`.

Found by a spec written for §5, not by review.

---

## 21. The password work factor is configuration, with a floor, and it upgrades itself

**Implemented** · 2026-11-06 · `src/config/config.ts`, `src/utils/hash.ts`,
`src/services/auth.service.ts`

`hashString` hard-coded `saltRounds = 8`. That is roughly a 2016 setting and
16x cheaper to attack than 12; OWASP's current recommendation is a floor of
10. It hashes staff credentials that will shortly sit beside customer PII.

Three parts, and the second two are what make it a fix rather than a gesture:

1. **It is `BCRYPT_ROUNDS`, default 12**, with a Joi `.min(10)` and `.max(15)`.
   The floor is enforced rather than documented, because a work factor is
   exactly the kind of number that gets turned down to make a slow test suite
   or a slow laptop feel better. The ceiling stops a typo locking the process
   into multi-second logins.

2. **Existing hashes are upgraded on the next successful login.** A bcrypt
   string carries its own cost, so raising the number protects only accounts
   that do not exist yet — every current row keeps cost 8 for life. A
   successful password comparison is the one moment the plaintext is in hand,
   so `upgradePasswordHash` runs there, after the lockout and verification
   gates (a refused login must not write to the row) and best-effort (a failed
   rewrite must not fail a login that has already been proven).

3. **`needsRehash` is false for anything it cannot parse.** A corrupt row is
   for `compareHash` to reject; rewriting it on a guess destroys the evidence.

**Cost:** login gets slower by design — that is the entire point of a work
factor. On this codebase it is worse than it needs to be, which is the open
question below.

**Open — the library, not the factor.** This is `bcryptjs`, a pure-JavaScript
implementation, so a given cost runs several times slower here than the same
cost in a native bcrypt, while an attacker cracking offline uses an optimised
native or GPU build and pays none of that overhead. We therefore pay latency
on every login for resistance we do not get. The two candidates are a native
`bcrypt` binding (same algorithm, same stored format, drops the overhead but
adds a compiled dependency) and `argon2id` (what OWASP actually prefers, and
what resists GPU attack properly — but a different format, so it needs a
migration path of the same shape as point 2 above). Not chosen. Do not pick
one by instinct.

**Note for the test suite:** `BCRYPT_ROUNDS=10` in `tests/helpers/env.ts` —
the enforced floor, so the specs still exercise a configuration that is valid
in production, at the cheapest valid price. At 12, the accounts these specs
create cost about 30 extra seconds.

---

## 22. Every authenticating path applies the same account gates

**Implemented** · 2026-11-06 · `src/services/auth.service.ts`,
`src/controllers/auth.controller.ts`

`POST /api/app/auth/refresh` looked up the session, looked up the user, and
minted a new access token. It applied neither `assertAccountNotLocked` nor
`assertEmailVerificationPolicy` — so an account locked by brute-force
protection went on issuing access tokens from the refresh token it already
held, for that token's full seven days. The lockout closed the front door and
left this one open, and the verification gate had the same hole.

`assertAccountMayAuthenticate` is now the named bundle, called by refresh.
The two login paths still call the primitives individually, on purpose: they
need the lock check *before* the password comparison, so a locked account is
refused without paying for a bcrypt round, and the verification check after.
Refresh has no such ordering, so it takes both at once.

**The general rule:** a gate that only the login route honours is a gate with
a documented way around it. Any future path that turns a credential into a
session — an invite acceptance, a magic link, a storefront login — calls this.

**Cost:** one extra user lookup is NOT added; refresh already fetched the row
to read its role. The gates are pure functions over it.

---

## 23. Services take named inputs, never a model type spread into Prisma

**Implemented** · 2026-11-06 · `src/services/user.service.ts`

`createUser` was `(userBody: User)` spread straight into Prisma —
`data: { ...userBody, password }` — which is every column, `role` among them.

Not exploitable as it stood: the only caller is `POST /auth/register` and its
Joi schema denies unknown keys. The problem is where the guard lived. It was
two layers up, in a schema, and `validations/user.validation.ts` already
carries unwired `createUser` and `inviteUser` schemas that **do** accept
`role`. The first admin or invite route wired to one of those would have
passed a client-supplied role straight through to the database, and nothing
in `user.service.ts` would have looked wrong while it happened.

`CreateUserInput` names four fields and a `role` that defaults to STAFF — the
least privilege `users` can hold. The registration controller names its four
fields rather than forwarding `req.body`. Granting ADMIN is now a line of
code at a call site a reader can see, not a field that arrived in a body.

This is §3 restated as code: *"enforce it in the service, not in the Joi
schema. A schema that forbids a `role` field is one `allowUnknown` change away
from being a privilege escalation; a service that never reads a
client-supplied role cannot be."*

**Pinned by** a spec that mounts `authController.register` on a router with no
validation at all — standing in for that looser future schema — and asserts
the created row is STAFF regardless.

**Still outstanding:** `updateUserById` has the same shape (`Partial<User>`
into `prisma.user.update`). Every caller today is internal and passes a
literal, so there is no risk now, but a `PATCH /staff/:userId` forwarding
`req.body` would be able to set `role`, `emailVerifiedAt` or `googleId`. It
needs an explicit input type before the first route that takes its fields
from a request. `role` has to stay settable there, so that route's gate is
`auth` plus an explicit schema — the signature alone cannot carry it, which
is why this was not done pre-emptively.

---

**Updated 2026-11-07.** `updateUserById` now complies too. It was the one
exception left — `Partial<User>` spread straight into `prisma.user.update`,
with a NOTE in the source saying so. It takes `UpdateUserInput` now, builds
Prisma's `data` field by field, and leaves out `emailVerifiedAt`, `googleId`,
`authProvider` and the identifiers. Each of those has its own service function
that owns the checks going with it — `markEmailVerified`, `linkGoogleId` —
and a generic update that could also set them makes those owners optional.

`role` stays settable, deliberately; promotion is a real operation and its
gate belongs on the route, where a reader will look for it. The build tests
`!== undefined` rather than truthiness, because `loginAttempts: 0`,
`lockUntil: null` and `lastFailedLoginAt: null` are precisely what a completed
password reset writes to clear a lockout.

## 24. Randomness that authorises anything comes from the CSPRNG

**Implemented** · 2026-11-06 · `src/utils/generate-otp.ts`

`generateOtp` used `Math.floor(100000 + Math.random() * 900000)`.

`Math.random()` is a non-cryptographic PRNG. V8 implements it with
xorshift128+ and generates values in batches of 64, so an attacker who
observes a handful of outputs can solve for the internal state and then
predict every code the process produces afterwards — and, because the batch
is pre-computed, the ones it produced just before. For a code that authorises
a password reset or proves control of a mailbox, "predictable" and
"forgeable" are the same word.

`crypto.randomInt(min, max)` draws from the same CSPRNG as `randomBytes` and
is uniform over `[min, max)`: it rejects and re-draws rather than taking a
modulus, which is where the bias in hand-rolled versions comes from. The top
bound is exclusive, so the call passes `MAX + 1` or 999999 becomes
unreachable — a small bias, and the kind that survives review because the
output still looks right.

**Nothing calls `generateOtp` today, and that is the reason to fix it rather
than a reason not to.** This repo is a base that gets copied; the version
sitting here is the version that ends up in the module that does call it.

**The general rule:** `Math.random()` is for jitter, shuffling a carousel and
picking a placeholder. Anything a user presents as proof — a code, a token, a
nonce, an id that must be unguessable — comes from `node:crypto`.

---

## 25. `tokens` is indexed for the three queries that touch it

**Implemented** · 2026-11-06 · `prisma/schema/models/token.prisma`,
`prisma/migrations/20261106150000_token_indexes`

The table had nothing but its primary key, so every query against it was a
sequential scan that gets slower with each row ever written:
`validateStoredToken`'s lookup by digest (every password reset),
`deleteTokens(userId, type)` (every completed reset), and the nightly
`expires < now` sweep (the whole table). `sessions` already carried the
equivalents; this is `tokens` catching up.

`token` is **UNIQUE**, not merely indexed. The column holds a sha256 digest of
a signed JWT, so two rows with the same value describe the same credential and
`validateStoredToken` would have had to pick one arbitrarily.

**That constraint is only safe because of §20.** Before every stored token
carried a random `jti`, a token was a pure function of `(sub, type, iat, exp)`
with whole-second resolution — so two resets requested for one account inside
the same second produced byte-identical tokens, and this index would have
turned the second request into a 500. The ordering matters if these are ever
replayed onto a fresh database: §20 first.

The migration de-duplicates before creating the index, keeping one row per
digest. Duplicates are indistinguishable as credentials, so nothing is lost
that was not already ambiguous, and a reset token that goes missing costs its
owner one more click on "forgot password".

**Pinned by** `tests/integration/token-indexes.test.ts`, which asserts against
`pg_indexes` rather than timing a query — on a small table Postgres correctly
prefers a sequential scan even when the index exists, so a plan assertion
would fail for the right reason and look like the wrong one.

---

## 26. Rate-limit counters live in Redis, and fail open

**Implemented** · 2026-11-06 · `src/middlewares/rate-limiter.middleware.ts`,
`src/config/redis.ts`

Every limiter used express-rate-limit's default MemoryStore. That keeps the
counters in the process, which is correct at exactly one instance and quietly
wrong at any other number: with N instances behind a load balancer each counts
separately, so the 20-per-window login cap has a real ceiling of 20N — and
nothing anywhere reports that the control has been weakened.

`ecosystem.config.json` runs `instances: 1` today, which is the only reason
this was not already a live hole. **Changing that number to `"max"` is a
one-word edit that silently multiplies every limit in the application**, which
is precisely the kind of trap this repo exists to not hand its copies.

With `REDIS_ENABLED=true` every instance now increments the same key, and the
configured number is the number. Off, it falls back to the memory store, so
local development needs no Redis.

Two details that are deliberate:

- **A third connection role, `limiter`.** Same fail-fast options as `queue`
  (it is on the request path, so it may never block one), but its own client
  so `CLIENT LIST` can tell a slow limiter from a slow enqueue, and so a
  future `keyPrefix` or database selection on one does not silently apply to
  the other.
- **Keys are namespaced `<QUEUE_PREFIX>:rl:<name>:`.** Under the app prefix so
  they cannot collide with BullMQ's, and per limiter so one bucket cannot be
  read and spent as another — a login attempt must not burn upload quota.

**`passOnStoreError: true` — it fails OPEN, and that is the argument worth
reading.** If Redis is unreachable the request is allowed through rather than
answered with a 500. This is the same call `config/redis.ts` already makes for
the process as a whole: Postgres is load-bearing for every request, Redis backs
things the API survives without.

Rate limiting here is a backstop against noise and brute-force *volume*, not
the control that stops either. The control that stops password guessing is the
per-account lockout in `auth.service`, and that lives in Postgres and does not
move when Redis does. Failing closed would mean a Redis blip takes the whole
API down — a larger and considerably likelier outage than the one it would
prevent.

**Cost:** one Redis round trip per limited request, and a new dependency
(`rate-limit-redis`, the store maintained alongside express-rate-limit). The
alternative was hand-rolling a store over `INCR`/`PEXPIRE`, which is a race
between the two commands unless it is written as a Lua script — which is what
the package already is.

**Where this does not help:** a limit is still per key, and the key is still
the client IP for most of them. `TRUST_PROXY=0` means `req.ip` is the socket
peer, so behind a proxy every request shares one bucket. That is a separate
setting and a separate decision; getting it wrong in the other direction lets
a caller forge `X-Forwarded-For` and mint a fresh bucket per request.

---

## 27. Unused dependencies that were not placeholders are gone

**Implemented** · 2026-11-06 · `package.json`

A `pnpm audit` returned 67 advisories, 1 critical and 32 high. Most are
dev-only and stay for now. Five production dependencies had **zero imports
anywhere** in `src/`, `tests/` or `prisma/`, and none of them belonged to any
planned work in §17:

| Removed | Why it was there | Why it went |
| --- | --- | --- |
| `axios` | nothing | `google-auth-library` and `aws4fetch` do their own HTTP; it dragged in a `follow-redirects` HIGH |
| `nodemailer` | a hypothetical SMTP fallback (§16) | Resend is the decision; a fallback nobody designed is not a placeholder |
| `validator` | nothing | Joi validates everything here |
| `uuid` | nothing | ids come from Prisma's `@default(uuid())` and `crypto.randomUUID()` |
| `path-to-regexp` | nothing | Express depends on it itself; naming it directly only pins a version we do not choose |

**`moment-timezone` stays.** It is genuinely unused today and it is genuinely
wanted: order timestamps, delivery windows and store opening hours are all
timezone-bearing, and that work is coming. Kept at the owner's explicit
instruction — which is the shape every one of these calls should take.

**`ip-address` was pinned instead of removed.** `express-rate-limit` depends
on it and the advisory covers ≤10.3.0, while its own range (`^10.2.0`) already
permits the fixed 10.7.6 — the lockfile was simply holding an old resolution.
A `pnpm.overrides` entry moves it, with no API change and no fork. It is worth
doing rather than accepting because it sits in the rate limiter's key-derivation
path, which §26 just made more load-bearing.

**Result: 67 advisories → 54, and no HIGH left on a runtime request path.**

### Still outstanding, deliberately not acted on

Flagged rather than removed, because none of them were in the instruction and
the house rule above is the house rule:

- **`faker@6.6.6` is in `devDependencies` with zero references.** This is the
  deliberately sabotaged release — the maintainer published a version that
  prints garbage and hangs. It carries a HIGH advisory for exactly that. It is
  dev-only and unused, so it is doing nothing but sitting in the tree.
- **`coveralls` is the CRITICAL** (`coveralls` → `request` → `form-data`),
  with zero references and no script that calls it. Coverage is produced by
  `jest --coverage`; nothing uploads it.
- **`npm` and `install` are devDependencies.** This repo uses pnpm. `npm` as a
  dependency pulls in an enormous tree, and `install@0.13.0` is the package
  people get by accident from `npm install install`.
- **`@types/compression` and `@types/morgan` are in `dependencies`,** not
  `devDependencies`. Harmless, but they ship to production for nothing.
- **`bullmq` is designed around throughout `src/config/redis.ts`** — the two
  connection roles exist for it specifically — **and is not in
  `package.json` at all.** That is the opposite problem and the more
  surprising one: the queue work in `todo/sugestion-2.md` cannot start without
  an install step nobody has recorded.

---

## 28. Login hands out cookies or a code, never a token in the body

**Implemented** · 2026-11-06 · `src/controllers/auth.controller.ts`,
`src/services/auth-code.service.ts`, `src/utils/pkce.ts`,
`prisma/schema/models/auth-code.prisma`

`POST /auth/login` returned the access and refresh tokens in the JSON body
**and** set them as httpOnly cookies. The comment on it said why: *"so browser
clients can rely on the cookies while non-browser clients use the body."*

The second half of that sentence destroyed the first. `httpOnly` exists to
put a cookie out of JavaScript's reach; printing the same secret beside it in
a response body that `fetch` can read gives the whole thing away. Any XSS in
the admin SPA — one dependency, one `dangerouslySetInnerHTML`, one bad
sanitiser — could call login's own response handler, or simply replay the
endpoint, and walk away with both credentials. The refresh token is the
valuable one: thirty days of access, usable from anywhere, and until §5 it
could not even be revoked.

### What it is now

One endpoint, two credential shapes, chosen by the caller's `client` field:

| | `client` absent or `web` | `client: "native"` |
| --- | --- | --- |
| Cookies | both, httpOnly | none |
| Body | the user, nothing else | a single-use authorization code |
| Session | created at login | created at redemption |

A native client then posts the code and its PKCE verifier to
`POST /auth/token-exchange` and receives the access and refresh tokens in the
body, which is the one place they can go for a client with no cookie jar.

### Why `client` being client-supplied is not a hole

It selects which credential shape the caller receives, not what they are
allowed to do. To set it to `native` on somebody else's login you would have
to be performing that login — which means you already have the password.

What it must never do is let a *browser* login be handed a code, because then
the page is holding a redeemable credential again and nothing has been
gained. Two things stop that: the schema makes `codeChallenge` required when
`client` is `native` and `forbidden` otherwise, so a request cannot be half of
each; and `nativeChallenge` in the controller re-checks the challenge's shape
rather than trusting the schema, so a future route wired up without that
constraint fails closed. Same reasoning as the upload service re-checking
`folder`.

That backstop was wrong on its first pass and is worth recording, because the
mistake is easy to repeat: it expressed "no" by returning `undefined` — which
is also how the same function says "this is a browser". So a native request
with an unusable challenge did not fail closed at all. It fell through to the
browser branch and was answered **200, with two `Set-Cookie` headers and no
authorization code**: a live session the caller had no jar for, could not use
and could not revoke, wearing the shape of success. It now throws 400.
Failing closed has to mean an error; a credential in the wrong shape is not a
safe default.

### PKCE, and what it is and is not for

RFC 7636, S256 only. The client invents a `code_verifier` before it logs in,
sends `base64url(sha256(verifier))`, and must produce the verifier to redeem
the code. An intercepted code — a proxy, a log, another app on the device —
is then useless on its own.

`plain` is deliberately not implemented. It makes the challenge and the
verifier the same string, so anyone who sees one has the other.

**PKCE is not what protects the browser case**, and it is worth being plain
about that because it is the obvious thing to assume. An attacker running
script inside the legitimate client has the verifier too. The browser case is
handled by not issuing a code to a browser at all: there is nothing in the
page to take.

### Three details that are the actual security

1. **The code is claimed before the verifier is checked.** `consumeAuthCode`
   runs its conditional `updateMany` first and compares the challenge
   afterwards, so a wrong verifier *burns the code*. A holder without the
   verifier gets one attempt rather than as many as fit inside the expiry
   window. The cost is that a client with a verifier bug has to log in again,
   which is the correct direction to be wrong in.

   **And `consumedAt` is tested before `expiresAt`.** This one was wrong on
   the first pass. The expiry test sat in front, so a consumed-but-expired row
   returned `invalid` and the replay branch never ran — which quietly undid
   the whole reason redeemed rows are kept past their expiry. The attacker
   redeems at t+2s; the real client is the one that arrives late, because it
   is the one on a train. One network handoff or cold resume past the sixty
   seconds and the attacker's session survived its full term, unrevoked. An
   attacker is under no obligation to be punctual, and a late replay is the
   one most worth catching. The detection window therefore runs until the
   nightly sweep collects the row, not until the code expires.

2. **Single use is `updateMany ... where consumedAt: null`,** not
   read-then-check-then-write. Two concurrent redemptions would both read
   `null`, both decide the code was unused, and both mint a session. Making
   the condition and the write one statement lets the database settle it:
   exactly one caller sees `count === 1`.

3. **A replay revokes the session the first redemption produced.** Two
   parties holding one code means the first redemption is the one that cannot
   be trusted — it may well have been the attacker, with the real client
   arriving second. RFC 6749 §4.1.2 asks for exactly this.

   **The session is created before the code is claimed, and the claim records
   its id.** Both halves are needed, and getting there took three attempts
   that are worth recording, because each one looked finished.

   1. *Claim, then insert the session, then a follow-up `UPDATE` writing its
      id.* A loser landing between the `INSERT` and the `UPDATE` read `null`
      and revoked nothing.
   2. *Claim and write the id in one statement, insert the session after.*
      This is the version that reads as obviously correct, and it is the one
      to be careful of. The loser now read the **right** id — and still
      revoked nothing, because the row it named had not been inserted yet.
      The window had moved, not closed, and it was wider than before: it
      spanned two more awaited round trips. Measured at roughly one
      redemption in twelve.
   3. *Insert the session, then claim.* A loser's `updateMany` waits on the
      winner's row lock, and the winner took that lock only after its
      `INSERT` had committed. By the time the loser reads an id, that session
      is real.

   The price is a session created before the code is known to be good. It is
   deleted — not revoked — on every failure, because no credential for it ever
   left the process and an `isActive: false` row would read like a login that
   happened.

   **`auth_codes.session_id` is a foreign key, and that is the enforcement.**
   It was dropped for version 2, which needed to name a session that did not
   exist; restoring it in version 3 turns the ordering from a convention into
   something the database checks. Put the `INSERT` back after the claim and
   every redemption fails loudly, rather than one in twelve failing silently —
   which is the difference between a bug a test suite finds and one it does
   not. `ON DELETE SET NULL` is kept so the nightly session sweep cannot erase
   a code's record of having been redeemed, and it disowns the session for
   free when a wrong verifier burns a code.

   A lesson worth keeping separately from the mechanism: **a race that
   reproduces one time in twelve passes a single test run eleven times out of
   twelve.** The concurrent spec repeats; the constraint is what actually
   guarantees it.

### The same rule applied to refresh

Taking the tokens out of the login response would have moved the problem
rather than fixed it, because `POST /auth/refresh` mints an access token and
an XSS can call it — the browser authenticates the request with the httpOnly
cookie on the attacker's behalf.

So **the reply mirrors the request**. A caller authenticated by cookie gets
the new access token as a cookie and an empty body. A caller that sent the
refresh token in the body gets its tokens there, having already demonstrated
it holds the credential outside a cookie jar. The body is checked first, so a
native client on a platform that silently keeps cookies is not served the
wrong branch.

Both halves, and both paths. The first pass gated only the body copy and
called `res.cookie` unconditionally, so a body-authenticated caller had an
access cookie planted on it anyway — and in any context that shares a jar with
the admin SPA, a WebView or a hybrid shell, that is this very exposure
arriving through another door: script there is authenticated automatically on
every route afterwards, without ever having read a token. The *failure* path
had the same shape in reverse: `clearAuthCookies` ran for everyone, so a
native client's refused refresh logged the co-resident SPA out over a request
that had nothing to do with it. Touch the jar only for the caller who
authenticated from it. A mirror that reflects in one direction is a window.

### Cost, and what is still open

- **Two round trips for a native login.** Unavoidable; it is the same shape
  as every OAuth code flow, for the same reason.
- **A new table, `auth_codes`,** and the highest-churn one in the schema: a
  row per native login, dead within a minute. It is swept by the existing
  token-cleanup cron. Redeemed rows are swept on the same schedule rather
  than deleted at redemption — a consumed row is what makes a replay
  detectable, so it has to outlive the code's validity window.
- **Every client changes.** The SPA stops reading `data.token` and relies on
  the cookies it was already being sent. This is a breaking change and the
  right time for it is now, before there are clients to break.
- **Google sign-in takes the same two shapes,** or a native app could not use
  it at all — a gap that would be discovered halfway through building a
  mobile client.
- **Not done: binding the code to the requesting IP or user agent.** It would
  catch a code redeemed from somewhere else, and would also break every
  mobile client that changes network between two requests, which is all of
  them. The PKCE binding is the one that holds without false positives.
- **Decided against: refresh-token rotation.** Raised by the original review,
  declined on 2026-11-07. A refresh token stays valid for its full seven days
  and there is no reuse detection on it; the detection built here covers
  authorization codes only.

  Rotation would mean a chain of generations — a row per refresh, claimed by
  the same conditional update used for codes, a replayed generation revoking
  the chain. The table is not the cost. The cost is that strict rotation
  cannot tell a stolen token from two legitimate requests racing: two tabs, or
  a mobile client firing parallel calls the moment its access token expires,
  both present the same token and one of them looks exactly like theft. So it
  logs real users out during ordinary use. The usual remedy is a grace window
  that re-serves the recorded successor — a second timing-sensitive mechanism
  guarding the first.

  What makes it affordable to decline *here* is §5. An access token resolves
  its session on every request, so a stolen refresh token is already
  revocable: logout and "revoke everything for this account" end it
  immediately rather than leaving it to run out the week. Rotation would
  shorten the window in which a theft goes **unnoticed**; it would not add a
  way to stop one. Revisit if the refresh lifetime grows, or when there is
  somewhere to send a "new sign-in" alert — a reuse signal is worth far more
  once something can act on it.

**Pinned by** `tests/integration/auth.token-exchange.test.ts` (31 specs) and
`tests/unit/pkce.test.ts`, which checks the S256 implementation against the
worked example in RFC 7636 appendix B.

---

## 29. The production seed creates the first admin, exactly once

**Implemented** · 2026-11-07 · `prisma/seed.ts`, `.env.example`

`pnpm db:seed` now has two shapes. In development it is unchanged: one account
per role, fixed passwords, printed to stdout, idempotent by upsert. In
production it creates **one ADMIN** from `SEED_ADMIN_EMAIL` and
`SEED_ADMIN_PASSWORD`, prints the address but never the password, and does
nothing at all if the account already exists.

Before this, the script threw on `NODE_ENV=production` outright. Combined with
§14 (`/auth/register` is development-only) and §3 (no invite route yet), a
fresh production database had zero users and no supported way to create one.
Nobody could sign in to the admin surface at all. The guard was right about
its own reason — the development accounts have hardcoded, printed passwords —
but it generalised from "these accounts" to "this script".

Three details are deliberate:

- **`create`, not `upsert`.** This is the whole design. `db:seed` is exactly
  the kind of command that ends up in a deploy script, and an upsert would
  rewrite the live admin's password to whatever is in the environment on every
  redeploy — a silent credential rollback, undoing a password the owner had
  since changed, with the superseded value still sitting in the deploy config.
  So the production path creates the account if it is absent and leaves it
  completely alone if it is not. A `P2002` from a concurrent run is caught and
  reported as "already exists", not raised.

- **The credentials are validated in the seed, not in `src/config/config.ts`.**
  Nothing but this script reads them. Putting them in the application's boot
  schema would mean a typo in a seed-only variable refuses to start the API —
  a running service taken down by a value it never reads. The password rule is
  *imported* from `validations/custom.validation` rather than restated, so the
  first admin cannot hold a credential the app would reject from anyone else.

- **The email is folded before both the lookup and the write.** `users.email`
  is a case-sensitive unique index. A `SEED_ADMIN_EMAIL` written with a
  capital would create a row that every normalising lookup in the application
  misses — an account that exists and cannot be used.

**What this does not solve.** The bootstrap password is the admin's only
credential until password reset actually sends mail, because that endpoint is
a no-op in production — see [todo/sugestion-6.md](../todo/sugestion-6.md). Until
then, recovering a locked-out production account means clearing `lockUntil` in
the database by hand. The seed is deliberately not a recovery tool; those two
properties are the same property.

**Cost:** a production-only branch in a script, which is the shape of code that
rots unnoticed. Bounded by covering it: `prisma` is now in
`tsconfig.test.json`'s `include` — it was typechecked by neither config before
— and the branch has its own integration spec.

**Pinned by** `tests/integration/seed-production-admin.test.ts` (14 specs),
including that a second run does not rewrite a password changed in between.

---

## 30. Boot refuses configuration whose failure would otherwise be silent and late

**Implemented** · 2026-11-07 · `src/config/config.ts`,
`src/middlewares/rate-limiter.middleware.ts`, `.env.example`

Three settings could be wrong in production without anything saying so. Each
now fails, or at minimum speaks, at startup rather than at the moment someone
depends on it.

- **`JWT_SECRET` has a floor of 20 characters.** It was
  `Joi.string().required()`, so a one-character secret booted production
  happily — while `BCRYPT_ROUNDS` immediately below it enforced a minimum of
  10 and `AUTH_CODE_EXPIRATION_SECONDS` enforced its own. HS256 signs every
  access token with this string: recover it offline from a single captured
  token and you can mint a token for any `sub` with any `role`, which §5's
  session lookup will honour because the signature is valid. 20 is a floor,
  not a recommendation; `.env.example` says to generate it with
  `openssl rand -base64 32`.

- **`SITE_URL` is required in production, and validated as a URI.** It had
  neither a default nor a production cross-check, unlike `ALLOWED_ORIGINS`
  right beside it. Unset, the reset link in `forgotPassword` assembles as
  `undefined/reset-password?token=<live token>` — a working single-use
  credential in a dead link, mailed to the one person who by definition cannot
  get in another way. It reads nowhere at boot today, so the first sign of
  trouble would have been a production user reporting a broken link. Optional
  outside production, where the reset flow returns the link in the body.

- **The in-process rate-limit store warns in production.** `.env.example`
  ships `REDIS_ENABLED=false`, so the weak configuration is the one you get by
  not deciding. §26 explains why MemoryStore is correct at exactly one
  instance and quietly wrong at any other number; what was missing is anything
  that says so at runtime. Raising `instances` in `ecosystem.config.json` or
  adding a second container multiplied every limit by N in silence.

  A warning and **not** a refusal, deliberately: one instance with MemoryStore
  is a legitimate production deployment and `ecosystem.config.json` pins
  exactly that. The failure is scaling out without revisiting it — a thing to
  be told about, not prevented from booting. It is emitted once per process,
  not once per limiter; five identical startup lines is how a startup log
  teaches people to skip startup logs.

**Cost:** a deployment that was running on a short `JWT_SECRET` or without
`SITE_URL` will now refuse to start after this upgrade. That is the intent —
both were already broken, one invisibly — but it is a breaking change for an
existing `.env` and belongs in the upgrade notes.

**Pinned by** `tests/unit/config.test.ts` and
`tests/unit/rate-limiter-redis-warning.test.ts`.

---

## 31. State-changing requests that carry cookies must name a trusted origin

**Implemented** · 2026-11-07 · `src/middlewares/csrf.middleware.ts`, `src/app.ts`

In production the auth cookies are `SameSite=None` (§28, `config/cookies-option`)
because the admin frontend is on a different origin to this API, and CORS runs
`credentials: true`. There was no CSRF defence of any kind — no token, no
origin check, and no mention of the word anywhere in `src/`, `docs/` or
`README.md`.

CORS was not covering it, and the reason is worth stating precisely: **CORS
does not prevent a cross-site request, it hides the response.** For anything
the browser classes as a "simple" request that distinction is the entire
vulnerability. A `multipart/form-data` POST is simple — no preflight, so the
browser sends it, the server executes it, and the attacker never needed to
read the reply. Any page a signed-in staff member visited could therefore make
their browser run `POST /api/app/files` or `POST /api/app/auth/logout` with
their cookies attached. `PATCH` and `DELETE` are preflighted and were always
safe, which is exactly why this was easy to miss.

`requireTrustedOrigin` runs after `cookieParser` and before the routes. On a
POST, PUT, PATCH or DELETE **that carries one of our auth cookies**, the
`Origin` header must name an origin in `ALLOWED_ORIGINS`; otherwise it is a
403, logged at warn with the offending origin and answered with a message that
does not reveal the allowlist.

Four scoping decisions, each of which is the difference between a control and
an outage:

- **It keys on the cookie, not on the method alone.** CSRF is only about a
  credential the *browser attaches by itself*. A native client authenticating
  with a bearer token had to be handed that token; no third-party page can
  make a browser produce one. Those callers send no `Origin` at all, so a
  method-only check would have broken every one of them for no gain — see
  §28 for why the native flow exists.

- **An origin check, not a double-submit token.** A token is stronger in the
  abstract and requires every client to read a cookie and echo it in a header
  — an API contract change for a frontend that does not exist yet. The origin
  check closes the same hole with no client cooperation, and a token layers
  on top of it later rather than replacing it.

- **Production only.** Outside it the cookies are `SameSite=Lax`, which
  already withholds them from a cross-site POST, and a developer running a
  frontend on an arbitrary port is the normal case.

- **A missing `Origin` on a cookie-bearing state-changing request is refused,
  not allowed.** Browsers have sent it on every such request for years and a
  page cannot forge or suppress it. A cookie arriving without one is not a
  browser doing something ordinary, and "absent" must not be the gap the whole
  check falls through.

**Cost:** a server-to-server caller that authenticates with cookies rather
than a bearer token now needs to send an `Origin`. Nothing in this repo does
that, and the native flow in §28 exists so that nothing has to.

**Pinned by** `tests/unit/csrf-middleware.test.ts` (12 specs), six of which
fail outright without the middleware.

---

## 32. The spool write computes the upload's MD5, so the file is read once

**Implemented** · 2026-11-07 · `src/middlewares/upload.middleware.ts`,
`src/services/file.service.ts`, `src/controllers/file.controller.ts`

`createFile` streamed the whole temp file through an MD5 to produce the
`Content-MD5` header, then streamed the whole temp file again to R2. At the
95 MB video cap that is 190 MB of disk I/O per upload, and the second pass had
to finish before the PUT could start — so it was latency, not just I/O.

The digest cannot be folded into the upload itself: R2 checks the body against
a request header, so the header has to exist before the body is sent. It can
be folded into the pass that was already happening, which is multer writing
the bytes to disk. `upload.middleware` now uses a storage engine that pipes
the incoming file through a hashing `Transform` on its way to the spool file
and reports the digest as `file.contentMd5`.

- **The engine mirrors `multer.diskStorage` deliberately** — the same pipe
  chain, `out.bytesWritten` for the size, the same error surface — so
  multer's handling of a `limits.fileSize` overrun is unchanged. The callback
  is guarded against firing twice, which multer would treat as a second file.

- **`CreateFileParams.contentMd5` is optional, and the fallback re-reads the
  file.** A service must not depend on a middleware two layers up still being
  mounted — the same reasoning that makes `createFile` re-check `folder`
  against the allowlist rather than trusting `validate`. Every caller that is
  not the upload route takes the fallback, and a spec covers it; the point is
  that it is the slow path rather than the only path.

- **The magic-byte sniff is not a third read.** `readMagicBytes` opens the
  file and reads a fixed prefix, so it was never proportional to file size and
  is left alone.

- **The engine delegates to `multer.diskStorage` rather than replacing it.**
  Multer's own engine does far more than pipe a stream to a file: it assigns
  `file.path` before the write starts so an aborted request is still
  cleanable, tracks the open write stream so `_removeFile` waits for the
  descriptor to close before unlinking, refuses an already-destroyed stream,
  and routes everything through `stream.pipeline`. A hand-rolled engine that
  skipped any of that strands or double-deletes spool files on precisely the
  failure paths nobody exercises by hand — which is what the first attempt at
  this did.

  The one subtlety: `make-middleware` installs `file.stream` with
  `Object.defineProperty` and **no `writable: true`**, so `file.stream = ...`
  silently does nothing. The raw busboy stream then stays in place while the
  hashing transform is also reading it, and two consumers racing one stream
  hangs the request. It has to be redefined, not assigned.

- **`contentMd5` is a named type and an accessor, not an ambient
  augmentation.** The first version added `declare global { namespace Express
  { namespace Multer { interface File ... } } }` in `src/types/multer.d.ts`.
  That typechecks under `tsc`, which loads the tsconfig `include` globs — and
  is invisible to **`ts-node`**, which does not unless `ts-node.files` is
  enabled. So `pnpm typecheck`, `pnpm lint` and the whole Jest suite passed
  while `pnpm dev` crashed on startup with `Property 'contentMd5' does not
  exist on type 'File'`.

  `SpooledFile` and `spooledMd5` now live in `upload.middleware.ts` next to
  the engine that sets the property, with the single cast in each direction
  in one file. Nothing depends on which compiler entry point loaded which
  declaration file.

  Worth remembering generally: **the four gate commands do not start the
  application.** A change that only breaks under `ts-node` passes all of
  them.

**A latent leak this surfaced.** The body's `ReadStream` was built eagerly in
`putObject`'s argument list, and `putObject` can throw before it touches the
body at all — storage switched off, a credential refused. The stream was then
left unconsumed and undestroyed, and the `finally` unlinked the spool file
immediately after, so the stream's own `open` landed against a path that no
longer existed and raised an `error` event with no listener: an unhandled
rejection instead of a 503.

It had always been true and was hidden by evaluation order. The digest used
to be awaited inside that same object literal, and the await yielded the event
loop for just long enough that the `open` landed while the file still existed.
Removing the second read removed the accidental delay. `createFile` now tears
the stream down and waits for it before rethrowing, with the error listener
attached only on the failure path so a genuine read error during a live PUT
still propagates.

**Cost:** a storage engine wrapper instead of a one-line `multer.diskStorage`
call, on a path where a mistake corrupts uploads. Bounded by asserting the
bytes and the digest end to end against the R2 stub, not just the read count —
a `Transform` that dropped a chunk would still produce a valid-looking base64
digest and an unusable file.

**Pinned by** `tests/integration/upload-single-pass.test.ts` (10 specs): two
count opens of the spooled path and fail against the two-pass version, three
cover the unconsumed-stream teardown.
