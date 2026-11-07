---
name: new-module
description: Add a new REST resource to this API following the project's full conventions - Prisma model, migration, service, controller, Joi validation, routes, Swagger docs, barrel registration, rights, and tests. Use when adding a resource such as product, category, cart, order, address or review.
---

# Adding a resource

Adding a resource here means touching **eleven** places. The three that get
forgotten are the barrels, the rights and the Swagger object — all three fail
quietly: the code compiles, the route 403s or the docs silently lose a section.

Work in this order. Each step depends on the one before it.

## 1. Schema

`prisma/schema/models/<resource>.prisma`, plus `prisma/schema/enums/` for any
enum. Match the column-aligned style of `session.prisma`.

- `id String @id @default(uuid())`
- `@map("snake_case")` on every multi-word field, `@@map("plural")` on the model
- `createdAt` / `updatedAt` as in the existing models
- Index what you will actually query on — write the index to match the query
  shape, not one column at a time
- Choose `onDelete` deliberately and say why in a comment. `Cascade` on a user
  relation deletes business records when an employee leaves; that is usually
  wrong. See `File.uploadedBy`, which is `SetNull` for exactly that reason.
- Add the back-relation to the other side of every relation

Then `pnpm prisma:migrate` (dev) and `pnpm prisma:generate`. Never hand-edit a
migration that has already been applied — a PreToolUse hook blocks it.

## 2. Service — `src/services/<resource>.service.ts`

All business logic and **every** Prisma call. Controllers must not import Prisma.

- Return `null` for "not found"; the caller decides whether that is a 404
- Never spread an unfiltered request object into `prisma.*.create` — list the
  fields explicitly, or a client-supplied `role`/`status`/`ownerId` becomes a
  privilege escalation
- Throw `ApiError` for business-rule failures, not for database failures;
  `error.middleware.ts` already maps Prisma errors to status codes

## 3. Validation — `src/validations/<resource>.validation.ts`

Named exports, one schema per operation, `{ params, query, body }`.

- Route ids are **uuids**: `Joi.string().uuid()`. There is no `objectId` helper
  and there must not be one — this is a Postgres project
- Never write `Joi.required()` with no base type; that is `Joi.any().required()`
  and checks nothing
- `validate` discards Joi's coerced value, so a schema can only reject. It
  cannot strip, default or transform — do that in the service
- Paginated list endpoints need a `limit` with a maximum

## 4. Controller — `src/controllers/<resource>.controller.ts`

```ts
const getThing = catchAsync(async (req: Request, res: Response) => {
  const thing = await thingService.getThingById(String(req.params.thingId));
  if (!thing) throw new ApiError(httpStatus.NOT_FOUND, "Thing not found.");

  res.status(httpStatus.OK).send({
    status: "success",
    message: "Thing retrieved successfully.",
    data: { thing },
  });
});
```

Wrap every handler in `catchAsync`, pull query params through `pick`, and define
the field allowlist as a `const THING_FIELDS` array at the top. Exports go in a
single `export { ... }` block at the bottom.

## 5. Rights — `src/config/constants.ts`

Add to `rolePermissions`. Rights are added alongside the module that needs them,
never invented up front. Decide explicitly whether a right is owner-scoped or
role-scoped, and write the reason as a comment — product media is role-scoped
(any staff may delete any file) and that was a deliberate call.

## 6. Routes — `src/routes/app/<resource>.routes.ts` or `src/routes/store/...`

**Pick the namespace first.** `app/` is staff and admins, authenticating
against `users`; `store/` is shoppers, authenticating against `customers`
(which does not exist yet — if the resource is shopper-facing, stop and read
`docs/decisions.md` §13 before writing anything). A resource that both need is
two route files over one service, not one route file with a role branch.

`auth(right)` → rate limiter if needed → `validate(schema)` → controller.

- `auth` grants on rights alone. If the route needs ownership, add
  `requireSelf("paramName")` **after** `auth` so it is visible at the route
- On a multipart route, multer must come **before** `validate`, and
  `handleMulterError` immediately after multer. See `app/file.routes.ts`, whose
  header comment explains the ordering

## 7. Swagger — `src/routes/docs/<resource>.docs.ts`

A typed `Paths` object spread into `swagger-definition.ts`, plus a component
schema and a `tags` entry. Path keys carry the namespace — `"/app/things"`, not
`"/things"`; the `servers` entry only supplies the `/api` part. **Not** `@swagger` JSDoc comments — TypeScript strips
those out of `dist/`.

## 8. Register in four places

Forgetting any of these is the most common mistake:

- `src/services/index.ts` — `import * as thingService from "./thing.service"`
- `src/controllers/index.ts`
- `src/validations/index.ts`
- `src/routes/app/index.ts` (or `store/index.ts`) — `router.use("/things",
  thingRoute)`. **Not** `src/routes/index.ts`, which mounts the two namespaces
  and nothing else
- `src/routes/docs/index.ts` if you added a docs file

## 9. Tests

- `tests/unit/` for anything that needs no database
- `tests/integration/<resource>.routes.test.ts` for the routes, against a real
  PostgreSQL, using the helpers in `tests/helpers/`
- Cover the authorization matrix explicitly: each role that should be allowed,
  each that should not, and unauthenticated. A 403 that should be a 200 is
  caught by a reviewer; a 200 that should be a 403 usually is not.
- When fixing a bug, restore the bug and confirm the new test fails before
  keeping it

## 10. Verify

```bash
pnpm prisma:generate && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

`pnpm typecheck` alone does not cover the tests — they have their own tsconfig.

## 11. Record the decision

If anything about the resource was a judgement call — the ownership model, a
denormalisation, an `onDelete`, a status column standing in for a missing
relation — add an entry to `docs/decisions.md` saying what was decided, what it
rules out, and what it costs.
