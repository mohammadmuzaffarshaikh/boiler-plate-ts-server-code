import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import httpStatus from "http-status";
import config from "../config/config";
import logger from "../config/logger";
import {
  getR2Client,
  getR2Endpoint,
  isStorageEnabled,
} from "../config/r2-client";
import ApiError from "../utils/api-error";

/**
 * Every call this project makes against Cloudflare R2, and nothing else.
 *
 * Deliberately knows nothing about Prisma, Express or the `File` model: this
 * is the one file that would be rewritten to move to S3, DigitalOcean Spaces
 * or anything else speaking the S3 API. `file.service` owns the database and
 * the orchestration; this owns bytes.
 */

/** Result of a successful upload. */
export interface PutObjectResult {
  key: string;
  /** R2's entity tag, quotes stripped. Null if R2 omitted the header. */
  etag: string | null;
}

export interface HeadObjectResult {
  size: number;
  etag: string | null;
  contentType: string | null;
}

export interface ListObjectsResult {
  keys: string[];
  /** Pass back as `cursor` to continue. Null when the listing is complete. */
  nextCursor: string | null;
}

/**
 * Inactivity timeout for the upload socket. Generous, because it has to
 * cover a slow client pushing a 100 MB video through us to R2, but finite:
 * `http.request` would otherwise wait forever.
 */
const UPLOAD_TIMEOUT_MS = 2 * 60 * 1000;

/** How much of an R2 error body is kept for the log. */
const ERROR_BODY_LIMIT = 8192;

/**
 * Refuse early when storage is switched off.
 *
 * Exported because callers that mutate state before reaching R2 must check
 * it up front — see `file.service.deleteFile`, which would otherwise leave a
 * row marked PENDING_DELETE that nothing can finish.
 */
export const assertStorageEnabled = (): void => {
  if (!isStorageEnabled()) {
    throw new ApiError(
      httpStatus.SERVICE_UNAVAILABLE,
      "File storage is not configured on this server.",
    );
  }
};

/**
 * Percent-encode each path segment but keep the `/` separators.
 * `encodeURIComponent` on the whole key would turn the slashes into `%2F`
 * and silently create one object with a literal slash in its name.
 */
const encodeKey = (key: string): string =>
  key.split("/").map(encodeURIComponent).join("/");

const objectUrl = (key: string): string =>
  `${getR2Endpoint()}/${config.STORAGE.BUCKET}/${encodeKey(key)}`;

/**
 * Turn a non-2xx from R2 into a 502.
 *
 * R2's body is logged but never returned to the client: it echoes the bucket
 * name, the request id and sometimes the key, none of which a caller needs
 * and all of which are infrastructure detail.
 */
const failUpstream = (
  operation: string,
  key: string,
  status: number,
  statusText: string,
  body: string,
): never => {
  logger.error(
    `[R2] ${operation} failed for "${key}": ${status} ${statusText} — ${body.slice(0, 500)}`,
  );
  throw new ApiError(
    httpStatus.BAD_GATEWAY,
    "Storage provider rejected the request. Please try again.",
  );
};

/** Same, for the `fetch`-based verbs, whose body needs awaiting first. */
const failUpstreamResponse = async (
  operation: string,
  key: string,
  response: Response,
): Promise<never> =>
  failUpstream(
    operation,
    key,
    response.status,
    response.statusText,
    await response.text().catch(() => "<unreadable>"),
  );

