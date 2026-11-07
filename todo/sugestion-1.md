# Suggestion 1 — Guest checkout, and linking guest orders to an account later

**Status:** partially implemented — prerequisites landed 2026-11-04, claim logic still to build
**Raised:** 2026-11-04
**Depends on:** order schema (not yet written), email sending via Resend (not yet wired)
**Blocks:** nothing — can be built incrementally

## Description

How the platform should handle a shopper who buys **without an account**, and what
happens when that person later registers or signs in and expects to see those
orders, track them, or request a refund.

The short version: **a guest is not a user.** No `User` row is created at
checkout. The order itself is the anchor, carrying the email, phone and address
that were collected. When the shopper later proves control of that email, their
past orders are linked to the new account.

The critical constraint — the reason this needs writing down rather than
improvising at implementation time — is that the link must be triggered by a
**verified email**, never by a successful login.

---

## Why not create a `User` row for each guest

1. It fills the user table with rows that cannot log in, making `authProvider`
   and `password` meaningless for a growing share of records.
2. It collides with `email @unique` the day that guest actually registers. This
   is a likely event, not an edge case.
3. It forces `User.password` to become nullable, which breaks an invariant the
   Google OAuth flow currently relies on: because there is no auto-provisioning,
   every user reaching `loginUserWithGoogle` already has a password, so
   `compareHash` never sees a null.

## The attack this design prevents

`POST /auth/register` performs **no email verification** today. If guest orders
were linked on login by matching email:

1. A customer checks out as a guest using `victim@example.com`, leaving their
   phone, home address and order contents on the order.
2. An attacker registers an account with `victim@example.com`. It succeeds — the
   email is unique and nobody has claimed it.
3. They log in, the email matches, and they receive the victim's address, phone,
   full order history, and standing to request refunds and cancellations.

The attacker never needed access to the mailbox. Checkout *collects* an email;
it does not prove anything about it. Only a verification round-trip does.

---

## Prerequisites — DONE (2026-11-04)

Both additions have landed. They fit the existing `Token` model and its cleanup
cron with no new machinery:

```prisma
// prisma/schema/enums/token-types.prisma
enum TokenTypes {
  RESET_PASSWORD
  VERIFY_EMAIL      // added
}

// prisma/schema/models/user.prisma
  emailVerifiedAt DateTime? @map("email_verified_at")   // added
```

Roles were widened at the same time: `Role` is now `CUSTOMER | STAFF | ADMIN`,
defaulting to `CUSTOMER`.

**ADMIN is exempt from the verification gate**, which introduces a distinction
worth preserving — `src/utils/email-verification.ts` exposes two functions that
must not be used interchangeably:

| Function | Question it answers | Use for |
|---|---|---|
| `hasVerifiedEmail(user)` | Has the mailbox actually been proven? | **The claim below.** Anything authorised by the address itself. |
| `meetsEmailVerificationPolicy(user)` | May this account proceed? | Login and protected-route gates. Folds in the ADMIN exemption. |

An exempt ADMIN that never completed a round-trip returns `false` from
`hasVerifiedEmail` and `true` from `meetsEmailVerificationPolicy`. That is
deliberate: skipping a login gate is not evidence of mailbox ownership, and
`claimGuestOrders` must never fire on the strength of the exemption.
`emailVerifiedAt` is therefore never auto-stamped for admins.

**Google sign-in already satisfies the gate.** `src/config/google-client.ts`
asserts `email_verified` on the token payload, so a Google login can claim guest
orders immediately with no round-trip. Password registration cannot, until the
verification mail is actually sent — which lands naturally when Resend goes in.

## Order shape

```prisma
model Order {
  id      String  @id @default(uuid())
  number  String  @unique              // human-facing, e.g. ORD-2026-00042

  userId    String?                    // null until claimed
  email     String                     // immutable: who placed it
  phone     String?
  claimedAt DateTime? @map("claimed_at")

  // snapshots, not references — see below
  shippingAddress Json
  billingAddress  Json

  user User? @relation(fields: [userId], references: [id])

  @@index([email])
  @@index([userId])
}
```

`email` is kept even after claiming. It is the audit trail for *how* the order
was acquired, and it makes the claim idempotent and re-runnable.

### Snapshot, do not reference

The address on an order must be a copy, not a foreign key into the customer's
address book. If it is a reference, a customer editing their saved address
silently rewrites where last year's orders were shipped — destroying invoices,
tax records, and the evidence needed to contest a chargeback.

The same rule applies to item price, product name and tax rate: copy the values
onto the order line at purchase time. This is the most common e-commerce schema
mistake and it is unrecoverable after the fact.

## The claim

One function, called when an email **becomes verified** — not at login:

```ts
const claimGuestOrders = (userId: string, verifiedEmail: string) =>
  prisma.order.updateMany({
    where: { userId: null, email: verifiedEmail },
    data: { userId, claimedAt: new Date() },
  });
```

Call sites:

- email-verification success (password registration)
- Google first sign-in
- verified email **change** on an existing account

The `userId: null` guard makes the operation idempotent and prevents it ever
reassigning an order that already belongs to someone else. Claims should be
logged — they are exactly what an audit will ask about when a dispute arrives.

## Order access and refunds

Two principals can act on an order, and they authenticate differently:

| Principal | How it is authorised |
|---|---|
| Logged-in owner | `order.userId === req.user.id`, via the existing `auth()` middleware |
| Guest still holding the order | Order number **plus** email; for anything that moves money, a one-time token mailed to that address |

Order number + email is acceptable for "where is my parcel". It is **too weak
for a refund**: order numbers are often guessable and email addresses are
semi-public. The refund path should mint a short-lived token and email it. The
existing `Token` model and `src/utils/generate-otp.ts` already cover this.

Guest order lookup must be rate limited hard, keyed by email — it is an
enumeration oracle otherwise. Use `createRateLimiter` from
`src/middlewares/rate-limiter.middleware.ts`.

## Phone and address are not identifiers

Never link on either. Phone numbers are reused, shared across a household, and
mistyped, and will not have been verified. Addresses are worse — flatmates,
offices, parcel lockers. Both are order data, not identity.

**Email is the only link key, and only once verified.**

---

## Suggested implementation order

1. ~~`emailVerifiedAt` + `VERIFY_EMAIL` token type.~~ **Done 2026-11-04.**
2. Set `emailVerifiedAt` on Google sign-in, which already asserts
   `email_verified` — no email sending required.
3. Verification round-trip for password registration: issue a `VERIFY_EMAIL`
   token, stub the send for Resend, and stamp `emailVerifiedAt` on redemption.
4. `claimGuestOrders`, called from steps 2 and 3 and from verified email change.
5. Build `Order` with the snapshot fields above.
6. Guest order lookup endpoint, rate limited by email.
7. Refund request flow behind the one-time emailed token.

Steps 2–4 are self-contained and do not depend on the order schema existing —
`claimGuestOrders` can be written and left unreferenced until `Order` lands.
