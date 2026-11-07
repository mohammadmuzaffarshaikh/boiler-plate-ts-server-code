# Suggestion 2 — BullMQ workers for order emails and WhatsApp

**Status:** not started — Redis client landed 2026-11-04, `bullmq` not installed
**Raised:** 2026-11-04
**Depends on:** `src/config/redis.ts` (done), `Order` schema (not yet written), Resend + a WhatsApp provider (not yet wired)
**Blocks:** nothing — queues can be built one at a time

## Description

Where BullMQ workers run, how the queues should be configured, and the one
failure mode that will otherwise send a customer the same order confirmation
twice.

The Redis layer is already in place. `src/config/redis.ts` exposes two
role-specific connections — `getQueueConnection()` for producers and
`getWorkerConnection()` for consumers — because BullMQ needs contradictory
settings for each. That part is settled; this document is about everything
built on top.

The decision that was explicitly deferred: **do workers run inside the API
process, or in their own process?**

---

## Recommendation: a separate worker process

Add `src/worker.ts` as a second entrypoint, and a second app in
`ecosystem.config.json`. The API process stays a producer only.

### Why

1. **A slow send must not slow down checkout.** Workers and HTTP handlers share
   one event loop if they share a process. A WhatsApp provider having a bad
   minute becomes elevated API latency for every shopper on the site.
2. **Instance count stops being one number.** PM2 `instances` currently sets
   API concurrency. In-process workers make it set worker concurrency too, so
   you cannot scale request capacity without multiplying outbound sends.
3. **Restarts are independent.** Deploying an API fix should not kill workers
   holding in-flight jobs; those jobs get recovered as stalled about 30 seconds
   later, per BullMQ's production guide, and may re-run.
4. **The failure domains differ.** A worker that OOMs on a large PDF invoice
   should not take the storefront API down with it.

The cost is one more process to run and deploy. That is the entire downside.

```jsonc
// ecosystem.config.json — add alongside the existing "app"
{
  "name": "worker",
  "script": "dist/worker.js",
  "instances": 1,          // see "Scaling" below before raising this
  "autorestart": true,
  "time": true,
  "env": { "NODE_ENV": "production" }
}
```

`src/worker.ts` asks for both connections, since it both consumes and may
enqueue follow-up jobs:

```ts
await initRedis(["queue", "worker"]);
```

The API's `src/index.ts` already calls `initRedis()`, which opens the producer
connection only. Nothing changes there.

> If you decide to start in-process instead to keep deployment simple, the
> Redis layer supports it unchanged — register workers in `src/index.ts` behind
> `isRedisEnabled()`. It is a reversible decision; treat it as a staging
> convenience rather than the production shape.

---

## The trap: BullMQ's `jobId` is not idempotency

This is the part worth reading twice, because it is silent, it only bites in
production, and the obvious reading of the docs is wrong.

BullMQ deduplicates by custom job id:

> "Since ids must be unique, if you add a job with an existing id then that job
> will just be ignored and not added to the queue at all."

So a `jobId` of `order-<orderId>-confirmation` looks like a guarantee that the
confirmation mail is sent once. It is not. The same page continues:

> "Jobs that are removed from the queue (either manually, or when using settings
> such as `removeOnComplete`/`removeOnFailed`) will **not** be considered as
> duplicates, meaning that you can add the same job id many times over as long
> as the previous job has already been removed from the queue."

Every production setup sets `removeOnComplete` — otherwise Redis grows without
limit. So the dedup window is exactly "until the job is cleaned up", which is
minutes. A retried webhook, a double-clicked button, or a replayed payment
callback an hour later re-enqueues happily and the customer gets a second email.

**Therefore: idempotency lives in Postgres, not in the job id.** Record the
side-effect and check it inside the processor:

```prisma
model OrderNotification {
  id        String   @id @default(uuid())
  orderId   String   @map("order_id")
  channel   String                        // "email" | "whatsapp"
  kind      String                        // "confirmation" | "shipped" | ...
  sentAt    DateTime @default(now()) @map("sent_at")
  providerId String? @map("provider_id")  // Resend / provider message id

  @@unique([orderId, channel, kind])
  @@map("order_notifications")
}
```

The processor attempts the insert first and treats a unique-constraint
violation as "already sent, nothing to do". That survives job removal, stalled
re-runs, retries, and a full Redis flush — none of which a `jobId` survives.

Keep the custom `jobId` anyway: it cheaply absorbs the common double-enqueue
and gives jobs readable names in any dashboard. Just never rely on it.

Two restrictions on custom ids, both of which throw at `add()` time:

- must not contain `:`
- must not be only digits — `Error: Custom Id cannot be integers`. So
  `jobId: order.id` breaks the day order ids become numeric. Always prefix.

### Stalls make this worse

A worker that blocks the event loop loses its lock, and BullMQ moves the job
back to waiting to be picked up by another worker. The first run may have
already called the email provider. Without the database check above, that is a
duplicate send with no error logged anywhere.

---

## Queues to build

| Queue | Trigger | Notes |
|---|---|---|
| `email` | order placed, shipped, refunded; also email verification from [sugestion-1](./sugestion-1.md) | Resend |
| `whatsapp` | order placed, shipped | Provider rate limits are strict — see below |

Separate queues, not one `notifications` queue with a `channel` field. They have
different rate limits, different retry profiles and different failure rates, and
`limiter` is a per-queue setting. Merging them means WhatsApp throttling stalls
your transactional email.

**Wiring the verification mail from sugestion-1 through the `email` queue closes
out step 3 there** — that work was waiting on exactly this.

---

## Job options

