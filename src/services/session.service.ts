import { Request } from "express";
import { User } from "@prisma/client";
import { UAParser } from "ua-parser-js";
import { prisma } from "../config/prisma-client";
import * as tokenService from "./token.service";
import { hashToken } from "../utils/hash";

export interface AuthTokens {
  /**
   * The `sessions` row these tokens belong to.
   *
   * Returned rather than left for the caller to look up, because the access
   * token already carries it as its `sid` claim and a second source of truth
   * is a second thing to get wrong. Token exchange no longer reads it — that
   * path chooses the id itself and passes it in, because it has to name the
   * session before creating it — but anything else that needs to revoke or
   * annotate the session it just issued has it here without a query.
   */
  sessionId: string;
  access: { token: string; expires: Date };
  refresh: { token: string; expires: Date };
}

export interface DeviceInfo {
  browser?: string;
  os?: string;
  device?: string;
}

const parseDevice = (userAgent: string | undefined): DeviceInfo => {
  if (!userAgent) return {};
  const parser = new UAParser(userAgent);
  const result = parser.getResult();
  return {
    browser: result.browser.name,
    os: result.os.name,
    device: result.device.type ?? "desktop",
  };
};

export const captureRequestContext = (req: Request) => {
  const userAgent = req.headers["user-agent"];

  // `req.ip`, never `X-Forwarded-For` directly. Express already derives
  // `req.ip` from that header according to the `trust proxy` setting in
  // app.ts, which is configured by TRUST_PROXY. Reading the raw header
  // instead bypasses that entirely: with the default TRUST_PROXY=0 any
  // caller could send `X-Forwarded-For: 1.2.3.4` and have it recorded as the
  // session's origin, poisoning the audit trail this column exists for.
  const ipAddress = req.ip;

  return {
    userAgent: userAgent ?? null,
    ipAddress: ipAddress ?? null,
    deviceInfo: parseDevice(userAgent),
  };
};

export const createSession = async (params: {
  /**
   * Chosen by the caller instead of by the database default.
   *
   * Only the token-exchange path passes one, and it does so because the
   * authorization code records the session it redeems into as part of the
   * same statement that claims it — the id therefore has to exist before the
   * row does. `undefined` is what Prisma reads as "not supplied", so every
   * other caller keeps the default.
   */
  id?: string;
  userId: string;
  refreshToken: string;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  deviceInfo: DeviceInfo;
}) => {
  return prisma.session.create({
    data: {
      id: params.id,
      userId: params.userId,
      // Stored as a digest — see `hashToken`. Every read path below hashes
      // its input the same way, so the raw token never has to be kept.
      refreshToken: hashToken(params.refreshToken),
      expiresAt: params.expiresAt,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      deviceInfo: params.deviceInfo as object,
    },
  });
};

/**
 * Start an authenticated session for a user, whatever proved their identity.
 *
 * Mints the access + refresh tokens and records the session row. Deliberately
 * knows nothing about HTTP responses or cookies, so every login path
 * (password, Google, and anything added later) can share it.
 *
 * ORDER MATTERS. The session row is written *before* the access token is
 * minted, because the access token carries that row's id as its `sid` claim
 * and `config/passport.ts` refuses a token whose session it cannot resolve.
 * Minting first and inserting afterwards would hand out a token that is
 * briefly — or, if the insert fails, permanently — unusable.
 *
 * @param user - The already-authenticated user
 * @param req - The request, used to capture IP / user-agent / device info
 * @param sessionId - Optional pre-chosen id for the row. Passed only by the
 *   token-exchange path, which creates the session before it claims the
 *   authorization code — so it has to name the id before the row exists in
 *   order to write it into the claim. See `claimAuthCode`.
 * @returns The issued access and refresh tokens
 */
export const issueAuthSession = async (
  user: User,
  req: Request,
  sessionId?: string
): Promise<AuthTokens> => {
  const refresh = tokenService.generateRefreshToken(user.id);

  const ctx = captureRequestContext(req);
  const session = await createSession({
    id: sessionId,
    userId: user.id,
    refreshToken: refresh.token,
    expiresAt: refresh.expires,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    deviceInfo: ctx.deviceInfo,
  });

  const access = tokenService.generateAccessToken(
    user.id,
    user.role,
    session.id
  );

  return { sessionId: session.id, access, refresh };
};

/**
 * Resolve an access token's `sid` claim to a session that is still good.
 *
 * Called on EVERY authenticated request, from `config/passport.ts`, and it is
 * what makes an access token revocable at all — see docs/decisions.md §5.
 *
 * Three conditions, all of which must hold, and all of which are expressed in
 * the `where` rather than checked afterwards so that "not found" and "no
 * longer valid" cannot drift apart:
 *
 *   - the row still exists  — a deleted user cascades its sessions away
 *   - `isActive`            — logout and `revokeAllForUser` clear this
 *   - `expiresAt` in future — the refresh lifetime is the session lifetime
 *
 * Narrow `select` on purpose: this runs per request, and the caller needs
 * only enough to confirm the binding. It is a primary-key lookup, so the cost
 * is one index probe.
 */
export const findActiveSessionById = async (id: string) => {
  return prisma.session.findFirst({
    where: { id, isActive: true, expiresAt: { gt: new Date() } },
    select: { id: true, userId: true },
  });
};

export const findActiveByRefreshToken = async (refreshToken: string) => {
  return prisma.session.findUnique({
    where: { refreshToken: hashToken(refreshToken) },
  });
};

export const touchLastActivity = async (id: string) => {
  return prisma.session.update({
    where: { id },
    data: { lastActivity: new Date() },
  });
};

export const revokeSession = async (refreshToken: string) => {
  return prisma.session.updateMany({
    where: { refreshToken: hashToken(refreshToken), isActive: true },
    data: { isActive: false },
  });
};

/**
 * Revoke one session by its id — the `sid` carried in an access token.
 *
 * Lets logout work for a client that holds only an access token: no refresh
 * cookie (a non-browser client), and none in the body. Without this, such a
 * caller got a cheerful 200 from `/logout` while nothing at all was revoked.
 *
 * `updateMany` rather than `update` so an id that matches nothing is a no-op
 * instead of a P2025. Logout must not fail on an already-revoked session.
 */
export const revokeSessionById = async (id: string) => {
  return prisma.session.updateMany({
    where: { id, isActive: true },
    data: { isActive: false },
  });
};

/**
 * Delete a session outright.
 *
 * For one created speculatively and then not given to anybody — the
 * token-exchange path creates the row before it claims the authorization
 * code, so that a concurrent replay has something real to revoke, and throws
 * the row away if the claim does not go its way.
 *
 * Deleted rather than revoked because there is nothing to audit: no token for
 * it ever left the process. Revoking would leave an `isActive: false` row for
 * the sweep to carry around for thirty days, and would make the session list
 * on a user's security page read like a login that happened.
 */
export const deleteSessionById = async (id: string) => {
  return prisma.session.deleteMany({ where: { id } });
};

export const revokeAllForUser = async (userId: string) => {
  return prisma.session.updateMany({
    where: { userId, isActive: true },
    data: { isActive: false },
  });
};

export const deleteExpiredSessions = async () => {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const { count } = await prisma.session.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: now } },
        { isActive: false, updatedAt: { lt: thirtyDaysAgo } },
      ],
    },
  });

  return count;
};
