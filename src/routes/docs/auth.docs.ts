import { OAS3Definition } from "swagger-jsdoc";

/**
 * OpenAPI path definitions for `src/routes/auth.routes.ts`.
 *
 * WHY PLAIN OBJECTS AND NOT `@swagger` JSDoc ANNOTATIONS:
 * TypeScript drops comments that are not attached to emitted code. A file of
 * standalone `@swagger` blocks compiles down to an empty module, so
 * swagger-jsdoc would find nothing when scanning `dist/` and production would
 * serve docs with zero paths — silently. Exported objects cannot be stripped,
 * are type-checked against the OpenAPI shape, and behave identically under
 * ts-node and compiled output. Please don't convert these back to comments.
 *
 * Paths are relative to the server URL, which already includes `/api`.
 */

type Paths = NonNullable<OAS3Definition["paths"]>;

/** `$ref` shorthands for the shared responses in `swagger-definition.ts`. */
const ref = (name: string) => ({ $ref: `#/components/responses/${name}` });
const errorSchema = { $ref: "#/components/schemas/Error" };
const authResponse = {
  description:
    "Logged in. A browser login (`client` absent or `web`) carries the " +
    "session in httpOnly cookies and returns no tokens; a native login " +
    "(`client: native`) returns a single-use authorization code and sets no " +
    "cookies.",
  content: {
    "application/json": {
      schema: {
        oneOf: [
          { $ref: "#/components/schemas/AuthResponse" },
          { $ref: "#/components/schemas/AuthCodeResponse" },
        ],
      },
    },
  },
};

/**
 * The `client` / PKCE fields, shared by both login routes.
 *
 * Mutually exclusive with the browser shape by construction: `codeChallenge`
 * is required when `client` is `native` and forbidden otherwise, so a page
 * cannot opt itself into being handed a code.
 */
const clientFields = {
  client: {
    type: "string",
    enum: ["web", "native"],
    description:
      "Omit (or send `web`) for a browser: the session comes back as " +
      "httpOnly cookies and no token appears anywhere a script can read it. " +
      "Send `native` for a client with no cookie jar.",
  },
  codeChallenge: {
    type: "string",
    description:
      "PKCE challenge: base64url(sha256(code_verifier)), 43 characters. " +
      "Required when `client` is `native`, forbidden otherwise.",
  },
  codeChallengeMethod: {
    type: "string",
    enum: ["S256"],
    description: "S256 only. `plain` is not accepted.",
  },
};

/** Build a JSON request body with the given schema. */
const jsonBody = (schema: object, required = true) => ({
  required,
  content: { "application/json": { schema } },
});

const passwordField = {
  type: "string",
  format: "password",
  description:
    "At least 8 characters, containing at least one letter and one number.",
};

/** Optional refresh token in the body; falls back to the httpOnly cookie. */
const optionalRefreshBody = jsonBody(
  {
    type: "object",
    properties: {
      refreshToken: {
        type: "string",
        description: "Optional; falls back to the httpOnly cookie.",
      },
    },
  },
  false
);

