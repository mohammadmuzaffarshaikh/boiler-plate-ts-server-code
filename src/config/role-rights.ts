// Define the rights (permissions) available for each role
const allRoles: Record<string, string[]> = {
  SUPER_ADMIN: [
    "access:admin_panel",
    "manage:organizations", // create/edit/delete orgs
    "read:organizations",
    "read:users",
    "manage:users",
    "manage:roles",
    "read:reports",
  ],
  OWNER: [
    "access:admin_panel",
    "read:organization",
    "manage:organization",
    "read:users",
    "manage:users",
    "read:reports",
    "manage:roles", // can manage all org roles including admins
  ],
  ADMIN: [
    "access:admin_panel",
    "read:organization",
    "manage:organization",
    "read:users",
    "manage:users",
    "read:reports",
    // no manage:roles — can't promote others to admin or owner
  ],
  MEMBER: [
    "read:organization",
    "read:users",
    "read:reports",
    "update:own_profile",
  ],
  VIEWER: ["read:organization", "read:reports"],
};

const roles = Object.keys(allRoles);

const roleRights: Map<string, string[]> = new Map(Object.entries(allRoles));

export { roles, roleRights };
