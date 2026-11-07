import express, { Express, Request, Response, NextFunction } from "express";
import request from "supertest";
import httpStatus from "http-status";
import {
  errorConverter,
  errorHandler,
} from "../../src/middlewares/error.middleware";
import logger from "../../src/config/logger";
import config from "../../src/config/config";
import ApiError from "../../src/utils/api-error";
import {
  EmailSendError,
  sendEmail,
} from "../../src/services/email.service";
import { getResendClient } from "../../src/config/resend-client";

/**
 * The transport layer. Nothing reaches the network: `emails.send` is
 * replaced, and the assertions are about the payload handed to it and about
 * how its result is turned into a thrown error.
 *
 * The error cases carry the weight here. The Resend SDK RESOLVES on an API
 * refusal rather than throwing — its own docs say not to use try/catch — so
 * a naive integration treats a 403 for an unverified domain as a successful
 * send. These specs pin that this service does not.
 */

/**
 * The spy is created inside `beforeEach`, NOT at module scope. The project
 * runs with `restoreMocks: true`, which restores every spy before each test
 * — including one installed at import time, which is therefore detached
 * from `emails.send` before the first assertion ever runs. Written the
 * obvious way, these specs make real HTTPS calls to Resend and fail with
 * "API key is invalid".
 */
let send: jest.SpyInstance;

/** The `{ data, error }` shape the SDK resolves with, plus its headers. */
const ok = (id = "msg_1") =>
  ({ data: { id }, error: null, headers: null }) as never;

const refused = (
  name: string,
  message: string,
  statusCode: number | null,
  headers: Record<string, string> | null = null,
) => ({ data: null, error: { name, message, statusCode }, headers }) as never;

beforeEach(() => {
  send = jest.spyOn(getResendClient().emails, "send").mockResolvedValue(ok());
});

const minimal = { to: "customer@shop.test", subject: "Hi", html: "<p>Hi</p>" };

describe("the payload handed to Resend", () => {
  it("returns the provider message id", async () => {
    send.mockResolvedValue(ok("msg_abc"));
    await expect(sendEmail(minimal)).resolves.toEqual({ id: "msg_abc" });
  });

  it("defaults the sender from configuration", async () => {
    await sendEmail(minimal);
    expect(send.mock.calls[0]![0]).toMatchObject({
      from: "Boilerplate Test <no-reply@test.invalid>",
      to: ["customer@shop.test"],
      subject: "Hi",
      html: "<p>Hi</p>",
    });
  });

  it("normalises a single recipient to an array", async () => {
    await sendEmail({ ...minimal, to: "one@shop.test" });
    expect(send.mock.calls[0]![0]).toMatchObject({ to: ["one@shop.test"] });
  });

  it("passes the idempotency key as the second argument, not in the payload", async () => {
    // The SDK takes it as a request option; the published Node guide shows
    // it inside the payload, which is wrong and would silently not
    // deduplicate anything.
    await sendEmail({ ...minimal, idempotencyKey: "verify-email/u-1" });

    expect(send.mock.calls[0]![1]).toMatchObject({
      idempotencyKey: "verify-email/u-1",
    });
    expect(send.mock.calls[0]![0]).not.toHaveProperty("idempotencyKey");
  });

  it("carries no idempotency key when none is given", async () => {
    await sendEmail(minimal);
    expect(send.mock.calls[0]![1]).not.toHaveProperty("idempotencyKey");
  });

  it("falls back to the configured reply-to", async () => {
    const previous = config.EMAIL.REPLY_TO;
    config.EMAIL.REPLY_TO = "support@shop.test";
    try {
      await sendEmail(minimal);
      expect(send.mock.calls[0]![0]).toMatchObject({
        replyTo: "support@shop.test",
      });
    } finally {
      config.EMAIL.REPLY_TO = previous;
    }
  });

  it("lets an explicit reply-to win over the configured one", async () => {
    const previous = config.EMAIL.REPLY_TO;
    config.EMAIL.REPLY_TO = "support@shop.test";
    try {
      await sendEmail({ ...minimal, replyTo: "orders@shop.test" });
      expect(send.mock.calls[0]![0]).toMatchObject({
        replyTo: "orders@shop.test",
      });
    } finally {
      config.EMAIL.REPLY_TO = previous;
    }
  });
});

