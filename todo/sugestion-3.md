# Suggestion 3 — Staff/admin invites, and an account status that does not lock people out of the shop

**Status:** design only — except the `auth` self-access bypass ("Second thing"), fixed 2026-11-05
**Raised:** 2026-11-05
**Depends on:** email sending via Resend (not yet wired) — invites need a real mailbox round-trip
**Blocks:** nothing, but it should land before any admin-panel route exists

## The requirement

1. `POST /auth/register` may only ever create a **CUSTOMER**.
2. STAFF and ADMIN accounts come from an **invite** flow instead.
3. Accounts need a status: `ACTIVE` / `INVITED` / `DEACTIVATED`, "for admin and staff only".
4. **A deactivated staff member must still be able to shop on the storefront.**

Point 4 is the whole design. Everything below follows from it.

---

## What point 4 actually says

"Deactivated" does not mean *this person is disabled*. It means *this person no longer works
here*. They keep their cart, their order history, their saved addresses, their ability to buy —
they lose the back office.

So there are **two independent lifecycles on one human being**:

| | Granted by | Revoked by | Ends when |
|---|---|---|---|
| **Shopper** | registering | basically never | they delete the account |
| **Employee** | an invite from an admin | an admin deactivating them | they leave the company |

A single `role` column cannot carry both, because it has one value and there are two answers. If
you deactivate a STAFF member and leave `role = STAFF`, they keep staff rights. If you flip them
to `CUSTOMER`, you have destroyed the record of what they were and reactivation has to guess.

That is the fork in the road, and it is worth getting right now rather than later: there is no
`Product`, `Cart` or `Order` model yet, so nothing else depends on the shape of `role` today.
In three months every one of those will.

---

## The decision: two principals, two tables (chosen 2026-11-05)

**`User` is staff and admin only, and lives in the administration app. `Customer` is a separate
table, and lives in the storefront. A staff member who shops has a row in each. Deactivating the
`User` does not touch the `Customer`.**

This supersedes two earlier drafts of this document (a `StaffAccount` side-table, and a plain
`status` column), both of which kept one identity table. They were optimising for the smallest
diff against today's code. This optimises for the domain, which is the right thing to optimise
for while there is no `Product`, `Cart` or `Order` model to be dragged along.

It is also where the e-commerce market has converged: Shopify (staff accounts vs customer
accounts), Magento (`admin_user` vs `customer_entity`) and Medusa (`user` vs `customer`) all split
here. Single-table designs exist — WooCommerce, Saleor — but those are a plugin and a storefront,
not platforms with a back office.

### Why it is better than a single table with a status column

- **Blast radius.** Storefront registration writes to a table that *has no role column*. A bug in
  the public signup path cannot create an admin — not "is validated against", **cannot**. Every
  single-table design makes that guarantee a code rule instead, and code rules are one careless
  refactor from gone.
- **The two security postures genuinely diverge.** The admin app wants a short token TTL, 2FA, IP
  allowlisting and an audit log. The storefront wants long sessions, social login and low
  friction. One table pushes you toward one policy for both, and it drifts toward the customer's
  convenience, because that is where the volume and the complaints are.
- **`status` becomes honest for every row.** The original requirement said the status is for admin
  and staff only. Every row in `users` now *is* staff or admin, so the column means one thing
  everywhere it appears — no side table, no "ignore this field for customers".
- **The data shapes barely overlap.** A customer carries addresses, cart, wishlist, marketing
  consent, tax exemptions and guest-order linkage. A staff user carries role, status, invited-by
  and admin audit fields. Sharing a table means a wide row that is half null for every reader.
- **The scales differ by orders of magnitude.** Tens of staff; potentially millions of customers.
  Different indexes, different query shapes, different retention rules.

### Shape

```prisma
enum Role       { STAFF  ADMIN }                  // CUSTOMER is gone
enum UserStatus { INVITED  ACTIVE  DEACTIVATED }

model User {        // administration app only — rename pending, see below
  role   Role
  status UserStatus @default(INVITED)
  invitedById     String?   @map("invited_by_id")
  deactivatedById String?   @map("deactivated_by_id")
  invitedAt       DateTime  @default(now()) @map("invited_at")
  activatedAt     DateTime? @map("activated_at")
  deactivatedAt   DateTime? @map("deactivated_at")
  // + email, password, names, emailVerifiedAt, lockout fields as today
}

model Customer {    // storefront only
  // email, password, names, emailVerifiedAt, lockout fields
  // later: addresses, cart, wishlist, marketing consent
  // deliberately NO role and NO link to User — see decision 1
}
```

