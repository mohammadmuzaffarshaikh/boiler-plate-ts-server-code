import config from "./config";

export function getCookieOptions(expiresAt?: Date): Record<string, any> {
  const now = Date.now();
  const defaultExpiry = new Date(now + 2 * 24 * 60 * 60 * 1000); // 2 days from now
  const expiryDate = expiresAt ?? defaultExpiry;

  const cookieOptions: Record<string, any> = {
    httpOnly: true,
    secure: config.env === "production",
    maxAge: Math.max(0, expiryDate.getTime() - now), // in ms
  };

  if (config.env === "production") {
    cookieOptions.sameSite = "None";
  } else {
    cookieOptions.domain = "localhost";
  }

  return cookieOptions;
}
