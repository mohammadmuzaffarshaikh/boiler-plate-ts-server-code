# Suggestion 5 — One template store for email, WhatsApp and SMS

**Status:** design only — nothing built. Raised by the user on 2026-11-06.
**Raised:** 2026-11-06
**Depends on:** nothing in this repo. The schema can land before `Order`, before `Customer`, and before any provider is chosen.
**Unblocked 2026-11-06:** the email transport and the Handlebars renderer now exist (`src/services/email.service.ts`, `src/utils/render-template.ts`, `docs/decisions.md` §16). `extractTemplateVariables` is already the mechanism for the variable contract below.
**Blocks:** [sugestion-2](./sugestion-2.md) step 3 (the `email` queue's first real job needs something to render), the verification mail in [sugestion-1](./sugestion-1.md) step 3, and the invite mail in [sugestion-3](./sugestion-3.md).

## Description

Where notification templates live, and how one schema holds three channels whose
content works nothing alike. The sibling api repo has an email-only version of
this (`email_templates`, Handlebars, admin CRUD) and it is a reasonable starting
point — but it is email-shaped in ways that break the moment WhatsApp is added,
and it carries one silent failure that should not be copied.

The opening suggestion was a single table with `type = EMAIL | WHATSAPP | MSG`.
The discriminator is right. Where the channel-specific *fields* live is the part
worth deciding deliberately.

---

## The thing that actually drives the design

The three channels do not differ by which columns are null. They differ by **who
owns the content**:

| Channel | Who holds the body | What this API stores |
|---|---|---|
| Email | **You.** Render Handlebars → HTML → hand to the provider. | The actual content |
| WhatsApp | **Meta.** You register a template, it is *approved*, and at send time you submit `{ name, language, components: [{ parameters: [...] }] }` — never the body. | A **reference**, plus how to fill its slots |
| SMS | **You.** Plain text, segment-counted. No subject, no attachments. | The actual content |

A WhatsApp row is therefore not "an email template without a subject". It is a
pointer to a remote artifact that has:

- an approval lifecycle — `PENDING / APPROVED / REJECTED / PAUSED` — and a
  rejection reason you did not write and cannot fix locally;
- a language code that is **part of its identity** at Meta, not a display
  preference;
- a category (`MARKETING / UTILITY / AUTHENTICATION`) that changes what the
  message *costs*;
- **positional** placeholders — `{{1}}`, `{{2}}` — not the named ones Handlebars
  uses. (Named parameters exist in newer Cloud API versions; positional is still
  what most BSPs expose.)

None of that has anywhere honest to live in a table shared with email.

---

## Three layouts, and why the third wins

### A. One table, `type` + nullable columns

One model, one query, no joins. The cost is that `subject` becomes nullable, so
the database can no longer tell you an email template has one — the invariant
moves into a comment, which is where invariants go to die. Every consumer
null-checks fields that are structurally guaranteed for its own channel. The
table grows a column per channel added, and `status` / `providerRef` / `category`
sit as dead NULLs on every email row.

### B. One table, `type` + `content Jsonb`

No nullable sprawl and infinitely flexible. The cost is that PostgreSQL
validates nothing, Prisma types the column `JsonValue`, and every read needs a
guard. This repo is a boilerplate — whatever shape is set here gets copied into
every module that follows, so a structure that defers all validation to the
reader is a footgun handed to the next five developers.

### C. Supertype + per-channel child tables — **recommended**

A channel-agnostic parent holds the identity; one child table per channel holds
real, `NOT NULL`, queryable columns. "An email template always has a subject"
becomes a constraint rather than a convention, and Prisma hands out three
precise types instead of one with eight optionals.

**Cost / consequence:** one join on lookup (a small, cacheable table); adding a
channel is a new model and a migration rather than a new enum value; and
`getTemplate(key, channel)` needs a `switch`. That switch is not incidental
complexity — the *render* step already differs per channel (Handlebars → HTML
versus building a `components` array), so the branch exists either way. Better
it be visible at the lookup than buried in the sender.

**The shape to actually ship is C with a narrow JSON column only where the shape
is genuinely the provider's** (WhatsApp buttons and components). Do not JSON-blob
what you query or validate; do JSON the opaque provider payload.

---

## Naming

- **`channel`, not `type`.** `type` does not say what it discriminates, and this
  table will acquire a second kind of "type" (header type, media type) within a
  week of being built.
- **`SMS`, not `MSG`.** All three channels are messages; `MSG` reads as the
  general case rather than as one member of the set.

---

## Shape

```prisma
// prisma/schema/enums/notification-channel.prisma
enum NotificationChannel {
  EMAIL
  WHATSAPP
  SMS
}
```

```prisma
// prisma/schema/models/notification-template.prisma

/// One row per EVENT, not per channel. ORDER_SHIPPED is one template with up
/// to three channel bodies hanging off it, sharing one variable contract.
model NotificationTemplate {
  id          String  @id @default(uuid())
  key         String  @unique                  // ORDER_SHIPPED, VERIFY_EMAIL, INVITE_STAFF
  name        String
  description String?
  variables   Json    @default("[]")           // the contract — see below
  isActive    Boolean @default(true) @map("is_active")

  email    EmailTemplate[]
  whatsapp WhatsAppTemplate[]
  sms      SmsTemplate[]

  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt      @map("updated_at")

  @@map("notification_templates")
}

model EmailTemplate {
  id         String  @id @default(uuid())
  templateId String  @map("template_id")
  locale     String  @default("en")
  subject    String                            // NOT NULL — the entire point of splitting
  bodyHtml   String  @map("body_html")
  bodyText   String? @map("body_text")         // plaintext alternative: spam scoring + a11y
  fromName   String? @map("from_name")         // null = fall back to the config default
  fromEmail  String? @map("from_email")
  replyTo    String? @map("reply_to")
  isActive   Boolean @default(true) @map("is_active")

  // Cascade is correct HERE, unlike File.uploadedBy (which is SetNull): the
  // child is a *part* of the parent, not an independent record that should
  // outlive it. Deleting the event deletes its bodies.
  template    NotificationTemplate @relation(fields: [templateId], references: [id], onDelete: Cascade)
  attachments TemplateAttachment[]

  @@unique([templateId, locale])
  @@map("email_templates")
}

model WhatsAppTemplate {
  id              String   @id @default(uuid())
  templateId      String   @map("template_id")
  locale          String   @default("en")      // a Meta language code: en, en_US, hi
  providerRef     String   @map("provider_ref") // Meta template name, or Twilio Content SID
  category        WhatsAppCategory              // MARKETING | UTILITY | AUTHENTICATION
  status          WhatsAppTemplateStatus @default(PENDING)
  rejectionReason String?  @map("rejection_reason")
  headerType      WhatsAppHeaderType? @map("header_type")   // TEXT | IMAGE | VIDEO | DOCUMENT
  headerFileId    String?  @map("header_file_id")

  /// A COPY of the approved body, so an admin can read it in the dashboard.
  /// Editing it changes NOTHING a customer receives — Meta holds the real one.
  /// Treat it as a cache of a remote value, refreshed by syncedAt.
  bodyPreview     String   @map("body_preview")

  /// ["orderNumber", "trackingUrl"] -> {{1}}, {{2}}. The bridge from this
  /// codebase's named context to Meta's positional slots. Without it, somebody
  /// reordering the template at Meta silently swaps two values in every
  /// message that goes out, with no error anywhere.
  parameterMap    String[] @map("parameter_map")

  components      Json?                         // opaque provider payload: buttons etc.
  syncedAt        DateTime? @map("synced_at")

  template NotificationTemplate @relation(fields: [templateId], references: [id], onDelete: Cascade)

  @@unique([templateId, locale])
  @@unique([providerRef, locale])
  @@map("whatsapp_templates")
}

model SmsTemplate {
  id         String  @id @default(uuid())
  templateId String  @map("template_id")
  locale     String  @default("en")
  body       String                            // plain text. No subject, no attachments.
  senderId   String? @map("sender_id")         // alphanumeric sender, where the carrier allows one

  template NotificationTemplate @relation(fields: [templateId], references: [id], onDelete: Cascade)

  @@unique([templateId, locale])
  @@map("sms_templates")
}
```

### Why `locale` is in the unique key from day one

Even if every row is `"en"` for the next year. WhatsApp *mandates* language as
part of template identity, so the column is not optional there — and retrofitting
it into the uniqueness constraint later changes every lookup written in the
meantime. It costs nothing today and is expensive on the day it is needed.

### The rule the status column buys

**Never dispatch a WhatsApp template that is not `APPROVED`** — checked in the
service, before anything is enqueued, not in the worker. A rejected or paused
template fails at the provider with an error that reads like a transport fault,
burns all five BullMQ attempts, and tells nobody what is actually wrong.

---

## Attachments are three different things wearing one word

A single shared `attachments` column would lie about all three:

1. **Per-send, dynamic** — the invoice PDF for *this* order. The common case by
   far. Belongs in the job payload as a `fileId`, never on the template.
2. **Per-template, static** — a terms PDF on every welcome mail. A join table
   against the existing `File` model:

   ```prisma
   model TemplateAttachment {
     id              String  @id @default(uuid())
     emailTemplateId String  @map("email_template_id")
     fileId          String  @map("file_id")
     displayName     String? @map("display_name")
     contentId       String? @map("content_id")  // inline images: <img src="cid:...">
     @@unique([emailTemplateId, fileId])
     @@map("template_attachments")
   }
   ```

   `contentId` matters because an inline image is a different MIME disposition
   from a real attachment, and a template that wants a logo in the body wants
   the former.

3. **WhatsApp's "attachment" is not an attachment.** It is a *header media
   component* — at most one, typed, and its type must match what Meta approved.
   It is sent as a public URL or a media handle, not as a MIME part. A document
   header also carries its own filename, separate from the file's own name.

**Trap to write down before this is built:** any `File` row referenced by a
template must be flipped to `IN_USE`, or `src/jobs/file-cleanup.job.ts` deletes
the object out from under a live template once the grace period passes. A static
attachment is precisely the file that nothing touches for weeks.

---

## The variable contract — do not copy the api repo here

In the sibling api repo, `compileTemplate` catches a Handlebars failure and
**returns `""`**. A typo'd `{{resetLnk}}` ships a blank email, logs nothing a
human reads, and looks like a delivery problem. The scar tissue is visible at
the call site: `forgotPassword` passes the same URL twice, as `resetPasswordUrl`
*and* as `resetLink`, because nobody could tell which name the stored template
actually used.

The `variables` column on the parent is what removes that whole class of bug:

```jsonc
[ { "name": "orderNumber", "required": true,  "example": "ORD-1024" },
  { "name": "trackingUrl", "required": true,  "example": "https://…" },
  { "name": "firstName",   "required": false, "example": "Asha" } ]
```

Three things follow from it:

- `renderTemplate()` checks required variables against the supplied context and
  throws `ApiError` — before the provider is called, rather than after a
  customer receives an empty message.
- Compile with `Handlebars.compile(src, { strict: true })`, so an unknown key
  throws instead of rendering empty.
- A preview endpoint renders the template with the `example` values. Admins see
  the message before saving, and typos die at edit time instead of at send time.

It also gives `WhatsAppTemplate.parameterMap` something to validate against:
every name in the map must exist in the parent's `variables`, checked on write.

---

## While the schema is open: the dispatch log

[sugestion-2](./sugestion-2.md) specifies `OrderNotification`, unique on
`[orderId, channel, kind]`, because BullMQ's `jobId` is not idempotency. That
reasoning is correct and unchanged — but the table is order-shaped, and the
first three things that will use templates (email verification, staff invites,
password reset) have no `orderId`. Since templates land first, generalise it:

```prisma
model NotificationDispatch {
  id              String   @id @default(uuid())
  channel         NotificationChannel
  templateKey     String   @map("template_key")
  dedupeKey       String   @unique @map("dedupe_key")  // "order:<uuid>:shipped:email"
  status          DispatchStatus
  providerId      String?  @map("provider_id")
  renderedSubject String?  @map("rendered_subject")
  error           String?
  sentAt          DateTime? @map("sent_at")
  createdAt       DateTime @default(now()) @map("created_at")

  @@map("notification_dispatches")
}
```

Same property as sugestion-2's table — insert first, treat a unique violation as
"already sent, nothing to do" — but it works for every channel and every event,
and it survives job removal, stalled re-runs and a Redis flush exactly as the
original does.

It also solves template versioning cheaply. Storing the **rendered** output on
the dispatch row reproduces what a customer actually received, without building
an immutable-version subsystem for the templates themselves.

**This supersedes `OrderNotification`.** That is a change to a written decision,
so it needs an entry in `docs/decisions.md` saying so — not a quiet substitution
that leaves two documents describing different tables for the same job.

---

## Open questions for you

1. **DB-stored or code-stored templates?** The api repo chose the database, and
   the cost is real: a template edit has no pull request, no diff, no rollback,
   and cannot be unit-tested. The hybrid I lean towards is templates seeded from
   code by `key` through `prisma/seed.ts`, with the DB row editable afterwards —
   a fresh environment works out of the box, and a broken edit is one re-seed
   away from being fixed.
2. **Which WhatsApp BSP?** This genuinely changes the schema. Meta's Cloud API
   identifies a template by *name + language*; Twilio by a *Content SID*;
   Gupshup and Interakt differ again. `providerRef` is deliberately vague until
   this is picked, and should be narrowed once it is.
3. **Is `locale` a real requirement, or only WhatsApp's?** Worth keeping either
   way for the reason above, but if the storefront is genuinely multi-language
   it changes the lookup signature and the admin UI, not just the constraint.
4. **Does the parent need an explicit list of configured channels,** or is the
   absence of a child row a good enough answer? I lean on absence — it *is*
   "not configured for that channel", and a service returning `null` matches how
   the rest of this codebase answers "not found".
5. **Who may edit templates?** A new `manage:templates` right on ADMIN only,
   mounted at `/api/app/notification-templates`. Staff reading them is probably
   fine; staff editing the password-reset mail is a phishing vector with a
   trusted From address.

---

## Suggested implementation order

1. The enums and the four models, with a migration. No API yet.
2. `prisma/seed.ts` entries for the templates that already have a caller waiting:
   `VERIFY_EMAIL`, `RESET_PASSWORD`, `INVITE_STAFF` — email channel only.
3. `src/services/notification-template.service.ts` — lookup by `(key, channel,
   locale)`, the variable-contract check, and `renderTemplate` with
   `strict: true`. Unit-tested without a database, since none of it needs one.
4. Admin CRUD under `/api/app/notification-templates`, plus the preview endpoint.
   Follow `/new-module` — all eleven steps, including the Swagger object.
5. `NotificationDispatch` and the `docs/decisions.md` entry retiring
   `OrderNotification`.
6. Only then the WhatsApp child: it is the one piece blocked on a provider
   choice, and everything above is useful without it.

Steps 1–4 are self-contained and depend on no provider, no `Order` and no
`Customer`.