describe("refusing before the provider does", () => {
  it("throws a 503 ApiError when email is switched off", async () => {
    const previous = config.EMAIL.ENABLED;
    config.EMAIL.ENABLED = false;
    try {
      const error = await sendEmail(minimal).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).statusCode).toBe(
        httpStatus.SERVICE_UNAVAILABLE,
      );
      expect(send).not.toHaveBeenCalled();
    } finally {
      config.EMAIL.ENABLED = previous;
    }
  });

  it("refuses a message with no body", async () => {
    // A template that rendered to nothing. Resend would answer 422, which
    // is a slow and confusing way to find out.
    const error = await sendEmail({ to: "a@b.test", subject: "x" }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(EmailSendError);
    expect((error as EmailSendError).retryable).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses attachments that would exceed the 40 MB message limit", async () => {
    // base64 inflates by 4/3, so 31 MB of raw content is already over.
    const error = await sendEmail({
      ...minimal,
      attachments: [
        { filename: "big.pdf", content: Buffer.alloc(31 * 1024 * 1024) },
      ],
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EmailSendError);
    expect((error as EmailSendError).code).toBe("invalid_attachment");
    expect(send).not.toHaveBeenCalled();
  });

  it("allows an attachment comfortably under the limit", async () => {
    await expect(
      sendEmail({
        ...minimal,
        attachments: [
          { filename: "invoice.pdf", content: Buffer.alloc(1024) },
        ],
      }),
    ).resolves.toEqual({ id: "msg_1" });
  });
});

describe("turning a refusal into a thrown error", () => {
  it("throws rather than resolving when Resend refuses", async () => {
    // The whole point. The SDK resolves here, so a caller that only checks
    // for a rejected promise would record this as a successful send.
    send.mockResolvedValue(
      refused("validation_error", "The domain is not verified.", 403),
    );

    await expect(sendEmail(minimal)).rejects.toBeInstanceOf(EmailSendError);
  });

  it("marks an unverified domain as permanent", async () => {
    send.mockResolvedValue(
      refused("validation_error", "The domain is not verified.", 403),
    );

    const error = (await sendEmail(minimal).catch(
      (e: unknown) => e,
    )) as EmailSendError;

    expect(error.code).toBe("validation_error");
    expect(error.providerStatusCode).toBe(403);
    // Retrying this five times changes nothing and buries the real error
    // under four identical ones.
    expect(error.retryable).toBe(false);
  });

  it("marks a rate limit as retryable and reports how long to wait", async () => {
    send.mockResolvedValue(
      refused("rate_limit_exceeded", "Too many requests", 429, {
        "retry-after": "2",
      }),
    );

    const error = (await sendEmail(minimal).catch(
      (e: unknown) => e,
    )) as EmailSendError;

    expect(error.retryable).toBe(true);
    // Feeds BullMQ's `worker.rateLimit(ms)` so a throttled send is requeued
    // without consuming an attempt. See todo/sugestion-2.md.
    expect(error.retryAfterMs).toBe(2000);
  });

  it("falls back to ratelimit-reset when retry-after is absent", async () => {
    send.mockResolvedValue(
      refused("rate_limit_exceeded", "Too many requests", 429, {
        "ratelimit-reset": "5",
      }),
    );

    const error = (await sendEmail(minimal).catch(
      (e: unknown) => e,
    )) as EmailSendError;

    expect(error.retryAfterMs).toBe(5000);
  });

  it("does NOT treat a quota exhaustion as retryable, despite the 429", async () => {
    // A daily quota resets at midnight UTC. Retrying inside a job's window
    // is a slower failure, not a recovery.
    send.mockResolvedValue(
      refused("daily_quota_exceeded", "Daily quota reached", 429),
    );

    const error = (await sendEmail(minimal).catch(
      (e: unknown) => e,
    )) as EmailSendError;

    expect(error.retryable).toBe(false);
  });

  it("treats any 5xx as retryable even with an unfamiliar name", async () => {
    send.mockResolvedValue(refused("service_unavailable", "Down", 503));

    const error = (await sendEmail(minimal).catch(
      (e: unknown) => e,
    )) as EmailSendError;

    expect(error.retryable).toBe(true);
  });

  it("treats a thrown request as a retryable network failure", async () => {
    // The only thing a try/catch around the SDK call ever sees.
    send.mockRejectedValue(new Error("ECONNRESET"));

    const error = (await sendEmail(minimal).catch(
      (e: unknown) => e,
    )) as EmailSendError;

    expect(error.code).toBe("network_error");
    expect(error.retryable).toBe(true);
  });

  it("refuses a success with no message id", async () => {
    // Would otherwise write an undefined provider reference into whatever
    // records the send.
    send.mockResolvedValue({ data: {}, error: null, headers: null } as never);

    await expect(sendEmail(minimal)).rejects.toBeInstanceOf(EmailSendError);
  });
});

