import fs from "node:fs";
import http from "node:http";
import { Readable } from "node:stream";
import crypto from "node:crypto";
import httpStatus from "http-status";
import * as storageService from "../../src/services/storage.service";
import * as r2Client from "../../src/config/r2-client";
import ApiError from "../../src/utils/api-error";
import config from "../../src/config/config";
import { startR2Stub, R2Stub } from "../helpers/r2-stub";
import { samples, padded, writeTempFile } from "../helpers/samples";

/**
 * Everything this project sends to R2, against a local stub.
 *
 * These assert the shape of the request on the wire, because that is where
 * the two R2-specific landmines are: a chunked body (which the S3 API will
 * not accept for a plain PUT) and the AWS SDK's `x-amz-checksum-crc32`
 * header (which R2 answers with 501 NotImplemented).
 */
describe("storage.service", () => {
  let stub: R2Stub;

  beforeAll(async () => {
    stub = await startR2Stub();
  });

  afterAll(async () => {
    await stub.close();
  });

  beforeEach(() => {
    stub.reset();
    // `restoreMocks` undoes the endpoint spy between tests; re-apply it.
    stub.install();
  });

  // `body: Buffer` is annotated rather than inferred: inferring it from the
  // default narrows to Buffer<ArrayBuffer>, which padded() does not satisfy.
  const put = async (key = "products/test.jpg", body: Buffer = samples.jpeg, md5?: string) =>
    storageService.putObject({
      key,
      body: fs.createReadStream(writeTempFile(body)),
      contentType: "image/jpeg",
      contentLength: body.length,
      ...(md5 ? { contentMd5: md5 } : {}),
    });

  /**
   * The ClientRequest for an upload already in flight. `putObject` awaits the
   * signature before it calls `http.request`, so the spy is not populated on
   * the tick the promise is created.
   */
  const waitForRequest = async (
    spy: jest.SpyInstance,
  ): Promise<http.ClientRequest> => {
    for (let i = 0; i < 100; i++) {
      if (spy.mock.results.length > 0) {
        return spy.mock.results[0]!.value as http.ClientRequest;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error("http.request was never called");
  };

  describe("putObject", () => {
    it("returns the ETag with its quotes stripped", async () => {
      const result = await put();
      const expected = crypto.createHash("md5").update(samples.jpeg).digest("hex");

      // The sibling api repo read this off the wrong object and stored
      // undefined for every upload; assert it is really populated.
      expect(result.etag).toBe(expected);
      expect(result.etag).not.toContain('"');
    });

    it("PUTs to /<bucket>/<key>", async () => {
      await put("products/abc-123.jpg");
      expect(stub.lastRequest().method).toBe("PUT");
      expect(stub.lastRequest().url).toBe("/test-bucket/products/abc-123.jpg");
    });

    it("sends Content-Length rather than chunked encoding", async () => {
      await put();
      const { headers } = stub.lastRequest();

      expect(headers["content-length"]).toBe(String(samples.jpeg.length));
      expect(headers["transfer-encoding"]).toBeUndefined();
    });

    it("sends the Content-Type it was given, not the client's", async () => {
      await put();
      expect(stub.lastRequest().headers["content-type"]).toBe("image/jpeg");
    });

    it("sends Content-MD5 and covers it with the signature", async () => {
      const md5 = crypto.createHash("md5").update(samples.jpeg).digest("base64");
      await put("products/x.jpg", samples.jpeg, md5);
      const { headers } = stub.lastRequest();

      expect(headers["content-md5"]).toBe(md5);
      // R2 implements Content-MD5, which is what replaces the CRC32 checksum
      // the AWS SDK would have sent. It only protects anything if it is
      // actually signed.
      expect(headers.authorization).toMatch(/SignedHeaders=[^,]*content-md5/);
    });

    it("sends NO x-amz-checksum-* header (R2 answers 501 to those)", async () => {
      await put();
      const checksums = Object.keys(stub.lastRequest().headers).filter((h) =>
        h.startsWith("x-amz-checksum"),
      );
      expect(checksums).toEqual([]);
    });

    it("signs with UNSIGNED-PAYLOAD, which is why a stream body is safe", async () => {
      await put();
      expect(stub.lastRequest().headers["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
    });

    it("streams the whole body", async () => {
      const big = padded("jpeg", 2 * 1024 * 1024);
      await put("products/big.jpg", big);
      expect(stub.lastRequest().bytes).toBe(big.length);
      expect(stub.objects.get("products/big.jpg")!.length).toBe(big.length);
    });

    it("raises 502 on a non-2xx and never leaks R2's response body", async () => {
      stub.failNext(403, "<Error><Message>internal-bucket-name-xyz</Message></Error>");

      const error = await put().catch((e: ApiError) => e);

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).statusCode).toBe(httpStatus.BAD_GATEWAY);
      expect((error as ApiError).message).not.toContain("internal-bucket-name-xyz");
    });

    it("passes a timeout to the request so a stalled upload cannot hang", async () => {
      // http.request has no default timeout: without one, an endpoint that
      // accepts the connection and then stalls would never settle, so the
      // temp file would never be unlinked and the response never sent.
      const spy = jest.spyOn(http, "request");

      await put();

      const options = spy.mock.calls[0]![1] as { timeout?: number };
      expect(options.timeout).toBeGreaterThan(0);
      spy.mockRestore();
    });
  });

  describe("deleteObject", () => {
    it("removes the object", async () => {
      await put("products/gone.jpg");
      expect(stub.objects.has("products/gone.jpg")).toBe(true);

      await storageService.deleteObject("products/gone.jpg");
      expect(stub.objects.has("products/gone.jpg")).toBe(false);
    });

    it("is idempotent — a 404 is not an error", async () => {
      stub.failNext(404, "<Error><Code>NoSuchKey</Code></Error>");
      await expect(storageService.deleteObject("products/never.jpg")).resolves.toBeUndefined();
    });

    it("retries a transient 5xx and then succeeds", async () => {
      // aws4fetch retries 5xx internally. That is wanted — but bounded; see
      // the retry test below.
      stub.failNext(503, "<Error/>", 1);
      await expect(storageService.deleteObject("products/x.jpg")).resolves.toBeUndefined();
      expect(stub.requests.filter((r) => r.method === "DELETE").length).toBe(2);
    });

    it("gives up after a bounded number of retries and raises 502", async () => {
      // The aws4fetch default is TEN retries with ~51s of cumulative backoff,
      // which would hang a user's delete request for most of a minute while
      // R2 is unhealthy. r2-client caps it; this pins that down.
      stub.failNext(500, "<Error/>", 50);

      const started = Date.now();
      await expect(storageService.deleteObject("products/x.jpg")).rejects.toMatchObject({
        statusCode: httpStatus.BAD_GATEWAY,
      });

      expect(stub.requests.filter((r) => r.method === "DELETE").length).toBeLessThanOrEqual(4);
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  });

  describe("headObject", () => {
    it("returns size and etag for an object that exists", async () => {
      await put("products/head.jpg");
      const head = await storageService.headObject("products/head.jpg");

      expect(head).toMatchObject({ size: samples.jpeg.length });
      expect(head!.etag).not.toContain('"');
    });

    it("returns null when the object is missing", async () => {
      await expect(storageService.headObject("products/missing.jpg")).resolves.toBeNull();
    });
  });

  describe("listObjects", () => {
    it("lists keys under a prefix", async () => {
      await put("products/a.jpg");
      await put("products/b.jpg");
      await put("documents/c.jpg");

      const page = await storageService.listObjects("products/");
      expect(page.keys.sort()).toEqual(["products/a.jpg", "products/b.jpg"]);
      expect(page.nextCursor).toBeNull();
    });

    it("pages through a truncated listing", async () => {
      for (let i = 0; i < 5; i++) await put(`products/f${i}.jpg`);

      const seen: string[] = [];
      let cursor: string | undefined;
      let guard = 0;
      do {
        const page = await storageService.listObjects("products/", cursor);
        seen.push(...page.keys);
        cursor = page.nextCursor ?? undefined;
      } while (cursor && ++guard < 10);

      expect(seen.sort()).toEqual([
        "products/f0.jpg", "products/f1.jpg", "products/f2.jpg",
        "products/f3.jpg", "products/f4.jpg",
      ]);
    });

    it("decodes XML entities in keys", async () => {
      await put("products/a&b.jpg");
      const page = await storageService.listObjects("products/");
      expect(page.keys).toContain("products/a&b.jpg");
    });
  });

  describe("buildPublicUrl", () => {
    it("uses the public domain, not the signed S3 endpoint", () => {
      expect(storageService.buildPublicUrl("products/a.jpg")).toBe(
        `${config.STORAGE.PUBLIC_URL}/products/a.jpg`,
      );
    });

    it("does not produce a double slash", () => {
      expect(storageService.buildPublicUrl("products/a.jpg")).not.toMatch(/[^:]\/\//);
    });
  });

  describe("when storage is switched off", () => {
    beforeEach(() => {
      jest.spyOn(r2Client, "isStorageEnabled").mockReturnValue(false);
    });

    const calls: [string, () => Promise<unknown>][] = [
      ["putObject", () => put()],
      ["deleteObject", () => storageService.deleteObject("products/a.jpg")],
      ["headObject", () => storageService.headObject("products/a.jpg")],
      ["listObjects", () => storageService.listObjects("products/")],
    ];

    it.each(calls)("%s refuses with 503", async (_name, call) => {
      const error = await call().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).statusCode).toBe(httpStatus.SERVICE_UNAVAILABLE);
    });

    it("refuses before anything reaches the wire", async () => {
      // `file.service.deleteFile` marks the row PENDING_DELETE *before*
      // calling deleteObject. If the check happened any later than this,
      // a disabled deployment would strand rows in PENDING_DELETE with no
      // object to finish deleting.
      await Promise.all(calls.map(([, call]) => call().catch(() => undefined)));

      expect(stub.requests).toEqual([]);
    });

    it("still builds a public URL, which talks to nothing", () => {
      // Reads go to the custom domain and do not involve the S3 API at all,
      // so existing images keep rendering while uploads are switched off.
      expect(storageService.buildPublicUrl("products/a.jpg")).toBe(
        `${config.STORAGE.PUBLIC_URL}/products/a.jpg`,
      );
    });
  });

  describe("keys that need encoding", () => {
    // `encodeKey` percent-encodes each segment and keeps the separators.
    // `#` and `?` are the dangerous two: unencoded, the URL parser treats
    // the rest of the key as a fragment or a query string, so the object
    // lands under a truncated name and every later HEAD and DELETE misses
    // it. `encodeURIComponent` over the whole key is the opposite mistake —
    // it turns the separators into %2F and creates one object with literal
    // slashes in its name.
    const keys: [string, string, string][] = [
      ["a space", "products/my photo.jpg", "products/my%20photo.jpg"],
      ["a hash", "products/a#b.jpg", "products/a%23b.jpg"],
      ["a question mark", "products/a?b.jpg", "products/a%3Fb.jpg"],
      ["a plus", "products/a+b.jpg", "products/a%2Bb.jpg"],
      ["non-ascii", "products/café.jpg", "products/caf%C3%A9.jpg"],
    ];

    it.each(keys)("encodes %s", async (_label, key, encoded) => {
      await put(key);

      expect(stub.lastRequest().url).toBe(`/test-bucket/${encoded}`);
      // Decoded on arrival, so the object is stored under the real key.
      expect(stub.objects.has(key)).toBe(true);
    });

    it("keeps the separators as real slashes", async () => {
      await put("products/nested/deep/a.jpg");

      expect(stub.lastRequest().url).toBe("/test-bucket/products/nested/deep/a.jpg");
      expect(stub.lastRequest().url).not.toContain("%2F");
    });

    it("finds the object again with the same encoding", async () => {
      // put and head must agree. If only one of them encoded, an upload
      // would succeed and then appear missing to the orphan sweep, which
      // deletes rows whose object it cannot find.
      await put("products/my photo.jpg");

      await expect(
        storageService.headObject("products/my photo.jpg"),
      ).resolves.toMatchObject({ size: samples.jpeg.length });
    });
  });

  describe("the ETag R2 sends back", () => {
    it("is null when R2 omits the header", async () => {
      // Not hypothetical: a proxy in front of R2 can strip it. The column is
      // nullable precisely so this does not fail the upload.
      stub.respondNext({ status: 200 });

      await expect(put()).resolves.toMatchObject({ etag: null });
    });

    it("has a weak validator prefix stripped", async () => {
      stub.respondNext({ status: 200, headers: { ETag: 'W/"abc123"' } });

      await expect(put()).resolves.toMatchObject({ etag: "abc123" });
    });
  });

  describe("Content-MD5 integrity", () => {
    it("is refused by R2 when the digest does not match the body", async () => {
      // The reason the missing CRC32 checksum costs nothing (decisions §7):
      // R2 verifies Content-MD5 and rejects a corrupted body itself. The
      // stub enforces it the same way.
      const wrong = crypto.createHash("md5").update("something else").digest("base64");

      const error = await put("products/corrupt.jpg", samples.jpeg, wrong).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).statusCode).toBe(httpStatus.BAD_GATEWAY);
      expect(stub.objects.has("products/corrupt.jpg")).toBe(false);
    });

    it("is absent, and unsigned, when no digest was supplied", async () => {
      await put();

      expect(stub.lastRequest().headers["content-md5"]).toBeUndefined();
      expect(stub.lastRequest().headers.authorization).not.toMatch(
        /SignedHeaders=[^,]*content-md5/,
      );
    });
  });

  describe("the upload stream", () => {
    it("rejects rather than hanging when a read fails mid-upload", async () => {
      // Reached through `body.on("error")`. Without that listener the
      // promise never settles: `createFile`'s `finally` never unlinks the
      // temp file and the HTTP request never answers.
      const failing = new Readable({
        read() {
          this.destroy(new Error("EIO: disk read failed"));
        },
      });

      await expect(
        storageService.putObject({
          key: "products/ghost.jpg",
          body: failing,
          contentType: "image/jpeg",
          contentLength: 10,
        }),
      ).rejects.toThrow(/disk read failed/);
    });

    it("rejects when the socket stalls, instead of waiting forever", async () => {
      // `http.request` has no default timeout, so without the handler this
      // promise never settles: the temp file is never unlinked and the HTTP
      // response never goes out. The real limit is two minutes, so the
      // event is raised directly rather than waited out — what is being
      // proved is the handler, not node's timer.
      stub.hangNext();
      const spy = jest.spyOn(http, "request");

      const promise = storageService.putObject({
        key: "products/stall.jpg",
        body: fs.createReadStream(writeTempFile(samples.jpeg)),
        contentType: "image/jpeg",
        contentLength: samples.jpeg.length,
      });

      const request = await waitForRequest(spy);
      request.emit("timeout");

      await expect(promise).rejects.toThrow(/timed out/);
      spy.mockRestore();
    });

    it("is destroyed when the upload fails", async () => {
      // `pipe` unpipes on a destination error but does NOT close the source,
      // so without the explicit destroy every failed upload leaks an open
      // file descriptor until GC gets round to it.
      stub.failNext(500, "<Error/>");
      const body = fs.createReadStream(writeTempFile(samples.jpeg));

      await storageService
        .putObject({
          key: "products/leak.jpg",
          body,
          contentType: "image/jpeg",
          contentLength: samples.jpeg.length,
        })
        .catch(() => undefined);

      expect(body.destroyed).toBe(true);
    });
  });

  describe("headObject, the remaining paths", () => {
    it("returns the stored content type", async () => {
      await put("products/ct.jpg");

      await expect(storageService.headObject("products/ct.jpg")).resolves.toMatchObject({
        contentType: "application/octet-stream",
      });
    });

    it("reports size 0 rather than NaN when Content-Length is missing", async () => {
      stub.respondNext({ status: 200 });

      await expect(storageService.headObject("products/x.jpg")).resolves.toMatchObject({
        size: 0,
      });
    });

    it("raises 502 on a failure that is not a 404", async () => {
      // A 404 means "no such object" and is a normal answer; anything else
      // is R2 being unhealthy and must not be mistaken for an empty bucket,
      // or the orphan sweep would treat every row as orphaned.
      stub.failNext(403);

      await expect(storageService.headObject("products/x.jpg")).rejects.toMatchObject({
        statusCode: httpStatus.BAD_GATEWAY,
      });
    });
  });

  describe("listObjects, the remaining paths", () => {
    it("asks for ListObjectsV2 with a bounded page size", async () => {
      await storageService.listObjects("products/");
      const url = new URL(stub.lastRequest().url, "http://stub");

      // list-type=2 is not optional: without it S3 answers with the V1
      // schema, which has no NextContinuationToken, so paging silently stops
      // after the first 1000 keys.
      expect(url.searchParams.get("list-type")).toBe("2");
      expect(url.searchParams.get("prefix")).toBe("products/");
      expect(Number(url.searchParams.get("max-keys"))).toBeGreaterThan(0);
      expect(url.searchParams.get("continuation-token")).toBeNull();
    });

    it("sends the cursor back as continuation-token", async () => {
      await storageService.listObjects("products/", "cursor-abc");
      const url = new URL(stub.lastRequest().url, "http://stub");

      expect(url.searchParams.get("continuation-token")).toBe("cursor-abc");
    });

    it("returns an empty page for a prefix with nothing under it", async () => {
      await expect(storageService.listObjects("nothing/")).resolves.toEqual({
        keys: [],
        nextCursor: null,
      });
    });

    it("raises 502 when the listing fails", async () => {
      stub.failNext(403);

      await expect(storageService.listObjects("products/")).rejects.toMatchObject({
        statusCode: httpStatus.BAD_GATEWAY,
      });
    });
  });

  describe("across every verb", () => {
    it("sends no x-amz-checksum-* header anywhere", async () => {
      // The PUT case is asserted above; this sweeps the other three. The
      // header is what R2 answers 501 to, and it is the single reason this
      // project is not on @aws-sdk/client-s3 — so pin it for the whole
      // surface, not just the verb that triggered it.
      await put("products/sweep.jpg");
      await storageService.headObject("products/sweep.jpg");
      await storageService.listObjects("products/");
      await storageService.deleteObject("products/sweep.jpg");

      const offenders = stub.requests.flatMap((request) =>
        Object.keys(request.headers)
          .filter((header) => header.startsWith("x-amz-checksum"))
          .map((header) => `${request.method} ${header}`),
      );

      expect(stub.requests).toHaveLength(4);
      expect(offenders).toEqual([]);
    });

    it("signs every request with the region R2 requires", async () => {
      await put("products/scope.jpg");
      await storageService.headObject("products/scope.jpg");
      await storageService.listObjects("products/");
      await storageService.deleteObject("products/scope.jpg");

      for (const request of stub.requests) {
        expect(request.headers.authorization).toMatch(/\/auto\/s3\/aws4_request/);
      }
    });
  });
});