const authPaths: Paths = {
  "/app/auth/register": {
    post: {
      summary: "Register a new staff account (development only)",
      description:
        "Creates the account only. It does not log the user in — no tokens " +
        "or cookies are issued.\n\n" +
        "**Mounted only when NODE_ENV=development.** A row in `users` is a " +
        "member of staff, so self-service registration is a way to mint a " +
        "staff account without an invitation. Outside development the route " +
        "is never registered and answers 404. These docs are themselves " +
        "development-only, so the endpoint is documented wherever it exists.",
      tags: ["Auth"],
      requestBody: jsonBody({
        type: "object",
        required: ["firstName", "lastName", "email", "password"],
        properties: {
          firstName: { type: "string" },
          lastName: { type: "string" },
          email: { type: "string", format: "email" },
          password: passwordField,
        },
        example: {
          firstName: "Jane",
          lastName: "Doe",
          email: "user@example.com",
          password: "password1",
        },
      }),
      responses: {
        "201": {
          description: "Account created",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  status: { type: "string" },
                  message: { type: "string" },
                  data: {
                    type: "object",
                    properties: {
                      user: { $ref: "#/components/schemas/User" },
                    },
                  },
                },
              },
            },
          },
        },
        "400": ref("BadRequest"),
        "429": ref("TooManyRequests"),
      },
    },
  },

  "/app/auth/login": {
    post: {
      summary: "Log in with email and password",
      description:
        "Two client shapes, one endpoint. A **browser** login sets httpOnly " +
        "cookies and returns no tokens at all — the body copy this used to " +
        "return handed any XSS both credentials, which is what `httpOnly` " +
        "exists to prevent. A **native** login sends a PKCE challenge, " +
        "receives a single-use authorization code, and trades it at " +
        "`/app/auth/token-exchange`. Repeated failures lock the account.",
      tags: ["Auth"],
      requestBody: jsonBody({
        type: "object",
        required: ["email", "password"],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string", format: "password" },
          ...clientFields,
        },
        example: { email: "user@example.com", password: "password1" },
      }),
      responses: {
        "200": authResponse,
        "400": ref("BadRequest"),
        "401": ref("Unauthorized"),
        "429": ref("TooManyRequests"),
      },
    },
  },

  "/app/auth/google": {
    post: {
      summary: "Log in with a Google ID token",
      description:
        "Verifies a Google Identity Services credential and signs the user in. " +
        "Accounts are never created here — an email with no existing account is " +
        "rejected with 403. On the first Google sign-in for an existing account, " +
        "the Google `sub` is linked to that user. Returns 501 when " +
        "`GOOGLE_CLIENT_ID` is not configured.",
      tags: ["Auth"],
      requestBody: jsonBody({
        type: "object",
        required: ["idToken"],
        properties: {
          idToken: {
            type: "string",
            description:
              "The `credential` returned by Google Identity Services.",
          },
          ...clientFields,
        },
        example: { idToken: "<google-id-token>" },
      }),
      responses: {
        "200": authResponse,
        "400": ref("BadRequest"),
        "401": {
          description:
            "Invalid Google credential, or the Google email is unverified",
          content: {
            "application/json": {
              schema: errorSchema,
              example: { code: 401, message: "Invalid Google credential" },
            },
          },
        },
        "403": {
          description: "No local account exists for the Google email",
          content: {
            "application/json": {
              schema: errorSchema,
              example: {
                code: 403,
                message:
                  "No account found for user@example.com. Please register first.",
              },
            },
          },
        },
        "429": ref("TooManyRequests"),
        "501": {
          description: "Google sign-in is not configured on this server",
          content: {
            "application/json": {
              schema: errorSchema,
              example: {
                code: 501,
                message: "Google sign-in is not configured.",
              },
            },
          },
        },
      },
    },
  },

  "/app/auth/token-exchange": {
    post: {
      summary: "Trade an authorization code for bearer tokens",
      description:
        "The native half of the login handshake. The code proves a password " +
        "(or Google ID token) was accepted a moment ago; the PKCE verifier " +
        "proves the caller is the client that asked for it rather than " +
        "whoever the code passed on its way here.\n\n" +
        "The code is single-use and short-lived. It is spent even when the " +
        "verifier is wrong, so a holder without the verifier gets one " +
        "attempt rather than as many as fit in the expiry window. A code " +
        "presented twice revokes the session the first redemption produced, " +
        "on the basis that two parties holding one code means the first " +
        "redemption cannot be trusted.\n\n" +
        "Every refusal returns the same 401 with the same message: whether " +
        "a code was unknown, expired, already spent or mismatched is a " +
        "question only an attacker asks.",
      tags: ["Auth"],
      requestBody: jsonBody({
        type: "object",
        required: ["code", "codeVerifier"],
        properties: {
          code: {
            type: "string",
            description: "The `authorizationCode` from the login response.",
          },
          codeVerifier: {
            type: "string",
            description:
              "The original PKCE verifier: 43-128 characters of " +
              "[A-Za-z0-9-._~], chosen before the login request was sent.",
          },
        },
      }),
      responses: {
        "200": {
          description: "Tokens issued",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TokenResponse" },
            },
          },
        },
        "400": ref("BadRequest"),
        "401": {
          description:
            "The code is unknown, expired, already spent, or the verifier " +
            "does not match. Deliberately indistinguishable.",
          content: { "application/json": { schema: errorSchema } },
        },
        "403": {
          description: "The account is no longer allowed to sign in.",
          content: { "application/json": { schema: errorSchema } },
        },
        "429": ref("TooManyRequests"),
      },
    },
  },

  "/app/auth/forgot-password": {
    post: {
      summary: "Request a password reset link",
      tags: ["Auth"],
      requestBody: jsonBody({
        type: "object",
        required: ["email"],
        properties: { email: { type: "string", format: "email" } },
        example: { email: "user@example.com" },
      }),
      responses: {
        "200": { description: "Reset link generated" },
        "400": ref("BadRequest"),
        "404": ref("NotFound"),
        "429": ref("TooManyRequests"),
      },
    },
  },

  "/app/auth/reset-password": {
    post: {
      summary: "Set a new password using a reset token",
      description:
        "The token goes in the body, not the query string: a URL is logged " +
        "by morgan, by the error handler, by every proxy in front of this " +
        "API, and is sent on in `Referer`. The emailed link still carries " +
        "`?token=`, because that URL belongs to the front end — it reads the " +
        "parameter and posts it here.",
      tags: ["Auth"],
      requestBody: jsonBody({
        type: "object",
        required: ["token", "password"],
        properties: {
          token: {
            type: "string",
            description: "The reset token from the password reset link.",
          },
          password: passwordField,
        },
        example: { token: "<reset-token>", password: "newPassword1" },
      }),
      responses: {
        "200": {
          description: "Password updated; all existing sessions are revoked",
        },
        "400": ref("BadRequest"),
        "401": {
          description: "The reset token is invalid or has expired",
          content: { "application/json": { schema: errorSchema } },
        },
        "404": ref("NotFound"),
        "429": ref("TooManyRequests"),
      },
    },
  },

  "/app/auth/refresh": {
    post: {
      summary: "Exchange a refresh token for a new access token",
      description:
        "The refresh token is read from the `refreshToken` cookie when the " +
        "body is omitted, so browser clients can call this with an empty " +
        "body.\n\n" +
        "**The reply mirrors the request.** A caller authenticated by cookie " +
        "gets the new access token as a cookie and nothing in the body — " +
        "otherwise an XSS could call this endpoint, which the browser " +
        "authenticates for it, and read the token out of the response. A " +
        "caller that sent the refresh token in the body gets its tokens " +
        "there.",
      tags: ["Auth"],
      requestBody: optionalRefreshBody,
      responses: {
        "200": { ...authResponse, description: "New tokens issued" },
        "401": ref("Unauthorized"),
        "429": ref("TooManyRequests"),
      },
    },
  },

  "/app/auth/logout": {
    post: {
      summary: "Revoke the current session",
      description: "Marks the session inactive and clears both auth cookies.",
      tags: ["Auth"],
      requestBody: optionalRefreshBody,
      responses: {
        "200": { description: "Logged out" },
        "401": ref("Unauthorized"),
      },
    },
  },

  "/app/auth/self": {
    get: {
      summary: "Get the currently authenticated user",
      tags: ["Auth"],
      security: [{ bearerAuth: [] }, { cookieAuth: [] }],
      responses: {
        "200": {
          description: "The current user",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  status: { type: "string" },
                  data: {
                    type: "object",
                    properties: {
                      user: { $ref: "#/components/schemas/User" },
                    },
                  },
                },
              },
            },
          },
        },
        "401": ref("Unauthorized"),
        "404": ref("NotFound"),
      },
    },
  },
};

export default authPaths;
