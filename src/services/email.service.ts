import httpStatus from "http-status";
import type { CreateEmailOptions } from "resend";
import config from "../config/config";
import logger from "../config/logger";
import {
  getDefaultFrom,
  getResendClient,
  isEmailEnabled,
} from "../config/resend-client";
import ApiError from "../utils/api-error";
import { redactEmail } from "../utils/redact";

/**
 * Transactional email transport.
 *
 * This module sends a message that is already written. It does not know what
 * a template is, does not read the database, and does not decide what to say
 * — rendering happens in `utils/render-template`, and where templates live is
 * todo/sugestion-5.md. The split matters because this is the layer a BullMQ
 * processor will call (todo/sugestion-2.md), and a processor needs one thing
 * from it: a thrown error that says whether retrying is worth anything.
 */

/** Resend's documented ceiling: 40 MB per message, measured AFTER base64. */
const MAX_MESSAGE_BYTES = 40 * 1024 * 1024;

/**
 * How long one send may take before it is abandoned.
 *
 * The Resend SDK sets NO timeout. It calls `fetch`, and Node's default is
 * effectively "wait as long as the socket stays open" — the same trap as
 * node-pg's unlimited `connectionTimeoutMillis` (docs/decisions.md §1). A
 * provider that accepts a connection and then stops responding would
 * otherwise hold an HTTP request, or a BullMQ job and its worker slot, until
 * something else gives up. Nothing else would: BullMQ's stalled-job check
 * only fires for a worker that has stopped renewing its lock, and a worker
 * blocked in `await fetch` is still renewing.
 *
 * 15 seconds is generous for a JSON POST and tight enough that a retry still
 * happens inside a reasonable job budget. A message carrying a large
 * attachment is the case that legitimately needs longer — raise it per send
 * with `timeoutMs` rather than lifting this for everything.
 */
const DEFAULT_SEND_TIMEOUT_MS = 15_000;

/**
 * Resend's cap on recipients in a single message.
 *
 * Checked locally because the failure is a 422 that costs a whole job, and
 * because exceeding it usually means a list was passed where one address was
 * meant — which is also how a transactional template accidentally becomes a
 * bulk send with every recipient visible to the others.
 */
const MAX_RECIPIENTS = 50;

/** Resend rejects an idempotency key longer than this with a 400. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

/**
 * Error names Resend returns that are worth trying again.
 *
 * Everything not listed is a permanent failure — a malformed payload, an
 * unverified sending domain, a revoked key. Retrying those five times with
 * exponential backoff achieves nothing except delaying the moment somebody
 * notices, and burns the job's attempts so the real error is buried under
 * four identical ones.
 *
 * `daily_quota_exceeded` and `monthly_quota_exceeded` are deliberately NOT
 * here even though both return 429. They do not clear within a job's retry
 * window — a daily quota resets at midnight UTC — so a retry is just a
 * slower failure. They need a human, or a plan.
 *
 * @see https://resend.com/docs/api-reference/errors
 */
const RETRYABLE_ERROR_NAMES = new Set([
  "rate_limit_exceeded",
  "application_error",
  "internal_server_error",
  "concurrent_idempotent_requests",
]);

/**
 * A send that did not happen.
 *
 * Carries what a queue processor needs to decide what to do next, which is
 * why it is a class and not an `ApiError`: `retryable` has no meaning over
 * HTTP, and a 500 is the right answer to a controller either way (the
 * generic error middleware turns any non-ApiError into one, and masks the
 * message in production — right, because "your Resend domain is not
 * verified" is not a sentence for a customer).
 */
export class EmailSendError extends Error {
  /** Resend's error name, or `network_error` / `timeout` when it never landed. */
  public readonly code: string;
  /**
   * The provider's HTTP status.
   *
   * NAMED `providerStatusCode`, NOT `statusCode`, and that is not cosmetic.
   * `errorConverter` duck-types on `err.statusCode`: any thrown object
   * carrying one has that number used as the HTTP status, and because 4xx
   * is treated as operational, its message is NOT masked in production.
   *
   * With this field called `statusCode`, a Resend 403 for an unverified
   * sending domain reached the caller as an HTTP 403 reading "The acme.com
   * domain is not verified" — our infrastructure, described to a customer,
   * with a status code that invites them to fix something on their end. A
   * 429 was handed through the same way, inviting a retry of a request that
   * was never rate-limited.
   *
   * Resend's status describes our relationship with Resend. To a caller,
   * every one of them is a 500.
   */
  public readonly providerStatusCode: number | null;
  /** Whether sending the exact same message again could succeed. */
  public readonly retryable: boolean;
  /** From `retry-after`, when the provider said how long to wait. */
  public readonly retryAfterMs?: number;

