import fs from "node:fs";
import path from "node:path";
import { OAS3Definition } from "swagger-jsdoc";
import config from "../../config/config";
import { COOKIE_NAMES } from "../../config/cookies-option";
import { roles, uploadFolders } from "../../config/constants";
import { FileStatus } from "@prisma/client";
import authPaths from "./auth.docs";
import filePaths from "./file.docs";

/**
 * Read the version from package.json at runtime.
 *
 * Deliberately not an `import` — package.json sits outside tsconfig's
 * `rootDir`, so importing it would fail the build and nest the emitted
 * output under `dist/src`. Resolving from `__dirname` works unchanged in
 * both `src/routes/docs` (ts-node) and `dist/routes/docs` (compiled).
 */
const readVersion = (): string => {
  try {
    const pkgPath = path.join(__dirname, "../../../package.json");
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version ?? "1.0.0";
  } catch {
    return "1.0.0";
  }
};

const version = readVersion();

/**
 * Base OpenAPI document.
 *
 * Paths are contributed by the sibling `*.docs.ts` files via swagger-jsdoc;
 * everything reusable (schemas, security schemes, common error responses)
 * lives here so individual route docs stay short.
 */
const swaggerDefinition: OAS3Definition = {
  openapi: "3.0.0",
  info: {
    title: "Node Express Boilerplate API",
    version,
    description:
      "REST API documentation. Authentication uses a short-lived access token " +
      "plus a long-lived refresh token; both are returned in the response body " +
      "and set as httpOnly cookies.",
  },
  servers: [
    {
      url: `http://localhost:${config.PORT}/api`,
      description: "Local development",
    },
  ],
  tags: [
    { name: "Auth", description: "Registration, login and sessions" },
    {
      name: "Files",
      description:
        "Product image and video uploads to Cloudflare R2. Staff and admin only.",
    },
  ],
  // One entry per route group. Add new groups as `<name>.docs.ts` alongside
  // this file and spread them in here.
  paths: {
    ...authPaths,
    ...filePaths,
  },
  components: {
    securitySchemes: {
      // The JWT strategy accepts either an Authorization header or the cookie.
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      },
      cookieAuth: {
        type: "apiKey",
        in: "cookie",
        name: COOKIE_NAMES.access,
      },
    },
    schemas: {
      User: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          email: { type: "string", format: "email" },
          firstName: { type: "string", nullable: true },
          lastName: { type: "string", nullable: true },
          role: { type: "string", enum: roles },
          emailVerifiedAt: {
            type: "string",
            format: "date-time",
            nullable: true,
            description:
              "When the mailbox was proven. Null until a verification " +
              "round-trip completes; ADMIN accounts are exempt from the gate " +
              "but are still null here until they verify.",
          },
        },
        example: {
          id: "6f3b9a1c-1f4e-4c2a-9d7b-2a5e8c0f1234",
          email: "user@example.com",
          firstName: "Jane",
          lastName: "Doe",
          role: "STAFF",
          emailVerifiedAt: null,
        },
      },
      /**
       * A browser login. The session is in the cookies; the body carries the
       * user and nothing else.
       *
       * There is deliberately no token here. The previous version of this
       * schema listed `token` and `refreshToken` "also set as an httpOnly
       * cookie", which meant any XSS in the SPA could read the login
       * response and take both — see docs/decisions.md §28.
       */
      AuthResponse: {
        type: "object",
        properties: {
          status: { type: "string", example: "success" },
          message: {
            type: "string",
            example: "Login successful. Welcome back!",
          },
          data: {
            type: "object",
            properties: {
              user: { $ref: "#/components/schemas/User" },
            },
          },
        },
      },
      /** A native login. No cookies; a code to trade at /token-exchange. */
      AuthCodeResponse: {
        type: "object",
        properties: {
          status: { type: "string", example: "success" },
          message: {
            type: "string",
            example: "Login successful. Welcome back!",
          },
          data: {
            type: "object",
            properties: {
              user: { $ref: "#/components/schemas/User" },
              authorizationCode: {
                type: "string",
                description:
                  "Single-use. Redeem at POST /app/auth/token-exchange with " +
                  "the code_verifier whose challenge was sent at login.",
              },
              expiresAt: {
                type: "string",
                format: "date-time",
                description: "Seconds away. It covers one round trip.",
              },
            },
          },
        },
      },
      /** The result of a token exchange: bearer tokens, in the body. */
      TokenResponse: {
        type: "object",
        properties: {
          status: { type: "string", example: "success" },
          message: {
            type: "string",
            example: "Login successful. Welcome back!",
          },
          data: {
            type: "object",
            properties: {
              user: { $ref: "#/components/schemas/User" },
              token: { type: "string", description: "Access token." },
              expires: { type: "string", format: "date-time" },
              refreshToken: { type: "string", description: "Refresh token." },
              refreshExpires: { type: "string", format: "date-time" },
            },
          },
        },
      },
      File: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          key: {
            type: "string",
            description:
              "Object key in R2: <folder>/<slug>-<uuid>.<ext>. The folder " +
              "is an allowlist lookup, the extension comes from the " +
              "sniffed type, and the slug is the uploaded filename reduced " +
              "to lowercase ASCII (it may be empty). Uniqueness is the " +
              "uuid's job, never the slug's.",
          },
          folder: {
            type: "string",
            enum: [...uploadFolders],
            description: "Bucket folder the caller asked for on upload.",
          },
          url: {
            type: "string",
            description:
              "Public URL on the bucket's custom domain. Thumbnails come " +
              "from the same URL via Cloudflare Images transformations " +
              "(/cdn-cgi/image/width=400/<key>) rather than stored variants.",
          },
          originalName: {
            type: "string",
            description:
              "The uploaded filename, sanitised: path segments, control " +
              "characters and bidirectional overrides removed, length " +
              "capped. Kept for display only.",
          },
          mimeType: {
            type: "string",
            description:
              "Sniffed from the file's magic bytes, never taken from the " +
              "client's declared Content-Type.",
          },
          size: { type: "integer", description: "Bytes." },
          etag: { type: "string", nullable: true },
          status: { type: "string", enum: Object.values(FileStatus) },
          uploadedById: { type: "string", format: "uuid", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        example: {
          id: "0a6b2d44-0b1e-4b0e-9a6f-6b0c6b2d4401",
          key: "product_images/blue-hoodie-front-0a6b2d44-0b1e-4b0e-9a6f-6b0c6b2d4401.jpg",
          url: "https://media.example.com/product_images/blue-hoodie-front-0a6b2d44-0b1e-4b0e-9a6f-6b0c6b2d4401.jpg",
          folder: "product_images",
          originalName: "blue-hoodie-front.jpg",
          mimeType: "image/jpeg",
          size: 184320,
          etag: "9bb58f26192e4ba00f01e2e7b136bbd8",
          status: "UNUSED",
          uploadedById: "6f3b9a1c-1f4e-4c2a-9d7b-2a5e8c0f1234",
          createdAt: "2026-11-04T10:15:00.000Z",
          updatedAt: "2026-11-04T10:15:00.000Z",
        },
      },
      Error: {
        type: "object",
        properties: {
          code: { type: "number" },
          message: { type: "string" },
        },
      },
    },
    responses: {
      BadRequest: {
        description: "Validation failed",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Error" },
            example: { code: 400, message: '"email" must be a valid email' },
          },
        },
      },
      Unauthorized: {
        description: "Missing or invalid credentials",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Error" },
            example: { code: 401, message: "Please authenticate." },
          },
        },
      },
      Forbidden: {
        description: "Authenticated but not permitted",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Error" },
            example: { code: 403, message: "Forbidden" },
          },
        },
      },
      NotFound: {
        description: "Resource not found",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Error" },
            example: { code: 404, message: "User not found." },
          },
        },
      },
      TooManyRequests: {
        description: "Rate limited, or the account is temporarily locked",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Error" },
            example: {
              code: 429,
              message: "Account is locked. Try again in 15 minute(s).",
            },
          },
        },
      },
    },
  },
};

export default swaggerDefinition;