`roleRights` becomes staff-only. Customers do not participate in the rights system at all, which
removes a whole category of "did we remember to give CUSTOMER that right?" bugs.

---

## Four decisions that will bite if taken by instinct

### 1. Two credentials per human — and do **not** link the tables

A staff member who shops has a `User` row and a `Customer` row: two passwords, two reset flows,
two lockout counters. This is how Shopify and Magento work. Accept it deliberately rather than
discovering it in week three.

The instinct is to add `Customer.userId` and "keep them in sync". Resist it. The moment they are
linked you have to answer *"does deactivating the User affect the Customer?"* — and you are back
to the coupling the split exists to remove, with the added joy of two rows that can disagree.

Same email in both tables is fine and means nothing. They are different principals.

If reporting later needs "show me this staff member's orders", add a **nullable `staffUserId` on
`Customer`, documented as reporting-only with no authentication meaning**, and never read it in an
auth path. Not now.

### 2. Separate JWT secrets, not just a `principal` claim

`JWT_ADMIN_SECRET` and `JWT_CUSTOMER_SECRET`, two passport strategies, two `auth()` wrappers.

With separate secrets, a customer token presented to the admin API fails **signature
verification**. With one shared secret and a `principal: "customer"` claim, it fails only if
somebody remembered to check the claim on that particular route — and that check is invisible at
the route definition, which is exactly the failure mode already fixed once in this codebase (see
"Second thing" below).

Best safety-per-line in this whole design.

### 3. `Session` and `Token` are the real work

Both currently FK to `User` with `onDelete: Cascade`, and both now have to serve two principals.
Two ways:

- **Two tables each** (`sessions` / `customer_sessions`, `tokens` / `customer_tokens`). Duplicated,
  but the foreign keys stay real, the cascade stays real, and the cleanup cron stays trivial.
- **One table with nullable `userId` / `customerId`** plus a CHECK that exactly one is set. Prisma
  cannot express that CHECK, so it is hand-written SQL in the migration — and without it the table
  silently permits rows belonging to both principals or neither.

**Take two tables.** This is a boilerplate; the next person to read it should not have to hold a
polymorphic invariant in their head. `File.uploadedById → User` is already correct and does not
change — uploads are staff work.

### 4. Rename `User`, now

If `User` means staff-only, `req.user` becomes a trap: every developer reads it as "the logged-in
person", and half the time that person is a Customer. Rename the model to `AdminUser` (or
`Staff`), and use `req.staff` / `req.customer`.

Twelve files import the `User` type today. This is cheap this week and permanently expensive from
the moment the first product module copies the convention.

### Also: namespace the routes from day one

`/api/admin/*` and `/api/store/*`. Costs nothing now, and it is what allows different rate limits,
CORS origins and IP rules on the two surfaces at the edge later. Retrofitting a path prefix after
clients exist is a breaking change.

---

## The thing that will bite you first, whatever the table layout

**The JWT never touches the database.** `src/config/passport.ts:40`:

```ts
return done(null, { id: payload.sub, role: payload.role });
```

The role on every authenticated request comes straight out of the signed token. There is no user
lookup. So *adding a status column changes nothing about live traffic* — a deactivated admin keeps
full admin rights until their access token expires, for up to `JWT_ACCESS_EXPIRATION_MINUTES`.
If you are firing someone, that is the window that matters.

Three mitigations, and you want the first two always:

1. **Revoke sessions on deactivation** — `sessionService.revokeAllForUser(userId)`. Kills the
   refresh token so the session cannot be extended. Does **not** kill the access token already in
   their browser.
2. **Re-check at refresh.** `handleRefreshToken` already re-reads the user and re-signs with the
   current role (`auth.controller.ts:235`), so it will pick up a demotion for free — but it must
   also refuse outright when the account is deactivated *and* the route needs staff rights. With
   (1) and (2), the exposure is bounded by the access-token TTL.
3. **A `requireActiveStaff` middleware that reads the database**, mounted only on back-office
   routes. Costs one query per admin-panel request and makes deactivation instant. The storefront
   stays DB-free and fast, the privileged surface is correct. This is the split I would make
   rather than loading the user on every request.