  constructor(
    message: string,
    code: string,
    providerStatusCode: number | null,
    retryable: boolean,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "EmailSendError";
    this.code = code;
    this.providerStatusCode = providerStatusCode;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;

    Object.setPrototypeOf(this, EmailSendError.prototype);
  }
}

/**
 * Refuse early when email is switched off.
 *
 * Exported for the same reason `assertStorageEnabled` is: a caller that
 * changes state before sending (stamping a token as issued, marking an
 * invite as sent) has to check first, or it leaves a row claiming an email
 * went out that never did.
 */
export const assertEmailEnabled = (): void => {
  if (!isEmailEnabled()) {
    throw new ApiError(
      httpStatus.SERVICE_UNAVAILABLE,
      "Email is not configured on this server.",
    );
  }
};

export interface EmailAttachment {
  filename: string;
  /** File contents. Use this or `path`, never both. */
  content?: Buffer | string;
  /** A URL Resend fetches the file from, instead of inlining it. */
  path?: string;
  contentType?: string;
  /** Set this to reference the file inline as `<img src="cid:...">`. */
  contentId?: string;
}

export interface SendEmailParams {
  to: string | string[];
  subject: string;
  /** At least one of `html` or `text` is required. */
  html?: string;
  text?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string | string[];
  attachments?: EmailAttachment[];
  headers?: Record<string, string>;
  tags?: { name: string; value: string }[];
  /** Overrides the configured sender. Its domain must be verified too. */
  from?: string;
  /**
   * Abandon the send after this long. Defaults to 15s; raise it for a
   * message carrying a large attachment, which is the one case that
   * legitimately takes longer.
   */
  timeoutMs?: number;
  /**
   * Resend's own deduplication, retained for 24 hours.
   *
   * Worth passing, and worth not trusting. It collapses the common
   * double-send — a retried webhook, a double-clicked button, a job that
   * stalled and was picked up twice — but the window is 24 hours and
   * nothing more, so it is a convenience and not the idempotency guarantee.
   * That belongs in Postgres; see the dispatch record in
   * todo/sugestion-5.md and the reasoning in todo/sugestion-2.md.
   */
  idempotencyKey?: string;
}

export interface SendEmailResult {
  /** Resend's message id, worth storing against whatever triggered the send. */
  id: string;
}

const asArray = (value: string | string[]): string[] =>
  Array.isArray(value) ? value : [value];

/**
 * Parse `retry-after` (seconds) or `ratelimit-reset` (seconds) into ms.
 *
 * Resend sends IETF draft rate-limit headers on every response. A worker
 * can hand this straight to BullMQ's `worker.rateLimit(ms)` so a throttled
 * send is requeued without consuming an attempt.
 */
const retryAfterFrom = (
  headers: Record<string, string> | null,
): number | undefined => {
  if (!headers) return undefined;

  // Looked up case-insensitively. HTTP header names are case-insensitive and
  // nothing in the SDK's type says these arrive lowercased — a `Retry-After`
  // missed by an exact-match lookup silently costs the backoff hint, which
  // fails open as "retry immediately" and hammers a provider that just asked
  // us not to.
  const lower = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const raw = lower.get("retry-after") ?? lower.get("ratelimit-reset");
  if (!raw) return undefined;

  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
};

/**
 * Encoded size of the inlined attachments, which is what the limit measures.
 *
 * The two accepted content forms are NOT the same size. A Buffer is raw bytes
 * and grows by 4/3 when the SDK base64-encodes it; a string is already
 * base64 and is sent as-is. Measuring both the same way either rejects a
 * legitimate 31 MB base64 string or waves through a Buffer that encodes to
 * 52 MB. `path` attachments are fetched by Resend and cost nothing here.
 */
const encodedAttachmentBytes = (attachments: EmailAttachment[]): number =>
  attachments.reduce((total, { content }) => {
    if (!content) return total;

    return (
      total +
      (typeof content === "string"
        ? Buffer.byteLength(content, "utf8")
        : Math.ceil(content.byteLength / 3) * 4)
    );
  }, 0);