/** Strip the quotes S3 wraps around an ETag, and any weak-validator prefix. */
const normaliseEtag = (value: string | null): string | null =>
  value ? value.replace(/^W\//, "").replace(/^"|"$/g, "") : null;

interface RawResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * Send a request whose body is a stream, over `node:http(s)`.
 *
 * WHY NOT `fetch`, WHEN THE REST OF THIS FILE USES IT:
 * undici's `fetch` buffers a streaming request body in memory rather than
 * applying backpressure from the socket. Measured on Node 20 against a local
 * sink, a 100 MB upload grows RSS by ~125 MB whether the body is passed as a
 * Node `Readable` or converted with `Readable.toWeb` — which would undo the
 * entire reason multer writes to disk instead of to memory. The same upload
 * through `http.request` + `pipe` grows RSS by ~34 MB, most of that
 * allocation churn rather than retained bytes.
 *
 * The other verbs here send no request body at all, so they stay on `fetch`.
 */
const streamRequest = (
  url: string,
  method: string,
  headers: Record<string, string>,
  body: Readable,
): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;

    // Guards against settling twice. Several of the listeners below can fire
    // after the response has already been delivered — a body error arriving
    // after `end`, for instance — and the cleanup must only run once.
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      // Always destroy the read stream. `pipe` unpipes on a destination
      // error but does NOT close the source, so without this every failed
      // upload leaks an open file descriptor until GC gets to it.
      body.destroy();
      fn();
    };

    const request = transport.request(
      target,
      { method, headers, timeout: UPLOAD_TIMEOUT_MS },
      (response) => {
        const chunks: Buffer[] = [];
        // Only an error body is ever read, and only the first few hundred
        // bytes of it are logged, so capping the buffer is free. The rest is
        // still consumed, so the socket is released rather than stalling.
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          if (size < ERROR_BODY_LIMIT) {
            chunks.push(chunk);
            size += chunk.length;
          }
        });
        response.on("end", () =>
          finish(() =>
            resolve({
              status: response.statusCode ?? 0,
              statusText: response.statusMessage ?? "",
              headers: response.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          ),
        );
        response.on("error", (err) => finish(() => reject(err)));
      },
    );

    // `http.request` has NO default timeout. Without this an R2 endpoint that
    // accepts the connection and then stalls hangs the upload forever: the
    // promise never settles, so `createFile`'s `finally` never runs, the temp
    // file is never unlinked and the HTTP request never answers.
    request.on("timeout", () =>
      finish(() => {
        request.destroy();
        reject(
          new Error(`Upload timed out after ${UPLOAD_TIMEOUT_MS}ms with no response`),
        );
      }),
    );

    request.on("error", (err) => finish(() => reject(err)));
    body.on("error", (err) =>
      finish(() => {
        request.destroy();
        reject(err);
      }),
    );

    body.pipe(request);
  });

/** Collapse a possibly-repeated response header to a single value. */
const headerValue = (
  value: string | string[] | undefined,
): string | null => (Array.isArray(value) ? (value[0] ?? null) : (value ?? null));

/**
 * Upload one object, streaming from disk.
 *
 * `body` is piped and never buffered, so a 100 MB video costs a read buffer
 * rather than 100 MB of heap. Three things make that work:
 *
 *   - The transport is `node:http(s)`, not `fetch` — see `streamRequest`.
 *   - `Content-Length` is sent. Without it the request falls back to chunked
 *     transfer-encoding, which the S3 API does not accept for a plain PUT.
 *   - The request is signed *without* the body. That is not a shortcut: for
 *     S3, aws4fetch sets `X-Amz-Content-Sha256: UNSIGNED-PAYLOAD`, so the
 *     signature never covers the payload and signing a bodyless request
 *     produces exactly the same signature as signing the real one.
 *
 * `Content-MD5` is passed at signing time because it IS covered by the
 * signature (aws4fetch treats content-type and content-length as unsignable,
 * but not content-md5). R2 implements it and rejects a corrupted body, which
 * is why the AWS SDK's CRC32 checksum — the thing R2 answers `501` to — is
 * not missed here.
 */
