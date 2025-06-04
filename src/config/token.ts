export const tokenTypes = {
  ACCESS: "ACCESS",
  REFRESH: "REFRESH",
  RESET_PASSWORD: "RESET_PASSWORD",
  INVITE_USER: "INVITE_USER",
  MFA: "MFA",
} as const;

export type TokenType = keyof typeof tokenTypes;
