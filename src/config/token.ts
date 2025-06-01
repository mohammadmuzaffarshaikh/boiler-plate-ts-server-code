export const tokenTypes = {
  ACCESS: "ACCESS",
  REFRESH: "REFRESH",
  RESET_PASSWORD: "RESET-PASSWORD",
  VERIFY_EMAIL: "VERIFY-EMAIL",
  INVITE_USER: "INVITE-USER",
  MFA: "MFA",
} as const;

export type TokenType = keyof typeof tokenTypes;
