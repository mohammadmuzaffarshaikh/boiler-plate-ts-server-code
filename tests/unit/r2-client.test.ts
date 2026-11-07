import config from "../../src/config/config";
import {
  getR2Client,
  getR2Endpoint,
  isStorageEnabled,
} from "../../src/config/r2-client";

/**
 * The signed client itself: the endpoint it talks to, and the four signing
 * properties `storage.service` is built on top of.
 *
 * Worth its own file because every other spec mocks `getR2Endpoint`, so
 * nothing else ever runs the real one — and because the signing assumptions
 * in `putObject` are assumptions about *aws4fetch*, not about our code. They
 * hold today; a minor version bump could change any of them, and the failure
 * would otherwise show up as an opaque `SignatureDoesNotMatch` from R2 in
 * production rather than a red test here.
 *
 * No network: `sign()` returns a Request without sending it.
 */

const SOME_OBJECT = "https://acct.r2.cloudflarestorage.com/bucket/products/a.jpg";

/** The headers aws4fetch produced for a signed request, lowercased. */
const signedHeaders = async (
  init: RequestInit = { method: "PUT" },
): Promise<Headers> => (await getR2Client().sign(SOME_OBJECT, init)).headers;

/** The `SignedHeaders=` list out of an Authorization header. */
const signedHeaderList = (authorization: string): string[] => {
  const match = /SignedHeaders=([^,]+)/.exec(authorization);
  return match ? match[1]!.split(";") : [];
};

