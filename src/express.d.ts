import type { Role } from "./lib/permissions.js";

declare global {
  namespace Express {
    interface Request {
      /** Set by `authenticate` */
      userId?: string;
      /** Set by `requireMembership` */
      membership?: { orgId: string; role: Role };
    }
  }
}
export {};
