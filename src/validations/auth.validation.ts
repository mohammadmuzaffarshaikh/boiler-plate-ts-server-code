import Joi, { ObjectSchema } from "joi";
import { password } from "./custom.validation";
import {
  isValidCodeChallenge,
  isValidCodeVerifier,
} from "../utils/pkce";

interface ValidationSchema {
  body?: ObjectSchema;
  query?: ObjectSchema;
}

const register: ValidationSchema = {
  body: Joi.object().keys({
    firstName: Joi.string().required(),
    lastName: Joi.string().required(),
    email: Joi.string().required().email(),
    password: Joi.string().required().custom(password),
  }),
};

/**
 * A PKCE challenge: base64url(sha256(verifier)), method S256.
 *
 * Shape-checked at login rather than only at redemption, so a client sending
 * something unusable finds out while it still has a password in hand instead
 * of a minute later holding a code it can never redeem.
 */
const codeChallenge = Joi.string().custom((value, helpers) =>
  isValidCodeChallenge(value) ? value : helpers.error("any.invalid"),
);

const codeVerifier = Joi.string().custom((value, helpers) =>
  isValidCodeVerifier(value) ? value : helpers.error("any.invalid"),
);

/**
 * `client` decides which credential shape comes back, and the two are
 * mutually exclusive by construction.
 *
 * A browser login gets httpOnly cookies and no tokens anywhere a script can
 * read them. A native login gets a single-use authorization code and must
 * therefore supply a challenge. `requires`/`forbidden` below means a request
 * cannot be half of each — in particular a `client: "web"` request cannot
 * smuggle a challenge and be handed a code for the page to hold.
 */
const login: ValidationSchema = {
  body: Joi.object().keys({
    email: Joi.string().required().email(),
    password: Joi.string().required(),
    // NOT `.default("web")`. `validate` discards Joi's coerced value
    // (see CLAUDE.md), so a default here would never reach `req.body` and
    // would read as a guarantee the controller does not get. Absent means
    // browser, and the controller says so explicitly.
    client: Joi.string().valid("web", "native"),
    codeChallenge: codeChallenge.when("client", {
      is: "native",
      then: Joi.required(),
      otherwise: Joi.forbidden(),
    }),
    // Accepted only as the literal "S256". `plain` is in RFC 7636 and is
    // refused here: it makes the challenge and the verifier the same string,
    // so anyone who sees one has the other and the whole exercise is theatre.
    codeChallengeMethod: Joi.string().valid("S256").when("client", {
      is: "native",
      then: Joi.optional(),
      otherwise: Joi.forbidden(),
    }),
  }),
};

/** Redeem a native login's authorization code. */
const tokenExchange: ValidationSchema = {
  body: Joi.object().keys({
    code: Joi.string().required(),
    codeVerifier: codeVerifier.required(),
  }),
};

/**
 * The same two client shapes as password login, for the same reason.
 *
 * A native app using Google Sign-In gets an ID token from the SDK and needs
 * bearer tokens back; a browser using GIS needs cookies. Without these fields
 * Google sign-in would be browser-only, which is the kind of gap a copier
 * discovers after building half a mobile client.
 */
const googleLogin: ValidationSchema = {
  body: Joi.object().keys({
    idToken: Joi.string().required(),
    client: Joi.string().valid("web", "native"),
    codeChallenge: codeChallenge.when("client", {
      is: "native",
      then: Joi.required(),
      otherwise: Joi.forbidden(),
    }),
    codeChallengeMethod: Joi.string().valid("S256").when("client", {
      is: "native",
      then: Joi.optional(),
      otherwise: Joi.forbidden(),
    }),
  }),
};

const refreshToken: ValidationSchema = {
  body: Joi.object().keys({
    refreshToken: Joi.string().optional().allow(""),
  }),
};

const logout: ValidationSchema = {
  body: Joi.object().keys({
    refreshToken: Joi.string().optional().allow(""),
  }),
};

const forgotPassword: ValidationSchema = {
  body: Joi.object().keys({
    email: Joi.string().email().required(),
  }),
};

/**
 * The token is in the BODY, not the query string.
 *
 * A reset token is a single-use credential for taking over an account, and a
 * query string is the one part of a request that gets written down
 * everywhere: morgan logs `:url`, `errorHandler` logs `originalUrl`, and both
 * end up in stdout and the log aggregator. Every reverse proxy, load balancer
 * and CDN in front of this API keeps its own access log of the same line, and
 * the browser puts the full URL in `Referer` on any request the reset page
 * makes to a third party. A body is in none of those.
 *
 * The link mailed to the user still carries `?token=` — that URL belongs to
 * the front end, which reads the parameter and sends it here in the body.
 */
const resetPassword: ValidationSchema = {
  body: Joi.object().keys({
    token: Joi.string().required(),
    password: Joi.string().required().custom(password),
  }),
};

export {
  register,
  login,
  tokenExchange,
  googleLogin,
  refreshToken,
  logout,
  forgotPassword,
  resetPassword,
};
