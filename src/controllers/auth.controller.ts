import crypto from "node:crypto";
import httpStatus from "http-status";
import catchAsync from "../utils/catch-async";
import pick from "../utils/pick";
import { Request, Response } from "express";
import { AuthCode, User } from "@prisma/client";
import {
  authService,
  userService,
  tokenService,
  sessionService,
  authCodeService,
} from "../services";
import {
  getCookieOptions,
  COOKIE_NAMES,
} from "../config/cookies-option";
import { tokenTypes } from "../config/constants";
import ApiError from "../utils/api-error";
import config from "../config/config";
import logger from "../config/logger";
import { isValidCodeChallenge } from "../utils/pkce";

const setAuthCookies = (
  res: Response,
  tokens: {
    access: { token: string; expires: Date };
    refresh: { token: string; expires: Date };
  }
) => {
  res.cookie(
    COOKIE_NAMES.access,
    tokens.access.token,
    getCookieOptions(tokens.access.expires)
  );
  res.cookie(
    COOKIE_NAMES.refresh,
    tokens.refresh.token,
    getCookieOptions(tokens.refresh.expires)
  );
};

const clearAuthCookies = (res: Response) => {
  const options = getCookieOptions();
  res.clearCookie(COOKIE_NAMES.access, options);
  res.clearCookie(COOKIE_NAMES.refresh, options);
};

/** The public shape of a user, everywhere a login path returns one. */
const publicUser = (user: User) =>
  pick(user, [
    "id",
    "email",
    "firstName",
    "lastName",
    "role",
    "emailVerifiedAt",
  ]);

/**
 * Shared tail of every successful login, whatever proved the identity.
 *
 * THE TOKENS ARE NOT IN THE BODY ANY MORE, and that is the whole point.
 *
 * This used to return the access and refresh tokens in the JSON body *and*
 * set them as httpOnly cookies, "so browser clients can rely on the cookies
 * while non-browser clients use the body". The second half of that sentence
 * is what broke the first: any XSS in the admin SPA could read the login
 * response and take both credentials directly. `httpOnly` protects the
 * cookie and the same secret was printed beside it in a place JavaScript can
 * read.
 *
 * The two client kinds are now separated at the door instead:
 *
 *   - **browser** (the default) — cookies are set, the body carries the user
 *     and nothing else. There is no token in the page for script to steal,
 *     and nothing for an XSS to exfiltrate even if it replays this endpoint.
 *   - **native** — no cookies, because a client with no cookie jar has no use
 *     for them. The body carries a single-use authorization code, which is
 *     worthless without the PKCE verifier the client has held since before it
 *     logged in. It trades the two at `/auth/token-exchange`.
 *
 * The session is created only on the browser path. A native login defers it
 * to redemption, so a code that is never redeemed leaves no session behind —
 * and the session that IS created records the IP and device of the request
 * that will use it rather than of the login. See docs/decisions.md §28.
 */
const issueSessionAndRespond = async (
  req: Request,
  res: Response,
  user: User,
  message: string
) => {
  const codeChallenge = nativeChallenge(req);

  if (codeChallenge) {
    const { code, expiresAt } = await authCodeService.issueAuthCode(
      user.id,
      codeChallenge
    );

    res.status(httpStatus.OK).send({
      status: "success",
      message,
      data: {
        user: publicUser(user),
        authorizationCode: code,
        expiresAt,
      },
    });
    return;
  }

  const { access, refresh } = await sessionService.issueAuthSession(user, req);
  setAuthCookies(res, { access, refresh });

  res.status(httpStatus.OK).send({
    status: "success",
    message,
    data: { user: publicUser(user) },
  });
};

/**
 * The PKCE challenge for a native login, or undefined for a browser one.
 *
 * `client` is client-supplied and that is fine: it selects which credential
 * shape the caller receives, not what they are allowed to do. An attacker
 * who could set it to `native` on somebody else's login would have to be
 * performing that login, which means they already have the password.
 *
 * What it must never do is let a browser login hand a code to the page, so
 * the schema requires `codeChallenge` whenever `client` is `native` and
 * forbids it otherwise — a request cannot be half of each.
 */
