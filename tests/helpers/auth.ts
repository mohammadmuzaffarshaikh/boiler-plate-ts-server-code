import { Express } from "express";
import request from "supertest";
import { COOKIE_NAMES } from "../../src/config/cookies-option";
import {
  deriveCodeChallenge,
  generateCodeVerifier,
} from "../../src/utils/pkce";
import { TEST_PASSWORD } from "./db";

/**
 * Logging in over HTTP, in both of the shapes the API now offers.
 *
 * `POST /auth/login` no longer returns bearer tokens in its body — a browser
 * login gets httpOnly cookies and a native one gets a single-use
 * authorization code to trade (docs/decisions.md §28). Specs that just need
 * "a token for this user" therefore have to pick a client kind, and these
 * helpers make that choice explicit rather than leaving every spec to
 * open-code a two-request handshake.
 */

/** The login request itself, as a browser makes it. Returns a supertest
 *  `Test`, so `.expect(...)` still chains for specs asserting on the login. */
export const browserLogin = (
  app: Express,
  email: string,
  password: string = TEST_PASSWORD,
) => request(app).post("/api/app/auth/login").send({ email, password });

/** Read a cookie's value out of a `Set-Cookie` header. */
export const cookieValue = (
  res: { headers: Record<string, unknown> },
  name: string,
): string | undefined => {
  const header = res.headers["set-cookie"];
  const cookies = Array.isArray(header) ? (header as string[]) : [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));

  return match?.split(";")[0]?.split("=").slice(1).join("=");
};

/**
 * The tokens a browser login issued, read out of its cookies.
 *
 * For specs that need the raw refresh token to assert on how it is stored or
 * to drive `/auth/refresh`. The browser path is the right one for those: it
 * is where the session is created at login, which is the behaviour they are
 * about.
 */
export const cookieTokens = (res: { headers: Record<string, unknown> }) => ({
  access: cookieValue(res, COOKIE_NAMES.access),
  refresh: cookieValue(res, COOKIE_NAMES.refresh),
});

export interface NativeLoginResult {
  /** The login response, for a spec that wants to assert on that step. */
  login: request.Response;
  /** The token-exchange response, or undefined if the login did not succeed. */
  exchange?: request.Response;
  /** Final status: the exchange's if it ran, otherwise the login's. */
  status: number;
  access?: string;
  refresh?: string;
}

/**
 * The whole native handshake: log in with a PKCE challenge, then trade the
 * authorization code for bearer tokens.
 *
 * Short-circuits if the login itself did not return 200, so a spec asserting
 * on a refused login (locked account, wrong password, verification gate) gets
 * that response back rather than a confusing failure one request later.
 */
export const nativeLogin = async (
  app: Express,
  email: string,
  password: string = TEST_PASSWORD,
): Promise<NativeLoginResult> => {
  const codeVerifier = generateCodeVerifier();

  const login = await request(app).post("/api/app/auth/login").send({
    email,
    password,
    client: "native",
    codeChallenge: deriveCodeChallenge(codeVerifier),
    codeChallengeMethod: "S256",
  });

  if (login.status !== 200) {
    return { login, status: login.status };
  }

  const exchange = await request(app)
    .post("/api/app/auth/token-exchange")
    .send({ code: login.body.data.authorizationCode, codeVerifier });

  return {
    login,
    exchange,
    status: exchange.status,
    access: exchange.body?.data?.token,
    refresh: exchange.body?.data?.refreshToken,
  };
};

/** Shorthand for a spec that only wants a working bearer token. */
export const bearerFor = async (
  app: Express,
  email: string,
  password: string = TEST_PASSWORD,
): Promise<string> => {
  const result = await nativeLogin(app, email, password);

  if (!result.access) {
    throw new Error(
      `Login for ${email} did not yield a token (status ${result.status}): ` +
        JSON.stringify(result.exchange?.body ?? result.login.body),
    );
  }

  return result.access;
};