describe("getR2Endpoint", () => {
  it("comes from configuration, not from a template in the code", () => {
    // Every other spec replaces this with a localhost stub, so this is the
    // only place the real accessor is exercised. Holding the URL in the
    // environment is what lets another R2 jurisdiction, an S3-compatible
    // provider or a local MinIO be pointed at without a code change.
    expect(getR2Endpoint()).toBe(config.STORAGE.ENDPOINT);
  });

  it("does not reconstruct the host from the account id", () => {
    // Guards the regression: ACCOUNT_ID is still in config for the
    // Cloudflare API and Images transforms, so deriving the endpoint from
    // it again would compile and pass everything else.
    const previous = config.STORAGE.ENDPOINT;
    config.STORAGE.ENDPOINT = "https://minio.internal:9000";
    try {
      expect(getR2Endpoint()).toBe("https://minio.internal:9000");
      expect(getR2Endpoint()).not.toContain(config.STORAGE.ACCOUNT_ID);
    } finally {
      config.STORAGE.ENDPOINT = previous;
    }
  });

  it("is https, and is not the public read URL", () => {
    // Two different hosts doing two different jobs. The S3 endpoint needs a
    // signature on every request, so handing it to a browser produces a 403;
    // PUBLIC_URL is the custom domain that serves reads. Confusing them is
    // the single most likely way to ship broken image URLs.
    expect(getR2Endpoint()).toMatch(/^https:\/\//);
    expect(getR2Endpoint()).not.toBe(config.STORAGE.PUBLIC_URL);
  });

  it("carries no bucket and no trailing slash", () => {
    // `storage.service` appends `/<bucket>/<key>`; a trailing slash here
    // would produce a double slash, which S3 reads as an empty path segment.
    expect(getR2Endpoint()).not.toMatch(/\/$/);
    expect(getR2Endpoint()).not.toContain(config.STORAGE.BUCKET);
  });
});

describe("isStorageEnabled", () => {
  const enabled = config.STORAGE.ENABLED;
  afterEach(() => {
    config.STORAGE.ENABLED = enabled;
  });

  it("mirrors the config flag", () => {
    config.STORAGE.ENABLED = true;
    expect(isStorageEnabled()).toBe(true);
    config.STORAGE.ENABLED = false;
    expect(isStorageEnabled()).toBe(false);
  });

  it("is read at call time, not captured at import", () => {
    // `file.service` and `storage.service` both gate on this per request. If
    // it were captured at module load, flipping R2_ENABLED would need a
    // restart and the 503 path would be untestable.
    config.STORAGE.ENABLED = false;
    expect(isStorageEnabled()).toBe(false);
    config.STORAGE.ENABLED = true;
    expect(isStorageEnabled()).toBe(true);
  });
});

describe("getR2Client", () => {
  it("returns the same instance every time", () => {
    // A new AwsClient per call would rebuild the signing key on every
    // request, and would quietly undo the retry caps set in the constructor.
    expect(getR2Client()).toBe(getR2Client());
  });
});

describe("the signature", () => {
  it('scopes the credential to region "auto" and service "s3"', async () => {
    // R2 is a single global namespace and rejects a real AWS region name in
    // the credential scope. This is the one setting that is not optional.
    const authorization = (await signedHeaders()).get("authorization")!;
    expect(authorization).toMatch(/Credential=[^/]+\/\d{8}\/auto\/s3\/aws4_request/);
  });

  it("uses UNSIGNED-PAYLOAD, which is what makes a streamed body safe", async () => {
    // `putObject` signs a request with no body and then pipes the file to a
    // separate node:http request. That is only sound because the payload is
    // not part of the signature — otherwise the two would disagree and R2
    // would answer SignatureDoesNotMatch.
    expect((await signedHeaders()).get("x-amz-content-sha256")).toBe(
      "UNSIGNED-PAYLOAD",
    );
  });

  it("covers Content-MD5", async () => {
    // Integrity rests on this. An unsigned Content-MD5 could be rewritten in
    // flight to match a corrupted body, which would make the header
    // decorative. See docs/decisions.md §7.
    const headers = await signedHeaders({
      method: "PUT",
      headers: { "Content-MD5": "rL0Y20zC+Fzt72VPzMSk2A==" },
    });

    expect(signedHeaderList(headers.get("authorization")!)).toContain("content-md5");
  });

  it("does NOT cover content-type or content-length", async () => {
    // The other half of the same arrangement: `putObject` adds both of these
    // *after* signing, which is only safe while aws4fetch treats them as
    // unsignable. If this ever flips, those two headers must move into the
    // signed set or every upload fails.
    const headers = await signedHeaders({
      method: "PUT",
      headers: { "Content-Type": "image/jpeg", "Content-Length": "1234" },
    });

    const signed = signedHeaderList(headers.get("authorization")!);
    expect(signed).not.toContain("content-type");
    expect(signed).not.toContain("content-length");
  });

  it("adds no x-amz-checksum-* header", async () => {
    // The whole reason this project is not on @aws-sdk/client-s3: from
    // v3.729 the SDK sends x-amz-checksum-crc32 by default and R2 answers
    // 501 NotImplemented. aws4fetch has no middleware stack to inject one.
    const headers = await signedHeaders();
    const checksums = [...headers.keys()].filter((h) =>
      h.startsWith("x-amz-checksum"),
    );

    expect(checksums).toEqual([]);
  });
});

describe("the boot-time endpoint check", () => {
  /** Re-import config.ts under a modified environment, then put it back. */
  const loadConfigWith = async (endpoint: string): Promise<void> => {
    const previous = process.env.R2_ENDPOINT;
    process.env.R2_ENDPOINT = endpoint;
    try {
      await jest.isolateModulesAsync(async () => {
        await import("../../src/config/config");
      });
    } finally {
      process.env.R2_ENDPOINT = previous;
    }
  };

  it("refuses an endpoint with the bucket in the path", async () => {
    // Cloudflare's dashboard labels `<origin>/<bucket>` as the "S3 API"
    // value, so pasting it verbatim is the obvious mistake — and a silent
    // one, because every object would land under `/<bucket>/<bucket>/<key>`
    // where nothing looks for it.
    await expect(
      loadConfigWith("https://acct.r2.cloudflarestorage.com/test-e-com"),
    ).rejects.toThrow(/must be an origin with no path/);
  });

  it("refuses an endpoint carrying a query string", async () => {
    await expect(
      loadConfigWith("https://acct.r2.cloudflarestorage.com/?x=1"),
    ).rejects.toThrow(/must be an origin with no path/);
  });

  it("refuses a value pasted without a scheme", async () => {
    // The other easy paste from the dashboard. Unguarded, `new URL` threw a
    // raw ERR_INVALID_URL at import time — a stack trace naming config.ts
    // and never naming R2_ENDPOINT.
    await expect(
      loadConfigWith("1d0e8e72.r2.cloudflarestorage.com"),
    ).rejects.toThrow(/R2_ENDPOINT/);
  });

  it("refuses a non-http scheme", async () => {
    await expect(
      loadConfigWith("ftp://acct.r2.cloudflarestorage.com"),
    ).rejects.toThrow(/R2_ENDPOINT/);
  });

  it("names the variable rather than throwing a bare TypeError", async () => {
    let caught: unknown;
    try {
      await loadConfigWith("not a url at all");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error;
    expect(error.constructor.name).not.toBe("TypeError");
    expect(error.message).toMatch(/R2_ENDPOINT/);
  });

  it("accepts a bare origin", async () => {
    await expect(
      loadConfigWith("https://acct.r2.cloudflarestorage.com"),
    ).resolves.toBeUndefined();
  });

  it("accepts an origin with a trailing slash, and strips it", async () => {
    // `storage.service` builds `${endpoint}/${bucket}/${key}`, so a trailing
    // slash here would produce a double slash, which S3 reads as an empty
    // path segment.
    await expect(
      loadConfigWith("https://acct.r2.cloudflarestorage.com/"),
    ).resolves.toBeUndefined();
  });
});
