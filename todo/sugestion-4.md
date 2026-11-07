# Suggestion 4 — Shopper-submitted media: review photos/videos and return documents

**Status:** design only — nothing built. Raised by the user on 2026-11-06, to be built as separate APIs.
**Raised:** 2026-11-06
**Depends on:** the `Customer` table (`todo/sugestion-3.md`), `Order` schema, `Review` and `ReturnRequest` models — none of which exist
**Blocks:** nothing. The staff upload module (`/api/app/files`) already works and is unaffected.

## The requirement

Two new upload surfaces, both on the **storefront**, both used by shoppers rather than staff:

1. **Review media.** A customer leaving a product review may attach images and videos.
2. **Return / delivery-problem documents.** When something arrives damaged or a return is
   requested, a customer may submit photos and documents supporting the claim.

These are new APIs under `/api/store`, not new folders on the existing staff route.

---

## Why this is not "add two folders and reuse the endpoint"

`POST /api/app/files` today is a staff tool, and almost every assumption behind it inverts when
the uploader is a shopper. Taken one at a time:

| `/api/app/files` assumes | For shopper uploads |
| --- | --- |
| The caller is in `users` (staff) | The caller is in `customers` — a different table, a different token, a different signing secret |
| Any staff may delete any file | A shopper may only ever touch **their own**, and only while it is still theirs to touch |
| Rights alone decide (`auth("upload:files")`) | Ownership decides, which `auth` deliberately does not do |
| Everything uploaded is public catalogue content | A return document is **not public** — see below |
| The uploader is trusted and few | The uploader is anonymous-ish, numerous, and occasionally hostile |
| A file may sit `UNUSED` for a day | A review draft is abandoned far more often than a product draft |

So: separate routes, separate rights, separate folders, and at least one piece of the storage
layer that does not exist yet.

---

## The things that actually need deciding

### 1. Return documents must not be publicly readable — this is the big one

Everything the file module stores today goes to `R2_PUBLIC_URL` and is readable by anyone with
the link. For product images that is the entire point.

A return document is the opposite. It will routinely contain an invoice with a name and a home
address, a photo of a damaged parcel with a shipping label in frame, sometimes an ID document
because a support agent asked for one. An unguessable URL is not access control: it is one
forwarded email, one support-chat paste or one `Referer` header away from being public, it is
cached by every proxy in between, and it cannot be revoked.

Three ways out, in my order of preference:

1. **A second bucket, private, fetched through the API.** `GET /api/store/returns/:id/documents/:fileId`
   checks the session, checks ownership, then streams from R2 with the server's credentials.
   Simple to reason about, nothing new to sign, and the authorization check lives where every
   other one does. Costs the API the bandwidth.
2. **A second bucket, private, with short-lived presigned GETs.** The API signs a URL valid for a
   minute or two and returns it. R2 serves the bytes, so the API does not carry them. aws4fetch
   can already sign this (`aws4fetch` presigning is a `sign()` call with `aws: { signQuery: true }`),
   so it is a small addition to `storage.service`. The cost is that a leaked URL is live for its
   whole TTL and cannot be withdrawn.
3. ~~Same bucket, rely on the key being unguessable.~~ Not acceptable for this content.

Either of the first two means `buildPublicUrl` is no longer universal, so `File.url` stops being
a column you can always hand to a browser. That is a schema-shaped decision and is the reason
this is written down before anything is built.

**Review media, by contrast, is public** — it is shown to every shopper on the product page — and
can use the existing public bucket.

### 2. Who owns a file

`File.uploadedById` is a nullable FK to `User`. A shopper is not a `User`, so this does not fit,
and the identity split in `docs/decisions.md` §2 says it must not be made to fit.

Options:

- **Two nullable columns** — `uploadedById → users`, `uploadedByCustomerId → customers` — with a
  database `CHECK` that exactly one is set. Honest, queryable, and both FKs stay real. My
  preference.
- One `ownerType` + `ownerId` pair. Loses referential integrity, which is a bad trade for the
  one join it saves.
- A separate `CustomerFile` model. Duplicates the whole lifecycle, the sweep and the storage
  service for no gain.

### 3. Ownership, not rights

`auth(...rights)` grants on rights alone — the self-access hatch was removed on 2026-11-05
precisely because it widened access. The note in `.claude/CLAUDE.md` is the rule to follow here:
**ownership may narrow access, never widen it.** So a storefront route needs `auth` for "is this
a logged-in shopper" and then an explicit ownership check (`requireOwnFile`, or the service
scoping its query by customer id) for "is this theirs".

There is a second, subtler scope: *when* it is theirs. A review photo should stop being
deletable by the customer once the review is published, or a shopper can gut a review they were
paid to leave. A return document should stop being deletable once the claim is decided, or the
evidence disappears the moment it stops being convenient. That suggests the ownership check is
"your file **and** the thing it is attached to is still in a mutable state", not just "your file".

### 4. Entitlement: what may this file be attached to

