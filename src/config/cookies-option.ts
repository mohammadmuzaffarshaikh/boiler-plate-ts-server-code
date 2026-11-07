import { CookieOptions } from "express";
import config from "./config";

export type CookieKind = "access" | "refresh";

export const COOKIE_NAMES = {
  access: "token",
  refresh: "refreshToken",
} as const satisfies Record<CookieKind, string>;

export function getCookieOptions(expiresAt?: Date): CookieOptions {
  const now = Date.now();
  const isProduction = config.ENV === "production";

  const options: CookieOptions = {
    httpOnly: true,
    path: "/",
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
  };

  if (expiresAt) {
    options.maxAge = Math.max(0, expiresAt.getTime() - now);
  }

  if (isProduction && config.COOKIE.DOMAIN) {
    options.domain = config.COOKIE.DOMAIN;
  }

  return options;
}
