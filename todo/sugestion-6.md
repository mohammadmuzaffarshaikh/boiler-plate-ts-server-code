# Suggestion 6 — Password reset has no delivery, and no production user can recover an account

**Status:** design only — the gap is live in `main`. Raised by a code review on 2026-11-07.
**Raised:** 2026-11-07
**Depends on:** a RESET_PASSWORD template. The transport itself already exists (`src/services/email.service.ts`, `docs/decisions.md` §16); [sugestion-5](./sugestion-5.md) is where the template store is designed, but this does not have to wait for it — a hardcoded template unblocks it today.
**Blocks:** nothing in code. It blocks *operating* a production deployment, which is worse.

## The gap

`POST /api/app/auth/forgot-password` builds a working reset link and then drops
it on the floor:

```ts
resetPasswordLink = `${config.SITE_URL}/reset-password?token=${resetPasswordToken}`;

// TODO: send `resetPasswordLink` by email instead of returning it.
```

— `src/controllers/auth.controller.ts`, `forgotPassword`

The link is returned in the response body only when `ENV !== "production"`. So
in production the endpoint:

1. creates a real, live RESET_PASSWORD token row,
2. builds a URL nobody will ever see,
3. answers `200 { message: "If an account exists for that address, a password
   reset link has been sent." }`.

Every part of that sentence is false in production except "If an account
exists". Nothing is sent. Nothing is logged. The token sits in `tokens` until
the nightly sweep deletes it.

`src/services/email.service.ts` is complete, tested, and **imported by nothing**
— `services/index.ts` re-exports it and no caller exists anywhere in `src/`.

## Why it matters more than a missing feature

Password reset is the documented recovery path for the account lockout in
`assertAccountMayAuthenticate`: lock an account with failed logins and the
instruction is to reset the password. In production that instruction leads
nowhere.

Combined with the two other facts about production identity, a locked-out
production account is **unrecoverable without database access**:

- `POST /auth/register` is mounted only in development (`docs/decisions.md` §14).
- There is no invite route yet (`docs/decisions.md` §3, [sugestion-3](./sugestion-3.md)).
- The seed creates the first ADMIN and then refuses to touch it again
  (`prisma/seed.ts`, §29) — by design, so a redeploy cannot roll a password
  back, which also means it is not a recovery tool.

The last point is worth stating plainly, because it is the current answer and
it is a bad one: **today the only way to recover a locked-out production
account is to clear `lockUntil` / `loginAttempts` in the database by hand**, or
to delete the user and re-run the seed with new `SEED_ADMIN_*` values.

## What to build

1. **A RESET_PASSWORD template.** Subject, HTML, one variable:
   `resetPasswordUrl`. Hardcode it in `src/utils/templates/` if
   [sugestion-5](./sugestion-5.md) has not landed — the template store is a
   better home, not a prerequisite.

2. **The send itself**, in `forgotPassword`, where the TODO is:

   ```ts
   await emailService.sendEmail({
     to: user.email,
     subject: "Reset your password",
     html: renderTemplate(resetPasswordTemplate, { resetPasswordUrl: resetPasswordLink }),
   });
   ```

3. **Decide what a send failure does.** This is the only real design question
   here, and it is the one that will be got wrong if it is not decided
   up front.

   The endpoint must keep returning the same 200 whether or not the account
   exists — that is deliberate and documented, and a 500 on a failed send
   re-opens the enumeration oracle the identical-response design exists to
   close, because "500" versus "200" tells the caller the address was real.

   So: **catch, log at error level, still answer 200.** `EmailSendError`
   already carries the provider status. The user sees the same message; the
   operator sees the failure in the log. An unlogged silent failure is what
   this document is about, so the log line is not optional.

4. **Remove the development-only branch** once the send works. Returning the
   link in the body is a test affordance for a flow that could not otherwise
   be exercised; once mail is real, the integration specs should go through
   the same path production does.

5. **While here:** `AUTH_REQUIRE_EMAIL_VERIFICATION` is off for the same
   reason — nothing sends the verification mail either
   (`src/config/config.ts`). The same template-plus-send work unblocks both,
   and [sugestion-1](./sugestion-1.md) step 3 is the other caller waiting on it.

## Already done, so it does not surprise anyone later

`SITE_URL` is now **required when `NODE_ENV=production`** and validated as a
URI (`src/config/config.ts`, §30). It had no default and no production check,
so the first thing this feature would have shipped was a mail containing
`undefined/reset-password?token=<live token>` — a working single-use credential
in a dead link, sent to the one person who by definition cannot get in another
way. That is closed; nothing in this document has to remember it.