const nativeChallenge = (req: Request): string | undefined => {
  if (req.body?.client !== "native") return undefined;

  const challenge = req.body.codeChallenge;

  // Re-checked here, not merely trusted from `validate`. Same reasoning as
  // the upload service re-checking `folder`: this function is what decides
  // whether a caller is handed a redeemable credential, and it should not be
  // possible to change that by editing a schema two files away.
  //
  // REFUSED, not quietly downgraded. Returning `undefined` here fell through
  // to the browser branch, so a native caller with a malformed challenge was
  // answered 200 with two Set-Cookie headers it has no jar for and no
  // authorization code — a live session it could neither use nor revoke, and
  // a response that looks like success. "Fails closed" has to mean an error;
  // a credential in the wrong shape is not a safe default.
  if (typeof challenge !== "string" || !isValidCodeChallenge(challenge)) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "A native login requires a valid S256 code challenge."
    );
  }

  return challenge;
};

const register = catchAsync(async (req: Request, res: Response) => {
  const existing = await userService.getUserByEmail(req.body.email);
  if (existing) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "User already exists with this email"
    );
  }

  // Field by field, not `req.body`. The schema denies unknown keys, but the
  // point of `CreateUserInput` is that this call site cannot pass a role
  // even if the schema one day stops denying them — self-service
  // registration mints STAFF and nothing else.
  const user = await userService.createUser({
    email: req.body.email,
    password: req.body.password,
    firstName: req.body.firstName,
    lastName: req.body.lastName,
  });

  res.status(httpStatus.CREATED).send({
    status: "success",
    message:
      "Your registration was successful. You may now log in to access the application.",
    data: {
      user: pick(user, [
        "id",
        "email",
        "firstName",
        "lastName",
        "role",
        "emailVerifiedAt",
      ]),
    },
  });
});

const loginUserWithEmailAndPassword = catchAsync(
  async (req: Request, res: Response) => {
    const user = await authService.loginUserWithEmailAndPassword(
      req.body?.email || "",
      req.body?.password
    );

    await issueSessionAndRespond(
      req,
      res,
      user,
      "Login successful. Welcome back!"
    );
  }
);

const googleLogin = catchAsync(async (req: Request, res: Response) => {
  const user = await authService.loginUserWithGoogle(req.body?.idToken);

  await issueSessionAndRespond(
    req,
    res,
    user,
    "Login successful. Welcome back!"
  );
});

/**
 * Start a password reset.
 *
 * Two things here are security-relevant and easy to undo by accident:
 *
 * 1. **The same 200 is returned whether or not the account exists.** The
 *    previous 404 on an unknown address turned this endpoint into a user
 *    enumeration oracle, which is exactly what the IP and per-email limiters
 *    on this route were added to prevent — they only slowed it down.
 *
 * 2. **The reset link is never returned in production.** It was, and a live
 *    reset token in the response body for any address anyone cares to name
 *    is unauthenticated account takeover, not a convenience. Outside
 *    production the link is still returned so the flow is testable without
 *    a mail provider. The transport now exists (`services/email.service`),
 *    so what is left is a RESET_PASSWORD template and the send itself —
 *    which goes here, after which the development-only branch can go.
 */
const forgotPassword = catchAsync(async (req: Request, res: Response) => {
  const user = await userService.getUserByEmail(req.body.email);

  let resetPasswordLink: string | undefined;

  if (user) {
    const { resetPasswordToken } =
      await tokenService.generateResetPasswordToken(user.id);

    resetPasswordLink = `${config.SITE_URL}/reset-password?token=${resetPasswordToken}`;

    // TODO: send `resetPasswordLink` by email instead of returning it.
  }

  res.status(httpStatus.OK).send({
    status: "success",
    message:
      "If an account exists for that address, a password reset link has been sent.",
    ...(config.ENV !== "production" && resetPasswordLink
      ? { data: { resetPasswordLink } }
      : {}),
  });
});

