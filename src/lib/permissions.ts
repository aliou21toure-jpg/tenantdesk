/**
 * Role-based access control in one place.
 * Routes ask "can this role do X?" instead of scattering role checks around.
 */
export const ROLES = ["owner", "admin", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | "org:read"
  | "org:update"
  | "members:read"
  | "members:manage"
  | "members:change_role"
  | "clients:read"
  | "clients:write"
  | "clients:delete"
  | "invoices:read"
  | "invoices:write"
  | "invoices:change_status"
  | "audit:read";

const MATRIX: Record<Role, readonly Permission[]> = {
  viewer: ["org:read", "members:read", "clients:read", "invoices:read"],
  member: ["org:read", "members:read", "clients:read", "clients:write", "invoices:read", "invoices:write"],
  admin: [
    "org:read", "org:update", "members:read", "members:manage",
    "clients:read", "clients:write", "clients:delete",
    "invoices:read", "invoices:write", "invoices:change_status", "audit:read",
  ],
  owner: [
    "org:read", "org:update", "members:read", "members:manage", "members:change_role",
    "clients:read", "clients:write", "clients:delete",
    "invoices:read", "invoices:write", "invoices:change_status", "audit:read",
  ],
};

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role].includes(permission);
}

/** Higher number = more privilege. Used to stop admins managing owners. */
export const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