---

## Second thing: the `auth` self-access bypass — FIXED 2026-11-05

`src/middlewares/auth.middleware.ts` used to read:

```ts
if (!hasRights && req.params.userId !== user.id) {
  return reject(new ApiError(httpStatus.FORBIDDEN, "Forbidden"));
}
```

When a route named its parameter `userId` and the value equalled the caller's own id, the rights
check was **skipped entirely**. Written so a customer could read their own profile without a
dedicated right; harmless on the routes that existed, fatal on the ones this document proposes:

```
PATCH /api/staff/:userId/role     ← STAFF promotes itself to ADMIN
PATCH /api/staff/:userId/status   ← and reactivates itself after dismissal
```

No route used `:userId` at the time, so the hatch was unreachable dead code — but
`validations/user.validation.ts` already carries unwired `updateUserRole`,
`deactivateAndReactivateUser` and `inviteUser` schemas keyed on exactly that parameter, waiting
to be wired up.

**What changed:**

- The `&& req.params.userId !== user.id` clause is gone. Rights are now the whole decision in
  `auth`.
- Ownership moved to an explicit, opt-in `requireSelf(param = "userId")` middleware, composed at
  the route where a reader can see it:

  ```ts
  router.get("/:userId", auth("read:own_profile"), requireSelf(), handler);
  ```

  Both must pass. Ownership can only narrow access, never widen it — which is the property the
  old code had backwards. It fails closed if mounted without `auth` (no `req.user`) or if the
  named parameter is absent.
- `tests/unit/auth-middleware.test.ts` (12 specs) pins it. Verified by restoring the old line:
  exactly three specs fail, all of them self-promotion cases.

**So the staff routes below do not need a renamed parameter for safety.** `:userId` is now
accurate — under the two-table decision every row in `users` is staff or admin, so the id in a
staff-management URL really is a user id.

---

## Third thing: `INVITED` means a user with no password

`User.password` is `String`, NOT NULL. An invited person has not chosen one yet. Two ways out:

**B1. Make `password` nullable.** Then `loginUserWithEmailAndPassword` must reject a
null-password account *before* it reaches `compareHash`. bcryptjs throws `Illegal arguments` on a
non-string hash, which `errorConverter` turns into a **500** — while a wrong password returns
**401**. That difference is a user-enumeration oracle that tells an attacker which addresses have
pending staff invites. Also: `resolveGoogleUser` matches on email and would log an invitee
straight in, bypassing the invite token entirely.

**B2. Do not create the `User` row until the invite is accepted.** Keep the pending invite in its
own table keyed by email. No half-built user rows, no nullable password, no login path to guard,
and the unique-email constraint does not block anything. The cost is that `INVITED` is then a
state of an *invite*, not of an *account* — which is arguably what it always was.

Under the two-table decision I lean **B1** after all, and the reason is the split itself: the
`users` table now holds only staff, so an `INVITED` row with no password is a handful of rows in
a small table rather than debris in the main customer table. `status = INVITED` already says
exactly why the password is null, which is the documentation B2 was buying. Make `User.password`
nullable, and write both guards above — the pre-`compareHash` rejection and the
`resolveGoogleUser` check — with tests, because the 500-vs-401 difference is the kind of thing
that survives review.

---

## Fourth thing: registration should enforce "customer only" in the service, not in Joi

Today `createUser` does:

```ts
const user = await prisma.user.create({ data: { ...userBody, password: hashedPassword } });
```

It spreads the request body into the insert. The only thing stopping `{"role":"ADMIN"}` is that
`authValidation.register` does not list `role` and Joi rejects unknown keys by default. That holds
right now — but the guard lives in a different file from the risk, and it dies the moment someone
adds `stripUnknown` or `allowUnknown` to the validate middleware, or writes a second registration
path and forgets.

Make it structural: `createUser` should take an explicit parameter object and set the role itself,
so there is no body-shaped hole to pour a role through.

Under the two-table decision this is mostly free: storefront registration writes to `Customer`,
which has no `role` column to escalate into. Keep the explicit-parameter rule anyway for the
invite-acceptance path, which *does* write to `users` and *does* set a role — that endpoint is
unauthenticated and grants back-office access, so the role must come from the invite record and
never from the request body.

