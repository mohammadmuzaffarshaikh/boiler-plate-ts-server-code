import http from "node:http";
import crypto from "node:crypto";
import { AddressInfo } from "node:net";
import * as r2Client from "../../src/config/r2-client";

/**
 * An in-memory stand-in for Cloudflare R2's S3 API.
 *
 * The storage specs need to assert what goes *onto the wire* — that
 * `Content-Length` is sent rather than chunked encoding, that `Content-MD5`
 * is covered by the signature, that no `x-amz-checksum-*` header appears
 * (R2 answers 501 to those). A mocked module cannot show any of that, so
 * this is a real HTTP server and the real signing path runs against it.
 *
 * Nothing leaves the machine, and no Cloudflare credentials are involved.
 *
 * It verifies `Content-MD5` the way R2 does, rejecting a mismatch with 400.
 * That is the one piece of R2's behaviour the integrity story depends on
 * (docs/decisions.md §7), so a stub that accepted anything would let a
 * regression in the signing path pass unnoticed.
 */

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  bytes: number;
}

/** A canned response, used for the paths R2 reaches but the stub cannot. */
export interface CannedResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
  /** How many requests it applies to. Default 1. */
  times?: number;
}

export interface R2Stub {
  url: string;
  /**
   * Point `getR2Endpoint()` at this stub.
   *
   * Call it from `beforeEach`, never `beforeAll`: `restoreMocks: true` in
   * jest.config.ts runs `restoreAllMocks()` before every test, so a spy
   * installed once is gone by the time the first test body runs.
   */
  install(): void;
  /** Objects currently "in the bucket", keyed by object key. */
  objects: Map<string, Buffer>;
  /** Every request the stub received, in order. */
  requests: RecordedRequest[];
  /** The most recent request. */
  lastRequest(): RecordedRequest;
  /**
   * Answer the next N requests with this exact status, body and headers,
   * bypassing the bucket entirely. Nothing else is added — notably no
   * `ETag` — so a 2xx here is also how the "R2 omitted the ETag" and weak
   * validator paths are reached.
   */
  respondNext(response: CannedResponse): void;
  /** `respondNext` for the common failure case. */
  failNext(status: number, body?: string, times?: number): void;
  /**
   * Accept the next request and never answer it, holding the socket open.
   * Stands in for an R2 endpoint that takes the connection and then stalls
   * — the case `UPLOAD_TIMEOUT_MS` exists for.
   */
  hangNext(): void;
  reset(): void;
  close(): Promise<void>;
}

const xmlEscape = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

export const startR2Stub = async (): Promise<R2Stub> => {
  const objects = new Map<string, Buffer>();
  const requests: RecordedRequest[] = [];
  let canned: CannedResponse | null = null;
  let hang = false;
  const openSockets = new Set<import("node:net").Socket>();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    let bytes = 0;

    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      chunks.push(chunk);
    });

    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        bytes,
      });

      if (hang) {
        hang = false;
        // Deliberately no res.end(): the socket stays open and the client
        // waits. `close()` destroys it so the suite can still shut down.
        openSockets.add(req.socket);
        return;
      }

      if (canned && (canned.times ?? 1) > 0) {
        canned.times = (canned.times ?? 1) - 1;
        res.writeHead(canned.status, {
          "content-type": "application/xml",
          ...canned.headers,
        });
        res.end(canned.body ?? "");
        return;
      }

      const parsed = new URL(req.url ?? "/", "http://stub");
      // Paths arrive as /<bucket>/<key...>
      const key = decodeURIComponent(
        parsed.pathname.replace(/^\/[^/]+\/?/, ""),
      );

      if (req.method === "PUT") {
        const body = Buffer.concat(chunks);

        // R2 implements Content-MD5 and rejects a body that does not match.
        // This is what stands in for the AWS SDK's CRC32 checksum, so the
        // stub has to enforce it or the specs prove nothing about integrity.
        const declared = req.headers["content-md5"];
        if (typeof declared === "string") {
          const actual = crypto.createHash("md5").update(body).digest("base64");
          if (actual !== declared) {
            res.writeHead(400, { "content-type": "application/xml" });
            res.end(
              "<Error><Code>BadDigest</Code><Message>The Content-MD5 you " +
                "specified did not match what we received.</Message></Error>",
            );
            return;
          }
        }

        objects.set(key, body);
        const etag = crypto.createHash("md5").update(body).digest("hex");
        res.writeHead(200, { ETag: `"${etag}"` });
        res.end();
        return;
      }

      if (req.method === "DELETE") {
        objects.delete(key);
        // S3 answers 204 whether or not the key was there; the 404 branch is
        // exercised by `failNext` instead.
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === "HEAD") {
        const object = objects.get(key);
        if (!object) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, {
          "Content-Length": String(object.length),
          ETag: `"${crypto.createHash("md5").update(object).digest("hex")}"`,
          "Content-Type": "application/octet-stream",
        });
        res.end();
        return;
      }

      // GET => ListObjectsV2
      const prefix = parsed.searchParams.get("prefix") ?? "";
      const maxKeys = Number(parsed.searchParams.get("max-keys") ?? "1000");
      const after = parsed.searchParams.get("continuation-token");

      const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = after ? all.indexOf(after) + 1 : 0;
      const page = all.slice(start, start + maxKeys);
      const truncated = start + maxKeys < all.length;
      const next = truncated ? page[page.length - 1] : undefined;

      res.writeHead(200, { "content-type": "application/xml" });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
          `<IsTruncated>${truncated}</IsTruncated>` +
          (next
            ? `<NextContinuationToken>${xmlEscape(next)}</NextContinuationToken>`
            : "") +
          page
            .map((k) => `<Contents><Key>${xmlEscape(k)}</Key></Contents>`)
            .join("") +
          `</ListBucketResult>`,
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    // The endpoint is derived from the account id as an
    // https://<id>.r2.cloudflarestorage.com host, so no environment variable
    // can point it at localhost. Overriding the accessor is the narrowest
    // way in, and leaves signing, transport and response handling real.
    install: () => {
      jest.spyOn(r2Client, "getR2Endpoint").mockReturnValue(url);
    },
    objects,
    requests,
    lastRequest: () => requests[requests.length - 1]!,
    respondNext: (response) => {
      canned = { times: 1, ...response };
    },
    failNext: (status, body = "<Error><Code>Stub</Code></Error>", times = 1) => {
      canned = { status, body, times };
    },
    hangNext: () => {
      hang = true;
    },
    reset: () => {
      objects.clear();
      requests.length = 0;
      canned = null;
      hang = false;
      openSockets.forEach((socket) => socket.destroy());
      openSockets.clear();
    },
    close: () =>
      new Promise<void>((resolve) => {
        // A hung request still holds a socket; `server.close` would wait on
        // it forever and the suite would never exit.
        openSockets.forEach((socket) => socket.destroy());
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};