/**
 * Complete a password reset.
 *
 * The token arrives in the body, never the query string — see the schema in
 * `validations/auth.validation.ts` for why a URL is the worst place to carry
 * a credential that takes over an account.
 */
const resetPassword = catchAsync(async (req: Request, res: Response) => {
  const { token, password } = req.body;

  const resetToken = await tokenService.validateStoredToken(
    token,
    tokenTypes.RESET_PASSWORD
  );

  if (resetToken.expires < new Date()) {
    throw new ApiError(httpStatus.UNAUTHORIZED, "Reset token has expired.");
  }

  const user = await userService.getUserById(resetToken.userId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, "User not found.");
  }

  // The lockout is cleared along with the password, deliberately. Resetting
  // is the documented way out of a locked account, and without this the user
  // completes the whole email round-trip, sets a new password, and is still
  // answered with 429 until the lock ages out.
  await userService.updateUserById(user.id, {
    password,
    loginAttempts: 0,
    lockUntil: null,
    lastFailedLoginAt: null,
  });
  await tokenService.deleteTokens(user.id, tokenTypes.RESET_PASSWORD);
  await sessionService.revokeAllForUser(user.id);

  res.status(httpStatus.OK).send({
    status: "success",
    message: "Password has been reset successfully.",
  });
});

/**
 * Exchange a refresh token for a new access token.
 *
 * The reply mirrors the request, and that symmetry is a security control
 * rather than a style choice. A caller that authenticated with the httpOnly
 * cookie gets the new access token as a cookie and **nothing in the body** —
 * otherwise an XSS could simply call this endpoint, which the browser
 * helpfully authenticates with the cookie, and read the token out of the
 * response. Putting the token in the body there would hand back exactly what
 * §28 took out of the login response.
 *
 * A caller that sent the refresh token in the body has already demonstrated
 * it holds the credential outside a cookie jar, so the body is where its
 * reply belongs.
 */
const handleRefreshToken = catchAsync(async (req: Request, res: Response) => {
  // Body first. A native client on a platform that silently keeps cookies
  // would otherwise be served the cookie copy and get an empty body back.
  const bodyToken = req.body?.refreshToken;
  const refreshTk = bodyToken || req.cookies?.[COOKIE_NAMES.refresh];
  const viaCookie = !bodyToken;

  if (!refreshTk) {
    throw new ApiError(httpStatus.UNAUTHORIZED, "Refresh token is missing.");
  }

  const session = await sessionService.findActiveByRefreshToken(refreshTk);
  if (!session || !session.isActive || session.expiresAt < new Date()) {
    // The failure path mirrors too. Clearing is harmless in itself, but a
    // native client refreshing with a body token shares a cookie jar in a
    // WebView or hybrid shell — and clearing there logs the co-resident admin
    // SPA out over a request that had nothing to do with it. Touch the jar
    // only for the caller who authenticated from it.
    if (viaCookie) {
      clearAuthCookies(res);
    }
    throw new ApiError(
      httpStatus.UNAUTHORIZED,
      "Session expired. Please log in again."
    );
  }

  const payload = tokenService.verifyJwt(refreshTk);
  if (payload.type !== tokenTypes.REFRESH) {
    throw new ApiError(httpStatus.UNAUTHORIZED, "Invalid token type.");
  }

  const user = await userService.getUserById(session.userId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, "User not found.");
  }

  // The same gates the login paths apply. Refresh used to apply none of
  // them, so an account locked by brute-force protection kept minting access
  // tokens from the refresh token it already held, for a full seven days —
  // the lockout closed the front door and left this one open. Checked after
  // the session lookup so a revoked session is still the first thing to fail.
  authService.assertAccountMayAuthenticate(user);

  // Bound to the SAME session, not a new one. Refreshing extends an existing
  // session; minting a fresh `sid` here would leave the old row behind and
  // make "log out everywhere" miss the session the user is actually using.
  const access = tokenService.generateAccessToken(
    user.id,
    user.role,
    session.id
  );
  // Only for a caller who authenticated by cookie. Setting it
  // unconditionally made the mirror half a mirror: a client that refreshed
  // with a body token had an access cookie planted on it as well, and in any
  // context sharing a jar with the admin SPA that is the §28 exposure
  // arriving by another door. A native client has no jar and never wanted it.
  if (viaCookie) {
    res.cookie(
      COOKIE_NAMES.access,
      access.token,
      getCookieOptions(access.expires)
    );
  }

  await sessionService.touchLastActivity(session.id);

  res.status(httpStatus.OK).send({
    status: "success",
    message: "Refresh token is valid.",
    data: {
      user: publicUser(user),
      // Omitted for a cookie-authenticated caller: the cookie above already
      // carries it, and putting a copy here is what lets an XSS read it.
      ...(viaCookie ? {} : { token: access.token, expires: access.expires }),
    },
  });
});