/**
 * Strip CR and LF from a header value.
 *
 * Classic header injection: a newline in a subject lets everything after it
 * be read as a new header — `Bcc:` being the interesting one. Resend takes
 * JSON rather than a raw message, so the API is very likely doing this
 * already, but "the provider probably handles it" is not a control. Subjects
 * are about to be rendered from database templates with customer-supplied
 * values in them, which is exactly the shape of the problem.
 */
const stripNewlines = (value: string): string =>
  value.replace(/[\r\n]+/g, " ").trim();

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Refuse an address containing control characters.
 *
 * Addresses are REJECTED rather than stripped, unlike the subject and the
 * display name. Those are free text, where removing a newline leaves
 * something still meaningful. An address with a newline in it is not an
 * address that needs tidying — it is either corrupt data or an injection
 * attempt, and silently mangling it into a different address is the worse
 * of the two outcomes.
 *
 * Registration validates addresses with Joi, so this should be unreachable
 * for a customer. `replyTo` and `from` are the ones that will eventually
 * come from an admin-editable template.
 */
const assertAddressesSafe = (field: string, addresses: string[]): void => {
  if (addresses.some((address) => CONTROL_CHARACTERS.test(address))) {
    throw new EmailSendError(
      `The ${field} address contains characters that are not allowed in an email header.`,
      "validation_error",
      null,
      false,
    );
  }
};

/**
 * Send one email.
 *
 * @throws {ApiError} 503 when email is switched off.
 * @throws {EmailSendError} when the provider refused or could not be reached.
 */
