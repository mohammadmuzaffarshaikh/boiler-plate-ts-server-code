/**
 * Fold an email address to its canonical, storable form.
 *
 * `users.email` is a case-sensitive unique index, so without a single
 * canonical form `Ada@Shop.example` and `ada@shop.example` are two accounts
 * for one mailbox. That is not a cosmetic duplicate: the second registration
 * succeeds, the owner cannot sign in with the casing they remember, and
 * `forgot-password` answers its deliberately-generic 200 while sending
 * nothing, because the lookup missed. Google sign-in already lowercases the
 * address it gets from the ID token (`config/google-client.ts`), so an
 * account stored in mixed case can never be matched or linked by it either.
 *
 * **Lower-case the whole address, not just the domain.** RFC 5321 §2.4 does
 * reserve case sensitivity in the local part to the receiving host, but no
 * mail provider in practice treats `Ada@` and `ada@` as different mailboxes,
 * and every one of the failures above is caused by pretending otherwise.
 *
 * **Nothing else is folded.** No stripping of dots, no cutting a `+tag`
 * suffix. Those are provider-specific rewrites — `a.b@gmail.com` and
 * `ab@gmail.com` are one mailbox at Google and two almost anywhere else — so
 * applying them here would merge accounts that are genuinely distinct. Plus
 * addressing is also how people legitimately separate their own sign-ups.
 *
 * Applied at every write and every lookup in `services/user.service.ts` and
 * `utils/helpers.ts`, which is the only place the rule can be enforced for
 * everyone: a Joi schema cannot do it, because `validate` discards Joi's
 * coerced value and so can reject but never transform.
 */
export const normalizeEmail = (email: string): string =>
  email.trim().toLowerCase();