export const putObject = async (params: {
  key: string;
  body: Readable;
  contentType: string;
  contentLength: number;
  contentMd5?: string;
}): Promise<PutObjectResult> => {
  assertStorageEnabled();

  const url = objectUrl(params.key);

  // Sign first, with only the headers the signature must cover.
  const signedHeaders: Record<string, string> = {};
  if (params.contentMd5) signedHeaders["Content-MD5"] = params.contentMd5;

  const signed = await getR2Client().sign(url, {
    method: "PUT",
    headers: signedHeaders,
  });

  const headers: Record<string, string> = {};
  signed.headers.forEach((value, name) => {
    headers[name] = value;
  });
  // Added after signing: both are on aws4fetch's unsignable list, so they are
  // not part of the signature and cannot invalidate it.
  headers["content-type"] = params.contentType;
  headers["content-length"] = String(params.contentLength);

  const response = await streamRequest(url, "PUT", headers, params.body);

  if (response.status < 200 || response.status >= 300) {
    failUpstream(
      "PUT",
      params.key,
      response.status,
      response.statusText,
      response.body,
    );
  }

  return {
    key: params.key,
    etag: normaliseEtag(headerValue(response.headers.etag)),
  };
};

/**
 * Remove one object.
 *
 * Idempotent by design — S3 answers 204 whether or not the key existed — so
 * the delete path and the cron retry can both call it without checking first.
 */
export const deleteObject = async (key: string): Promise<void> => {
  assertStorageEnabled();

  const response = await getR2Client().fetch(objectUrl(key), {
    method: "DELETE",
  });

  if (!response.ok && response.status !== httpStatus.NOT_FOUND) {
    await failUpstreamResponse("DELETE", key, response);
  }

  // S3 sends an XML body with a 404. Leaving it unread keeps the connection
  // checked out of undici's pool, so a run of missing keys slowly starves it.
  await response.text().catch(() => undefined);
};

/** Metadata for one object, or `null` if it is not there. */
export const headObject = async (
  key: string,
): Promise<HeadObjectResult | null> => {
  assertStorageEnabled();

  const response = await getR2Client().fetch(objectUrl(key), {
    method: "HEAD",
  });

  if (response.status === httpStatus.NOT_FOUND) return null;
  if (!response.ok) await failUpstreamResponse("HEAD", key, response);

  const length = response.headers.get("content-length");
  return {
    size: length ? Number(length) : 0,
    etag: normaliseEtag(response.headers.get("etag")),
    contentType: response.headers.get("content-type"),
  };
};

/** The five predefined XML entities. Our keys never contain them; decoded anyway. */
const decodeXml = (value: string): string =>
  value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/**
 * One page of keys under a prefix, for the orphan sweep.
 *
 * The response is parsed with a regex rather than an XML library on purpose:
 * ListObjectsV2 returns a flat, well-known document and this is the only XML
 * in the codebase. Adding a parser dependency to read `<Key>` elements is not
 * a trade worth making. If a second XML endpoint ever appears, revisit it.
 */
export const listObjects = async (
  prefix: string,
  cursor?: string,
): Promise<ListObjectsResult> => {
  assertStorageEnabled();

  const url = new URL(`${getR2Endpoint()}/${config.STORAGE.BUCKET}`);
  url.searchParams.set("list-type", "2");
  url.searchParams.set("prefix", prefix);
  url.searchParams.set("max-keys", "1000");
  if (cursor) url.searchParams.set("continuation-token", cursor);

  const response = await getR2Client().fetch(url.toString(), { method: "GET" });
  if (!response.ok) await failUpstreamResponse("LIST", prefix, response);

  const xml = await response.text();

  const keys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) =>
    decodeXml(match[1]!),
  );
  const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(
    xml,
  );
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);

  return {
    keys,
    nextCursor: truncated && next ? decodeXml(next[1]!) : null,
  };
};

/**
 * Public URL for an object.
 *
 * Built from the custom domain, never from the S3 endpoint — that one
 * requires a signature on every request and would 403 in a browser. The
 * frontend gets thumbnails from this same URL via Cloudflare Images
 * transformations (`/cdn-cgi/image/width=400/<key>`), which is why no variant
 * objects or variant rows exist.
 */
export const buildPublicUrl = (key: string): string =>
  `${config.STORAGE.PUBLIC_URL}/${encodeKey(key)}`;
