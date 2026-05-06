import { Role, TokenTypes as PrismaTokenTypes } from "@prisma/client";

export { Role };
export const roles = Object.values(Role) as Role[];

export const tokenTypes = {
  ...PrismaTokenTypes,
  ACCESS: "ACCESS",
  REFRESH: "REFRESH",
} as const;
export type TokenType = keyof typeof tokenTypes;

const rolePermissions: Record<Role, string[]> = {
  USER: ["read:own_profile", "update:own_profile"],
  ADMIN: [
    "access:admin_panel",
    "read:users",
    "manage:users",
    "read:own_profile",
    "update:own_profile",
  ],
};

export const roleRights: Map<Role, string[]> = new Map(
  Object.entries(rolePermissions) as [Role, string[]][]
);
