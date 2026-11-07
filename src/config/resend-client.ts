import { Resend } from "resend";
import config from "./config";

/**
 * The Resend client, and the From header every message is sent with.
 *
 * WHY RESEND AND NOT SES + NODEMAILER (which the sibling api repo uses):
 * that stack builds a MIME message locally with nodemailer's
 * `streamTransport` and hands the raw bytes to `SendRawEmailCommand`. It
 * works, but it means the app owns MIME assembly — encoding, boundaries,
 * inline-image content ids — for no benefit, and it needs an IAM principal
 * with `ses:SendRawEmail`. Resend takes `{ html, text, attachments }` as
 * JSON and builds the message itself, so the failure modes shrink to "the
 * API said no", which is a response object rather than a malformed
 * multipart body nobody notices until Outlook renders it as an attachment.
 *
 * ONE THING THAT IS NOT LIKE THE REST OF THIS CODEBASE: the Resend SDK does
 * NOT throw on an API error. `emails.send()` resolves to a discriminated
 * `{ data, error }`, and its own docs say "Do not use try/catch ... Only use
 * try/catch if you need to handle network-level failures". A `try` block
 * around a send therefore catches a DNS failure and sails straight past a
 * 403 for an unverified domain. `email.service` is what converts that result
 * into a thrown error, and it is the only place allowed to call `send`.
 *
 * @see https://resend.com/docs/send-with-nodejs
 */
class ResendSingleton {
  private static instance: Resend;

  private constructor() {}

  public static getInstance(): Resend {
    if (!ResendSingleton.instance) {
      // The SDK accepts an undefined key and fails per-request with
      // `missing_api_key` rather than at construction, which is why nothing
      // here asserts: `assertEmailEnabled` in email.service is the gate, and
      // config.ts has already refused to boot with EMAIL_ENABLED=true and no
      // key.
      ResendSingleton.instance = new Resend(config.EMAIL.API_KEY);
    }

    return ResendSingleton.instance;
  }
}

/**
 * Lazily built, for the same reason as `getR2Client`. Constructing it at
 * import time would run on every `import config` path — tests, CLI scripts,
 * `prisma generate` — none of which send mail.
 */
export const getResendClient = (): Resend => ResendSingleton.getInstance();

/** Whether anything should actually be sent, or refused with a 503. */
export const isEmailEnabled = (): boolean => config.EMAIL.ENABLED;

/**
 * Characters that force a display name to be quoted in a From header.
 * RFC 5322 §3.2.3 "specials", minus the ones that cannot appear in practice.
 */
const NAME_NEEDS_QUOTING = /[()<>[\]:;@\\,."]/;

/**
 * Build an RFC 5322 address from a display name and a mailbox.
 *
 * The naive version — `"${name}" <${email}>` — is what the api repo does,
 * and it breaks on any name containing a quote or a backslash: the header
 * terminates early and the rest of the name becomes a syntax error, which
 * providers answer with an opaque 422. A name with no specials in it is
 * left bare, because quoting unconditionally is also wrong — some clients
 * display the quotes.
 *
 * Exported for the tests and for the day a per-template sender is added;
 * nothing else should be formatting addresses by hand.
 */
export const formatAddress = (email: string, name?: string): string => {
  // Control characters go first, before anything else looks at the string.
  // A CR or LF in a display name is header injection — everything after the
  // newline is read as a new header, and `Bcc:` is the interesting one. The
  // name is configuration today, but a per-template sender is a plausible
  // next step and this is the wrong place to find out.
  // eslint-disable-next-line no-control-regex
  const clean = name?.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!clean) return email;

  const escaped = clean.replace(/([\\"])/g, "\\$1");
  const display = NAME_NEEDS_QUOTING.test(clean) ? `"${escaped}"` : clean;

  return `${display} <${email}>`;
};

/**
 * The default From header, from configuration.
 *
 * Read at call time rather than captured at import so a test can change the
 * sender without reloading the module — the same reason `isStorageEnabled`
 * is a function.
 */
export const getDefaultFrom = (): string =>
  formatAddress(config.EMAIL.FROM_ADDRESS, config.EMAIL.FROM_NAME || undefined);
