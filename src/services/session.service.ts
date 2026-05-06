import { Request } from "express";
import { UAParser } from "ua-parser-js";
import { prisma } from "../utils/prisma-client";

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
  const ipAddress =
    (req.headers["x-forwarded-for"] as string | undefined)
      ?.split(",")[0]
      ?.trim() || req.ip;

  return {
    userAgent: userAgent ?? null,
    ipAddress: ipAddress ?? null,
    deviceInfo: parseDevice(userAgent),
  };
};

export const createSession = async (params: {
  userId: string;
  refreshToken: string;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  deviceInfo: DeviceInfo;
}) => {
  return prisma.session.create({
    data: {
      userId: params.userId,
      refreshToken: params.refreshToken,
      expiresAt: params.expiresAt,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      deviceInfo: params.deviceInfo as object,
    },
  });
};

export const findActiveByRefreshToken = async (refreshToken: string) => {
  return prisma.session.findUnique({ where: { refreshToken } });
};

export const touchLastActivity = async (id: string) => {
  return prisma.session.update({
    where: { id },
    data: { lastActivity: new Date() },
  });
};

export const revokeSession = async (refreshToken: string) => {
  return prisma.session.updateMany({
    where: { refreshToken, isActive: true },
    data: { isActive: false },
  });
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