describe("recipients", () => {
  it("refuses an empty recipient list", async () => {
    // `to: []` reaches Resend as a request with nobody to deliver to. Once
    // this runs on a queue that is a failed job rather than a stack trace
    // anybody is watching.
    const error = await sendEmail({ ...minimal, to: [] }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(EmailSendError);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a blank recipient string", async () => {
    await expect(sendEmail({ ...minimal, to: "  " })).rejects.toBeInstanceOf(
      EmailSendError,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("drops a blank entry from a list rather than forwarding it", async () => {
    await sendEmail({ ...minimal, to: ["a@shop.test", "", "b@shop.test"] });

    expect(send.mock.calls[0]![0]).toMatchObject({
      to: ["a@shop.test", "b@shop.test"],
    });
  });

  it("passes cc and bcc through", async () => {
    await sendEmail({
      ...minimal,
      cc: "manager@shop.test",
      bcc: "audit@shop.test",
    });

    expect(send.mock.calls[0]![0]).toMatchObject({
      cc: ["manager@shop.test"],
      bcc: ["audit@shop.test"],
    });
  });
});

describe("header hygiene", () => {
  it("strips newlines out of the subject", async () => {
    // Header injection: everything after a newline would be read as a new
    // header, and `Bcc:` is the interesting one. Subjects are about to be
    // rendered from database templates carrying customer-supplied values.
    await sendEmail({
      ...minimal,
      subject: "Order shipped\r\nBcc: attacker@evil.test",
    });

    const subject = (send.mock.calls[0]![0] as { subject: string }).subject;
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject).toBe("Order shipped Bcc: attacker@evil.test");
  });

  it("omits headers entirely rather than sending an empty object", async () => {
    await sendEmail(minimal);
    expect(send.mock.calls[0]![0]).not.toHaveProperty("headers");
  });

  it("passes supplied headers through", async () => {
    await sendEmail({ ...minimal, headers: { "X-Entity-Ref-ID": "order-1" } });

    expect(send.mock.calls[0]![0]).toMatchObject({
      headers: { "X-Entity-Ref-ID": "order-1" },
    });
  });
});

describe("attachment validation", () => {
  it("refuses an attachment with neither content nor path", async () => {
    const error = await sendEmail({
      ...minimal,
      attachments: [{ filename: "ghost.pdf" }],
    }).catch((e: unknown) => e);

    expect((error as EmailSendError).code).toBe("invalid_attachment");
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses an attachment with both content and path", async () => {
    // Which one wins is undocumented, and a silently ignored `content` is
    // worse than an error.
    const error = await sendEmail({
      ...minimal,
      attachments: [
        {
          filename: "both.pdf",
          content: Buffer.alloc(8),
          path: "https://cdn.test/both.pdf",
        },
      ],
    }).catch((e: unknown) => e);

    expect((error as EmailSendError).code).toBe("invalid_attachment");
  });

  it("accepts a path-only attachment and does not count it toward the limit", async () => {
    // Resend fetches it; none of it passes through this process.
    await expect(
      sendEmail({
        ...minimal,
        attachments: [
          { filename: "invoice.pdf", path: "https://cdn.test/invoice.pdf" },
        ],
      }),
    ).resolves.toEqual({ id: "msg_1" });
  });

  it("measures a Buffer by its ENCODED size, not its raw size", async () => {
    // 30 MB of raw bytes encodes to 40 MB, which is the ceiling. Measuring
    // the raw bytes would wave this through and collect a 422 from Resend.
    const error = await sendEmail({
      ...minimal,
      attachments: [
        { filename: "big.pdf", content: Buffer.alloc(30.5 * 1024 * 1024) },
      ],
    }).catch((e: unknown) => e);

    expect((error as EmailSendError).code).toBe("invalid_attachment");
  });

  it("measures a base64 string as already encoded", async () => {
    // A string is base64 and is sent as-is. Applying the 4/3 inflation to
    // it as well would reject a 31 MB string that is comfortably legal.
    await expect(
      sendEmail({
        ...minimal,
        attachments: [
          { filename: "ok.pdf", content: "A".repeat(31 * 1024 * 1024) },
        ],
      }),
    ).resolves.toEqual({ id: "msg_1" });
  });

  it("sums across several attachments", async () => {
    const error = await sendEmail({
      ...minimal,
      attachments: [
        { filename: "a.pdf", content: Buffer.alloc(20 * 1024 * 1024) },
        { filename: "b.pdf", content: Buffer.alloc(20 * 1024 * 1024) },
      ],
    }).catch((e: unknown) => e);

    expect((error as EmailSendError).code).toBe("invalid_attachment");
  });
});

describe("rate-limit headers", () => {
  it("reads retry-after whatever its casing", async () => {
    // HTTP header names are case-insensitive and nothing in the SDK's type
    // promises these arrive lowercased. An exact-match lookup that misses
    // fails open as "retry immediately", against a provider that just asked
    // us not to.
    send.mockResolvedValue(
      refused("rate_limit_exceeded", "Too many requests", 429, {
        "Retry-After": "3",
      }),
    );

    const error = (await sendEmail(minimal).catch(
      (e: unknown) => e,
    )) as EmailSendError;

    expect(error.retryAfterMs).toBe(3000);
  });

  it("leaves retryAfterMs undefined when the header is not a number", async () => {
    send.mockResolvedValue(
      refused("rate_limit_exceeded", "Too many", 429, {
        "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT",
      }),
    );

    const error = (await sendEmail(minimal).catch(
      (e: unknown) => e,
    )) as EmailSendError;

    expect(error.retryAfterMs).toBeUndefined();
    // Still retryable — only the hint is missing, not the classification.
    expect(error.retryable).toBe(true);
  });

  it("survives null headers", async () => {
    send.mockResolvedValue(
      refused("rate_limit_exceeded", "Too many", 429, null),
    );

    const error = (await sendEmail(minimal).catch(
      (e: unknown) => e,
    )) as EmailSendError;

    expect(error.retryAfterMs).toBeUndefined();
  });
});

describe("how an EmailSendError reaches a client", () => {
  /**
   * `errorConverter` duck-types on `err.statusCode` — any thrown object
   * carrying one has that number used as the HTTP status, and 4xx is marked
   * operational, which means its message is NOT masked in production.
   *
   * An email failure must never do that. Resend's statuses are about our
   * relationship with Resend, not about the caller's request: a 403 for an
   * unverified sending domain is a 500 as far as the caller is concerned,
   * and its message names our infrastructure.
   */
  const appThrowing = (error: unknown): Express => {
    const app = express();
    app.get("/boom", (_req: Request, _res: Response, next: NextFunction) =>
      next(error),
    );
    app.use(errorConverter, errorHandler);
    return app;
  };

  const inProduction = async (error: unknown) => {
    const previous = config.ENV;
    const silent = jest.spyOn(logger, "error").mockImplementation(() => logger);
    config.ENV = "production";
    try {
      return await request(appThrowing(error)).get("/boom");
    } finally {
      config.ENV = previous;
      silent.mockRestore();
    }
  };

  it("answers 500, not the provider's status", async () => {
    send.mockResolvedValue(
      refused("validation_error", "The acme.test domain is not verified.", 403),
    );
    const error = await sendEmail(minimal).catch((e: unknown) => e);

    const res = await inProduction(error);

    expect(res.status).toBe(httpStatus.INTERNAL_SERVER_ERROR);
  });

  it("does not leak the provider's message to the caller", async () => {
    send.mockResolvedValue(
      refused("validation_error", "The acme.test domain is not verified.", 403),
    );
    const error = await sendEmail(minimal).catch((e: unknown) => e);

    const res = await inProduction(error);

    expect(JSON.stringify(res.body)).not.toContain("acme.test");
    expect(JSON.stringify(res.body)).not.toContain("not verified");
  });

  it("does not hand a 429 straight through to the caller", async () => {
    // Our quota with Resend is not the caller's problem, and a 429 invites
    // a client to retry a request that was never rate-limited.
    send.mockResolvedValue(refused("rate_limit_exceeded", "Too many", 429));
    const error = await sendEmail(minimal).catch((e: unknown) => e);

    const res = await inProduction(error);

    expect(res.status).toBe(httpStatus.INTERNAL_SERVER_ERROR);
  });

  it("still exposes the provider status on the error object itself", async () => {
    // The information is not thrown away — a worker and the logs need it.
    // It simply must not be the field the HTTP layer keys off.
    send.mockResolvedValue(refused("validation_error", "nope", 403));
    const error = (await sendEmail(minimal).catch(
      (e: unknown) => e,
    )) as EmailSendError;

    expect(error.providerStatusCode).toBe(403);
    expect((error as unknown as { statusCode?: number }).statusCode).toBeUndefined();
  });
});

describe("timeouts and limits", () => {
  it("always passes an abort signal, because the SDK sets no timeout", async () => {
    // Resend's SDK calls `fetch` with no timeout, and Node's default is
    // effectively "wait as long as the socket stays open". Without this, a
    // provider that accepts a connection and then goes quiet holds an HTTP
    // request — or a BullMQ job and its worker slot — indefinitely.
    await sendEmail(minimal);

    const options = send.mock.calls[0]![1] as { signal?: AbortSignal };
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports a timeout as retryable, with its own code", async () => {
    const abort = new Error("The operation was aborted due to timeout");
    abort.name = "TimeoutError";
    send.mockRejectedValue(abort);

    const error = (await sendEmail(minimal).catch(
      (e: unknown) => e,
    )) as EmailSendError;

    expect(error.code).toBe("timeout");
    expect(error.retryable).toBe(true);
  });

  it("actually aborts a send that outlasts its timeout", async () => {
    // Proves the signal is wired to something, not merely present.
    send.mockImplementation(((_payload: unknown, options: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "TimeoutError";
          reject(err);
        });
      })) as never);

    const error = (await sendEmail({ ...minimal, timeoutMs: 60 }).catch(
      (e: unknown) => e,
    )) as EmailSendError;

    expect(error.code).toBe("timeout");
  });

  it("refuses more than 50 recipients", async () => {
    // Resend's cap. Exceeding it usually means a list was passed where one
    // address was meant — which is also how a transactional template
    // becomes a bulk send with every recipient visible to the others.
    const many = Array.from({ length: 51 }, (_, i) => `c${i}@shop.test`);

    const error = await sendEmail({ ...minimal, to: many }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(EmailSendError);
    expect(send).not.toHaveBeenCalled();
  });

  it("accepts exactly 50 recipients", async () => {
    const many = Array.from({ length: 50 }, (_, i) => `c${i}@shop.test`);
    await expect(sendEmail({ ...minimal, to: many })).resolves.toEqual({
      id: "msg_1",
    });
  });

  it("refuses an over-long idempotency key", async () => {
    // A key built from concatenated ids grows past 256 characters long
    // after the code was written, and the resulting 400 looks nothing
    // like its cause.
    const error = await sendEmail({
      ...minimal,
      idempotencyKey: "k".repeat(257),
    }).catch((e: unknown) => e);

    expect((error as EmailSendError).code).toBe("invalid_idempotency_key");
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses an empty idempotency key", async () => {
    const error = await sendEmail({ ...minimal, idempotencyKey: "" }).catch(
      (e: unknown) => e,
    );

    expect((error as EmailSendError).code).toBe("invalid_idempotency_key");
  });
});

describe("address safety", () => {
  // Addresses are REJECTED rather than stripped, unlike the subject: an
  // address with a newline is corrupt data or an injection attempt, and
  // quietly turning it into a different address is the worse outcome.
  const injected = "victim@shop.test\r\nBcc: attacker@evil.test";

  it("refuses a recipient containing a newline", async () => {
    const error = await sendEmail({ ...minimal, to: injected }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(EmailSendError);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses an injected cc, bcc and replyTo", async () => {
    for (const field of ["cc", "bcc", "replyTo"] as const) {
      send.mockClear();
      await expect(
        sendEmail({ ...minimal, [field]: injected }),
      ).rejects.toBeInstanceOf(EmailSendError);
      expect(send).not.toHaveBeenCalled();
    }
  });

  it("refuses an injected from override", async () => {
    await expect(
      sendEmail({ ...minimal, from: "Shop <a@b.test>\nBcc: x@evil.test" }),
    ).rejects.toBeInstanceOf(EmailSendError);
  });

  it("does not reject an ordinary address", async () => {
    await expect(
      sendEmail({ ...minimal, to: "first.last+tag@sub.shop.test" }),
    ).resolves.toEqual({ id: "msg_1" });
  });
});