A customer may upload a review photo for a product they never bought, or attach a document to
someone else's return, unless something stops them. The upload route cannot check this on its
own — at upload time there may be no review yet. So the check belongs at **attach** time:
`markFilesInUse` gets a caller and a target, and the review/return service verifies that the
order, the review and the file all belong to the same customer before it flips the status.

### 5. Abuse, quota and moderation

Public upload is a different threat model from staff upload.

- **Per-customer quota**, not just a rate limit: N files per review, M per return, and a cap on
  total bytes per customer per day. `uploadLimiter` alone only slows one IP down.
- **Much smaller caps.** `UPLOAD_MAX_VIDEO_MB=95` exists for product footage shot by the team. A
  review video has no business being 95 MB; 20–30 MB is generous. These want their own settings
  rather than sharing the staff ones.
- **Moderation state.** Review media is user-generated content shown to other shoppers. It needs
  a `PENDING_REVIEW` state before it is publicly linked, or the first thing a storefront
  displays will eventually be something nobody wants on it. This also matters legally: an
  image-hosting surface open to the public carries reporting obligations in several
  jurisdictions, and "we did not know" is easier to say when nothing was auto-published.
- **Document scanning.** Return documents are PDFs and Office files from strangers, handed to
  support agents who will open them. The container check refuses macro-enabled documents, which
  is the main thing, but a malware scan before a human opens one is worth costing out.

### 6. EXIF — a privacy bug waiting to happen

Nothing in the pipeline strips metadata today. A phone photo carries GPS coordinates, the device
serial and a timestamp. For a staff product shot that is harmless. For a customer's photo of a
damaged parcel in their hallway, publishing it on a public product page publishes their home
address, and they will have no idea.

**Any public shopper-submitted image must be stripped before it is served.** Two ways:

- Re-encode on upload. Needs an image library (`sharp`), which this project does not have, and
  costs CPU per upload.
- Serve only through Cloudflare Images transformations, which re-encode and drop metadata as a
  side effect. Free for the first 5,000 unique transforms a month and already the plan for
  thumbnails. Cheaper, but it only protects the transformed URL — the original object must then
  never be publicly linked, which means review media wants the private bucket too, with the
  public URL being the transform.

That second point is worth noticing early: it pushes review images toward the same private-bucket
shape as return documents, for a completely different reason.

### 7. Folders

Following the existing allowlist (`uploadFolders` in `src/config/constants.ts`):

| Folder | Content | Public? |
| --- | --- | --- |
| `review_images` | Customer photos on a product review | Yes, via transform (see §6) |
| `review_videos` | Customer video on a review | Yes |
| `return_documents` | Invoices, damage photos, claim paperwork | **No** |

The folder table currently carries one thing — which file categories are allowed. It will need a
second: **who may write there.** A shopper must not be able to upload into `product_images`, and
a staff route must not quietly accept `return_documents`. That is one more field on
`folderPolicy` (`audience: "staff" | "customer"`), checked against the authenticated identity.
Without it, the closed allowlist stops being a boundary the moment a second namespace uses it.

### 8. The sweep

`FILE_UNUSED_GRACE_HOURS` is 24, sized for a staff member who uploads images and saves the
product later that day. An abandoned review draft is far more common and has no reason to be
kept that long; a return document, on the other hand, should probably survive longer than 24
hours unattached, because a customer may upload evidence and submit the claim the next day.

The grace period likely wants to be per-folder rather than global.

---

## Suggested shape, if it is built as described

```
POST   /api/store/reviews/:reviewId/media     upload one image or video to a draft review
DELETE /api/store/reviews/:reviewId/media/:fileId
POST   /api/store/returns/:returnId/documents upload one document to an open claim
GET    /api/store/returns/:returnId/documents/:fileId   streamed, owner or staff only
```

Attachment is implicit in the path, which removes the "attach someone else's file" problem
entirely — far better than a free-floating `/api/store/files` plus a separate attach call.

Reuse, unchanged: `detect-file-type`, `detect-container-type`, `sanitize-filename`,
`upload.middleware`, `storage.service`, and the three-step crash-safe delete. What is new is a
private read path, a customer owner column, ownership checks, quotas, moderation state and
EXIF handling.

---

## Open questions for you

1. **Private reads: streamed through the API, or short-lived presigned URLs?** I lean streamed
   for return documents (revocable, one authorization path, no TTL to reason about) and
   transform-only public URLs for review media.
2. **Is review media moderated before it appears,** or published immediately and taken down on
   report? The first is safer and slower; the second needs a reporting flow that does not exist.
3. **How long do return documents live** after a claim is closed? They are evidence, so they
   probably outlive the sweep entirely and need a retention rule instead — which is also a
   data-protection question, not only a storage one.
4. **Does a shopper see their own uploads anywhere** (a "my returns" page), or are they
   write-only from the storefront's point of view? This decides whether the private read route
   is needed on day one.
5. **Separate bucket, or a prefix in the same one?** A separate bucket makes "public" and
   "private" a property of the credential rather than of a code path, which is much harder to
   get wrong later. It costs a second set of settings.
