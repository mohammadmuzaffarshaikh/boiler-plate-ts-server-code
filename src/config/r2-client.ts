import { AwsClient } from "aws4fetch";
import config from "./config";

/**
 * Signed HTTP client for Cloudflare R2's S3-compatible API.
 *
 * WHY aws4fetch AND NOT @aws-sdk/client-s3:
 * From v3.729 the AWS SDK adds an `x-amz-checksum-crc32` header to every PUT
 * by default. R2 does not implement it and answers `501 NotImplemented`
 * (aws/aws-sdk-js-v3#6810, open at the time of writing). aws4fetch has no
 * middleware stack to inject anything, so the whole class of problem is gone
 * by construction — it signs the request and nothing else. It is also ~88 KB
 * with zero dependencies against the SDK's several MB, and Cloudflare's own
 * R2 documentation uses it.
 *
 * Integrity is still covered: `storage.service` sends `Content-MD5`, which R2
 * *does* implement, so a corrupted upload is rejected by the server.
 *
 * `region: "auto"` is required by R2 — it is a single global namespace and
 * rejects a real AWS region name in the signature.
 *
 * @see https://developers.cloudflare.com/r2/api/s3/api/
 */
class R2Singleton {
  private static instance: AwsClient;

  private constructor() {}

  public static getInstance(): AwsClient {
    if (!R2Singleton.instance) {
      R2Singleton.instance = new AwsClient({
        accessKeyId: config.STORAGE.ACCESS_KEY_ID,
        secretAccessKey: config.STORAGE.SECRET_ACCESS_KEY,
        service: "s3",
        region: "auto",

        // aws4fetch defaults to TEN retries on 5xx/429 with exponential
        // backoff, which adds up to ~51 seconds of sleeping on top of eleven
        // requests. These calls (DELETE, HEAD, LIST) sit on the HTTP request
        // path, so that default turns a bad minute at R2 into requests that
        // hang for most of a minute before failing anyway. Three attempts
        // with ~150ms of backoff absorbs a blip and then gives up promptly.
        //
        // `putObject` is unaffected either way: it streams over node:http and
        // never goes through AwsClient.fetch.
        retries: 2,
        initRetryMs: 50,
      });
    }

    return R2Singleton.instance;
  }
}

/**
 * Lazily built, unlike `prisma`. Constructing it at import time would run on
 * every `import config` path — tests, CLI scripts, `prisma generate` — and
 * would do so with empty credentials whenever R2 is switched off.
 */
export const getR2Client = (): AwsClient => R2Singleton.getInstance();

/**
 * Base endpoint for the S3 API. Never handed to a browser: reads go to
 * `PUBLIC_URL`.
 *
 * Read from configuration rather than built from the account id here, so
 * that pointing at another R2 jurisdiction, an S3-compatible provider or a
 * local MinIO is an environment change and not a code change. Validated at
 * boot to carry no bucket and no path — `storage.service` appends
 * `/<bucket>/<key>` itself.
 */
export const getR2Endpoint = (): string => config.STORAGE.ENDPOINT;

/** Whether upload routes should do anything but refuse. */
export const isStorageEnabled = (): boolean => config.STORAGE.ENABLED;