Set these once as `defaultJobOptions` on the queue rather than at every
`add()` site, so a forgotten option cannot quietly mean "retry forever" or
"keep every job in Redis".

```ts
new Queue("email", {
  connection: getQueueConnection(),
  prefix: config.REDIS.QUEUE_PREFIX,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 2000, jitter: 0.5 },
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    removeOnFail: { age: 14 * 24 * 3600 },
  },
});
```

**`attempts`** — without it there are no retries at all; the docs say retries
activate with "a value larger than 1". A third-party email API will have a bad
minute; 5 attempts over a few minutes covers it.

**`backoff`** — exponential delay is `2 ^ (attemptsMade - 1) * delay`, so with
`delay: 2000` the retries land at 2s, 4s, 8s, 16s. (BullMQ's own page states
the formula and then gives prose numbers that disagree with it; the formula is
what the code does.) `jitter` takes 0–1 and spreads retries out — without it,
a provider outage makes every queued job retry in lockstep and hammer the API
the instant it recovers.

**`removeOnComplete` / `removeOnFail`** — the default is to keep finished jobs
**forever**, which is a slow Redis memory leak. Keep completed jobs briefly for
debugging and failed jobs much longer, since failures are what you investigate.
Removal is lazy: it happens when the *next* job finishes, so a quiet queue
holds its last jobs indefinitely. That is expected, not a bug.

---

## Rate limiting outbound sends

WhatsApp Business API and transactional email providers both throttle, and
exceeding the limit returns 429s that burn retry attempts.

```ts
new Worker("whatsapp", processor, {
  connection: getWorkerConnection(),
  prefix: config.REDIS.QUEUE_PREFIX,
  limiter: { max: 10, duration: 1000 },
});
```

Two things about `limiter` that are easy to get wrong:

- It goes on the **Worker**, not the Queue.
- It is **global across workers for that queue**, not per worker. The docs:
  "if you have for example 10 workers for one queue with the above settings,
  still only 10 jobs will be processed by second." So scaling worker count does
  not multiply your send rate — which is exactly what you want against a
  provider quota.

Rate-limited jobs stay in `waiting`; they are not failures and do not consume
attempts.

When the *provider* says 429 rather than you predicting it, hand control back
without counting a failure:

```ts
if (res.status === 429) {
  await worker.rateLimit(retryAfterMs);
  throw Worker.RateLimitError();
}
```

The throw is required — it is how BullMQ distinguishes "throttled, requeue"
from "failed, count an attempt". Note `limiter.max` must still be set on the
worker for this path to be evaluated at all.

---

## Concurrency

`concurrency` defaults to **1** — one job at a time per worker, which is almost
certainly too slow for network-bound sends and is a common "why is the queue
backing up" surprise.

```ts
new Worker("email", processor, { connection: getWorkerConnection(), concurrency: 20 });
```

It is per-worker and safe to raise for I/O-bound work. BullMQ recommends a high
concurrency factor *plus* more than one worker, because the second worker is
what gives you availability when one dies. For CPU-heavy jobs (PDF invoices)
raise processes, not concurrency — a blocked event loop is what causes stalls.

---

## Shutdown

Order matters, and `closeRedis()` is already wired as the last step in
`src/index.ts`:

```ts
await worker.close();   // stop taking new jobs, let in-flight ones finish
await queue.close();
await closeRedis();
```

Closing the shared connection first strands in-flight jobs, which another
worker then recovers as stalled. `src/worker.ts` needs the same handlers
`src/index.ts` already has for `SIGTERM` / `SIGINT`.

PM2 sends `SIGINT` and kills after a timeout, so a long-running job can still
be cut off mid-flight. That is survivable precisely because of the
`OrderNotification` check — another reason it is not optional.

---

## Scaling

The worker process can run `instances > 1` once it exists; BullMQ coordinates
through Redis and the `limiter` stays global, so outbound rate is unaffected.

**The API process is a different story and still cannot be scaled past
`instances: 1`.** `src/middlewares/rate-limiter.middleware.ts` uses the default
in-memory store, so every API instance would keep its own counters and the
effective limit would multiply by instance count. Switching to
`rate-limit-redis` is roughly one line in the `createRateLimiter` factory now
that a Redis connection exists — worth doing at the same time as this work,
since it removes the last reason `instances` is pinned to 1.

---

## Keep job payloads small and non-secret

Payloads are JSON in Redis, visible to anything that can read the instance, and
they persist for the job's lifetime.

- Pass `{ orderId }`, not the whole order. The worker re-reads from Postgres and
  gets current data rather than a snapshot that was stale before it ran.
- Never put card details, tokens or full addresses in a payload.
- Processors must throw real `Error` objects — BullMQ's retry handling depends
  on it, and a thrown string silently misbehaves.

---

## Suggested implementation order

1. `pnpm add bullmq`. Confirm `getQueueConnection()` is accepted as
   `connection` and that a worker duplicates it for its blocking socket.
2. `OrderNotification` model and the unique constraint. **Before** any send
   goes out, not after the first duplicate is reported.
3. `email` queue + `src/worker.ts` + the PM2 app, with one real job: the
   verification mail from sugestion-1 step 3. Smallest useful end-to-end slice.
4. Order confirmation email, once `Order` exists.
5. `whatsapp` queue with `limiter` tuned to the provider's documented quota.
6. Swap the rate limiter to `rate-limit-redis` and lift API `instances`.
7. A failed-jobs view. Until then, failures are invisible unless someone reads
   the logs — attach `worker.on("failed", ...)` from day one.

Steps 1–3 are self-contained and do not depend on the `Order` schema.