export const sendEmail = async (
  params: SendEmailParams,
): Promise<SendEmailResult> => {
  assertEmailEnabled();

  const {
    to,
    subject,
    html,
    text,
    cc,
    bcc,
    replyTo,
    attachments,
    headers,
    tags,
    from,
    idempotencyKey,
    timeoutMs = DEFAULT_SEND_TIMEOUT_MS,
  } = params;

  const recipients = asArray(to).filter((address) => address.trim() !== "");

  if (recipients.length > MAX_RECIPIENTS) {
    throw new EmailSendError(
      `An email may have at most ${MAX_RECIPIENTS} recipients, not ${recipients.length}.`,
      "validation_error",
      null,
      false,
    );
  }

  if (
    idempotencyKey !== undefined &&
    (idempotencyKey.length === 0 ||
      idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH)
  ) {
    // Resend answers 400 `invalid_idempotency_key`. Worth catching here
    // because a key built from concatenated ids is exactly the kind of thing
    // that grows past 256 characters long after the code was written, and
    // the resulting failure looks nothing like its cause.
    throw new EmailSendError(
      `An idempotency key must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
      "invalid_idempotency_key",
      null,
      false,
    );
  }

  if (recipients.length === 0) {
    // `to: []` and `to: ""` both reach Resend as a request with nobody to
    // deliver to. Caught here because once this runs on a queue the answer
    // is a failed job rather than a stack trace anyone is watching.
    throw new EmailSendError(
      "An email needs at least one recipient.",
      "missing_required_field",
      null,
      false,
    );
  }

  if (!html && !text) {
    // Resend would answer 422 `missing_required_field`, which is a slow and
    // confusing way to learn that a template rendered to nothing.
    throw new EmailSendError(
      "An email needs an html or a text body.",
      "missing_required_field",
      null,
      false,
    );
  }

  if (attachments?.length) {
    // Exactly one source per attachment. Resend answers 422
    // `invalid_attachment` for neither; for both, which of the two wins is
    // undocumented, and a silently ignored `content` is worse than an error.
    const malformed = attachments.find(
      (attachment) => !attachment.content === !attachment.path,
    );
    if (malformed) {
      throw new EmailSendError(
        `Attachment "${malformed.filename}" needs exactly one of content or path.`,
        "invalid_attachment",
        null,
        false,
      );
    }

    // Checked locally because the alternative is uploading tens of
    // megabytes to be told no — on a queue, five times.
    if (encodedAttachmentBytes(attachments) > MAX_MESSAGE_BYTES) {
      throw new EmailSendError(
        `Attachments exceed the ${MAX_MESSAGE_BYTES / 1024 / 1024} MB per-message limit once base64-encoded.`,
        "invalid_attachment",
        null,
        false,
      );
    }
  }

  // NOT stripped, unlike the subject. A `from` override is an address, so
  // the reject-don't-mangle rule applies — and stripping here would make
  // the check below unreachable. A caller wanting a display name builds it
  // with `formatAddress`, which sanitises the name half.
  const resolvedFrom = from ?? getDefaultFrom();
  const resolvedReplyTo = replyTo ?? config.EMAIL.REPLY_TO;

  // Every address that becomes a header is checked, not just the ones a
  // customer supplied. `from` and `replyTo` are the ones that will
  // eventually come from an admin-editable template.
  assertAddressesSafe("from", [resolvedFrom]);
  assertAddressesSafe("to", recipients);
  if (cc) assertAddressesSafe("cc", asArray(cc));
  if (bcc) assertAddressesSafe("bcc", asArray(bcc));
  if (resolvedReplyTo) assertAddressesSafe("replyTo", asArray(resolvedReplyTo));

  const payload = {
    from: resolvedFrom,
    to: recipients,
    subject: stripNewlines(subject),
    ...(html ? { html } : {}),
    ...(text ? { text } : {}),
    ...(cc ? { cc: asArray(cc) } : {}),
    ...(bcc ? { bcc: asArray(bcc) } : {}),
    ...(resolvedReplyTo ? { replyTo: resolvedReplyTo } : {}),
    ...(attachments?.length ? { attachments } : {}),
    ...(tags?.length ? { tags } : {}),
    // Omitted rather than sent empty: an always-present `headers: {}` is
    // noise in every request and in every captured payload in a test.
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
  } as CreateEmailOptions;

  let response;
  try {
    response = await getResendClient().emails.send(payload, {
      signal: AbortSignal.timeout(timeoutMs),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  } catch (err) {
    // The ONLY thing a try/catch around this call sees. The SDK resolves —
    // it does not throw — for every API-level refusal, so anything landing
    // here is the request never completing: DNS, TLS, a dropped socket, or
    // our own abort. All of which are worth retrying.
    const error = err as Error;
    const timedOut =
      error.name === "TimeoutError" || error.name === "AbortError";

    logger.error(
      `[Email] Request to Resend ${timedOut ? `timed out after ${timeoutMs}ms` : `failed: ${error.message}`}`,
    );

    throw new EmailSendError(
      timedOut
        ? `The email provider did not respond within ${timeoutMs}ms.`
        : `Could not reach the email provider: ${error.message}`,
      timedOut ? "timeout" : "network_error",
      null,
      true,
    );
  }

  const { data, error } = response;

  if (error) {
    const providerStatusCode = error.statusCode ?? null;
    const retryable =
      RETRYABLE_ERROR_NAMES.has(error.name) ||
      // Anything 5xx is the provider's problem and may well be transient,
      // including statuses with no name of their own (503).
      (providerStatusCode !== null && providerStatusCode >= 500);
    const retryAfterMs = retryAfterFrom(response.headers);

    // Logged in full here because the thrown message is masked in
    // production by the error handler, so this is the only surviving record
    // of which domain or field Resend actually objected to.
    logger.error(
      `[Email] Resend refused "${payload.subject}" (${error.name}` +
        `${providerStatusCode === null ? "" : `, ${providerStatusCode}`}` +
        `${retryable ? ", retryable" : ""}): ${error.message}`,
    );

    throw new EmailSendError(
      error.message,
      error.name,
      providerStatusCode,
      retryable,
      retryAfterMs,
    );
  }

  if (!data?.id) {
    // Should not happen: the SDK's type says one of data or error is always
    // set. Guarded anyway, because returning a result with an undefined id
    // would write a broken provider reference into whatever records the send.
    throw new EmailSendError(
      "The email provider returned no message id.",
      "application_error",
      null,
      true,
    );
  }

  // Addresses are redacted: a log line is the one place a customer's email
  // reliably outlives the request, and logs travel further than the people
  // writing them expect. The provider id is what links this back to the
  // full record in Resend's dashboard when somebody genuinely needs it.
  logger.info(
    `[Email] Sent "${payload.subject}" to ` +
      `${recipients.map(redactEmail).join(", ")} (${data.id})`,
  );

  return { id: data.id };
};
