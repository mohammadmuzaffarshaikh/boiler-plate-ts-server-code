// Define the rights (permissions) available for each role
const allRoles: Record<string, string[]> = {
  SUPER_ADMIN: [
    "access:admin_panel",
    "read:users",
    "manage:users",
    "manage:roles",
    "read:reports",
  ],
  ADMIN: ["access:admin_panel", "read:users", "manage:users", "read:reports"],
  MANAGER: ["read:users", "read:reports"],
  USER: ["read:own_profile"],
};

const roles = Object.keys(allRoles);

const roleRights: Map<string, string[]> = new Map(Object.entries(allRoles));

export { roles, roleRights };