---

## Fifth thing: an invite is a verified mailbox

Accepting an invite means clicking a tokenized link sent to that address — that **is** the
verification round-trip. Stamp `emailVerifiedAt` at acceptance.

This lets you delete a special case rather than add one. `emailVerificationExemptRoles = [ADMIN]`
in `constants.ts` exists because admins are "provisioned deliberately, so there is no mailbox to
prove". With invites, there is a mailbox and it gets proven, so the exemption can go and
`meetsEmailVerificationPolicy` becomes a rule with no exceptions.

(Note that `meetsEmailVerificationPolicy` and `hasVerifiedEmail` still have **zero call sites** —
see suggestion 1, steps 2–7. Nothing gates on email verification yet.)

---

## Sixth thing: last-admin lockout

The status endpoint must refuse to:

- deactivate **yourself** (locks you out mid-click), and
- deactivate or demote the **last ACTIVE ADMIN** (locks out everyone, permanently, with no
  recovery path short of a SQL console).

Check it inside a transaction — two admins deactivating each other simultaneously will both pass a
naive count-before-update.

---

## Proposed API surface

New rights on **ADMIN only**: `read:staff`, `manage:staff`. STAFF gets neither — staff cannot
invite staff.

| Route | Who | Does |
|---|---|---|
| `POST /api/admin/staff/invites` | `manage:staff` | `{email, role, firstName, lastName}` → invite row + `INVITE` token → email |
| `POST /api/admin/staff/invites/accept?token=` | public | `{password}` → set password, `ACTIVE`, stamp `emailVerifiedAt`, delete token. Role comes from the invite row, never the body |
| `POST /api/admin/staff/invites/:inviteId/resend` | `manage:staff` | new token, invalidate the old |
| `DELETE /api/admin/staff/invites/:inviteId` | `manage:staff` | revoke a pending invite |
| `GET /api/admin/staff` | `read:staff` | list + filter by status |
| `PATCH /api/admin/staff/:userId/status` | `manage:staff` | `ACTIVE ↔ DEACTIVATED`, revoke sessions on deactivate |
| `PATCH /api/admin/staff/:userId/role` | `manage:staff` | `STAFF ↔ ADMIN` |

The invite token reuses the existing `Token` table and `validateStoredToken` — add `INVITE` to the
`TokenTypes` enum. Follow the reset-password precedent for single use: delete the stored row on
acceptance (`tokenService.deleteTokens(userId, INVITE)`), so a link cannot be replayed.

Rate-limit `accept` by IP. It is an unauthenticated endpoint that grants admin rights, which makes
it the single most attractive target in the system.

### State machine

```
(no row) --invite--> INVITED --accept--> ACTIVE <--reactivate--> DEACTIVATED
                        |                                              |
                     revoke                                      (never auto-expires)
                  (row deleted)

The Customer table is not in this diagram, and that is the point: nothing here can
reach it. An ex-employee keeps shopping because their storefront account was never
part of the employment lifecycle in the first place.
```

`DEACTIVATED → ACTIVE` does **not** re-send an invite. They already have a password and a proven
mailbox; re-inviting would reset a credential that was never compromised.

---

## Open questions for you

1. **Rename `User` to `AdminUser` / `Staff`?** Decision 4 above argues yes and argues for doing
   it before the first product module copies the convention. Twelve files import the type today.
2. **Do invites expire?** I would say yes, 7 days, reusing `JWT_*_EXPIRATION` config style. An
   invite link to an ADMIN account that works forever is a long-lived credential sitting in an
   inbox.
3. **Can an ADMIN invite another ADMIN,** or only the first admin (from the seed) can? Simplest is
   yes, with the last-admin guard above.
4. **What does a deactivated staff member see at the admin login?** Their `User` row still
   exists, so a correct password is not the problem — `status` is. A generic "invalid
   credentials" leaks nothing but confuses an ex-employee's handover; an explicit "this account
   has been deactivated" is kinder and tells an attacker that the address is a real staff
   address. I lean generic on the admin app, where the attacker payoff is highest. Their
   storefront account is a different table and is untouched either way.
5. **Do staff get a customer account automatically when invited?** No, in my view — creating a
   `Customer` row nobody asked for means an unused password and an unexplained row. Let them
   register on the storefront like anyone else if they want to shop.
