import type { RequestHandler } from "express";
import type pg from "pg";
import { HttpError } from "../lib/errors.js";
import { can, type Permission, type Role } from "../lib/permissions.js";
import { UuidParam } from "../lib/schemas.js";
import { verifyAccessToken } from "../lib/tokens.js";

/** Require a valid `Authorization: Bearer <access token>` header. */
export function authenticate(secret: string): RequestHandler {
  return (req, _res, next) => {
    const header = req.headers.authorization ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) {
      return next(new HttpError(401, "Missing bearer token", "unauthenticated"));
    }
    try {
      req.userId = verifyAccessToken(token, secret).sub;
      next();
    } catch {
      next(new HttpError(401, "Invalid or expired token", "unauthenticated"));
    }
  };
}

/**
 * Load the caller's membership in :orgId.
 * Non-members get 404 rather than 403, so the API never confirms that
 * another tenant's organization exists (prevents ID enumeration).
 */
export function requireMembership(pool: pg.Pool): RequestHandler {
  return async (req, _res, next) => {
    const parsed = UuidParam.safeParse(req.params.orgId);
    if (!parsed.success) return next(new HttpError(404, "Organization not found", "not_found"));

    const { rows } = await pool.query<{ role: Role }>(
      "SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2",
      [parsed.data, req.userId],
    );
    if (!rows[0]) return next(new HttpError(404, "Organization not found", "not_found"));
    req.membership = { orgId: parsed.data, role: rows[0].role };
    next();
  };
}

/** Require the caller's role to grant `permission` in the current organization. */
export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    if (!req.membership || !can(req.membership.role, permission)) {
      return next(new HttpError(403, `Your role cannot perform: ${permission}`, "forbidden"));
    }
    next();
  };
}