/**
 * Trade a single-use authorization code for bearer tokens.
 *
 * The native half of the login handshake. The code proves a password was
 * accepted a moment ago; the PKCE verifier proves the caller is the client
 * that asked for it rather than whoever the code passed on its way here.
 *
 * Every refusal answers the same 401 with the same message. The caller is
 * unauthenticated, so telling them whether a code was unknown, expired,
 * already spent or merely mismatched would be answering questions only an
 * attacker asks. The distinctions are kept in the log and in what each one
 * costs, below.
 */
const tokenExchange = catchAsync(async (req: Request, res: Response) => {
  const { code, codeVerifier } = req.body;

  const refuse = () => {
    throw new ApiError(
      httpStatus.UNAUTHORIZED,
      "Authorization code is invalid or has expired."
    );
  };

  /**
   * A code arriving twice means two parties hold it, and the FIRST redemption
   * is the one that cannot be trusted — it may well have been the attacker,
   * with the legitimate client arriving second. So the session the first
   * redemption produced is revoked rather than left running, and both parties
   * start again with a password. RFC 6749 §4.1.2 asks for exactly this, and
   * OAuth 2.1 strengthens it.
   */
  const revokeFirstRedemption = async (authCode?: AuthCode) => {
    if (!authCode?.sessionId) return;

    const { count } = await sessionService.revokeSessionById(
      authCode.sessionId
    );

    // Report what happened, not what was attempted. A revocation that never
    // occurred has no business in the record an incident is reconstructed
    // from, and `count` is the only thing that actually knows.
    logger.warn(
      count > 0
        ? `[auth] Authorization code replayed; revoked session ${authCode.sessionId}`
        : `[auth] Authorization code replayed; session ${authCode.sessionId} no longer exists`
    );
  };

  const found = await authCodeService.findRedeemableCode(code);
  if (!found.ok) {
    if (found.reason === "replayed") {
      await revokeFirstRedemption(found.authCode);
    }
    return refuse();
  }

  const user = await userService.getUserById(found.authCode.userId);
  if (!user) {
    return refuse();
  }

  // Re-checked here, not just at login. A minute is short but it is not zero,
  // and an account can be locked or deactivated inside it. The code proves a
  // password was accepted; it does not prove the account is still welcome.
  //
  // Before the session is created, so a refused account leaves no row.
  authService.assertAccountMayAuthenticate(user);

  // THE SESSION IS CREATED BEFORE THE CODE IS CLAIMED, and that order is the
  // whole of the replay defence. The loser of a race revokes the session the
  // winner produced, which means the winner's row has to exist by the time
  // the loser can see its id. Claiming first and inserting afterwards left a
  // window — measured at about one redemption in twelve — where the loser
  // read the right id, revoked nothing, and the winner's session went on to
  // be inserted and never revoked. Creating first closes it: a loser's claim
  // waits on the winner's row lock, and the winner locked that row only after
  // its INSERT had committed.
  //
  // The price is a session created before the code is known to be good. It is
  // deleted on every failure below and no token for it ever leaves here.
  const sessionId = crypto.randomUUID();
  const { access, refresh } = await sessionService.issueAuthSession(
    user,
    req,
    sessionId
  );

  const claimed = await authCodeService.claimAuthCode(
    found.authCode,
    codeVerifier,
    sessionId
  );

  if (!claimed.ok) {
    await sessionService.deleteSessionById(sessionId);

    if (claimed.reason === "replayed") {
      await revokeFirstRedemption(claimed.authCode);
    }

    if (claimed.reason === "mismatch") {
      // The code is already spent by the time we get here — see
      // `claimAuthCode` for why that ordering is the point. One guess, not
      // unlimited ones.
      logger.warn("[auth] Authorization code redeemed with a wrong verifier");
    }

    return refuse();
  }

  res.status(httpStatus.OK).send({
    status: "success",
    message: "Login successful. Welcome back!",
    data: {
      user: publicUser(user),
      token: access.token,
      expires: access.expires,
      refreshToken: refresh.token,
      refreshExpires: refresh.expires,
    },
  });
});

/**
 * Read the access token the way `config/passport.ts` does — bearer header
 * first, then the httpOnly cookie.
 *
 * Logout is deliberately unauthenticated (an expired token must still be able
 * to clear its cookies), so `req.user` is not available here and the token
 * has to be read by hand.
 */
const extractAccessToken = (req: Request): string | undefined => {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim() || undefined;
  }
  return req.cookies?.[COOKIE_NAMES.access] || undefined;
};

/**
 * End a session.
 *
 * Revokes by whichever credential the caller actually holds, because they do
 * not always hold both. A browser sends the refresh cookie; a non-browser
 * client that keeps only the access token used to get a cheerful 200 here
 * while nothing was revoked at all. Both paths now reach the same row.
 *
 * Revoking the session is what invalidates the access token: it carries that
 * row's id as `sid`, and `config/passport.ts` resolves it on every request.
 * Before that binding existed this endpoint flipped `is_active` and the
 * bearer token went on working for the rest of its lifetime.
 *
 * A token that will not verify is ignored rather than rejected. Logging out
 * with an expired or malformed token must still clear the cookies and answer
 * 200 — a 401 from `/logout` leaves the client stuck holding credentials it
 * was trying to discard.
 */
const logout = catchAsync(async (req: Request, res: Response) => {
  const refreshTk =
    req.cookies?.[COOKIE_NAMES.refresh] || req.body?.refreshToken;
  if (refreshTk) {
    await sessionService.revokeSession(refreshTk);
  }

  const accessTk = extractAccessToken(req);
  if (accessTk) {
    try {
      const payload = tokenService.verifyJwt(accessTk);
      if (payload.type === tokenTypes.ACCESS && payload.sid) {
        await sessionService.revokeSessionById(payload.sid);
      }
    } catch {
      // Unverifiable token. Nothing to revoke, nothing to report.
    }
  }

  clearAuthCookies(res);

  res.status(httpStatus.OK).send({
    status: "success",
    message: "Logged out successfully.",
  });
});

const self = catchAsync(async (req: Request, res: Response) => {
  const user = (req as Request & { user?: { id: string } }).user;
  if (!user?.id) {
    throw new ApiError(httpStatus.UNAUTHORIZED, "Please authenticate.");
  }
  const fresh = await userService.getUserById(user.id);
  if (!fresh) {
    throw new ApiError(httpStatus.NOT_FOUND, "User not found.");
  }
  res.status(httpStatus.OK).send({
    status: "success",
    data: {
      user: pick(fresh, [
        "id",
        "email",
        "firstName",
        "lastName",
        "role",
        "emailVerifiedAt",
      ]),
    },
  });
});

export {
  register,
  loginUserWithEmailAndPassword,
  googleLogin,
  tokenExchange,
  forgotPassword,
  resetPassword,
  handleRefreshToken,
  logout,
  self,
};
