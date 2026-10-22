import { Router } from "express";
import type pg from "pg";
import { withTenant, withTransaction } from "../db.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { ROLE_RANK } from "../lib/permissions.js";
import { AddMemberSchema, ChangeRoleSchema, CreateOrgSchema, PageQuery, UuidParam } from "../lib/schemas.js";
import { requireMembership, requirePermission } from "../middleware/auth.js";

/** /me and /orgs routes. Expects `authenticate` to have run already. */
export function orgsRouter(pool: pg.Pool): Router {
  const router = Router();
  const member = requireMembership(pool);

  router.get("/me", async (req, res) => {
    const user = await pool.query("SELECT id, email, name, created_at FROM users WHERE id = $1", [req.userId]);
    const orgs = await pool.query(
      `SELECT o.id, o.name, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id
       WHERE m.user_id = $1 ORDER BY o.name`,
      [req.userId],
    );
    res.json({ ...user.rows[0], organizations: orgs.rows });
  });

  router.post("/orgs", async (req, res) => {
    const { name } = CreateOrgSchema.parse(req.body);
    const org = await withTransaction(pool, async (tx) => {
      const o = (await tx.query<{ id: string; name: string }>(
        "INSERT INTO organizations (name) VALUES ($1) RETURNING id, name", [name],
      )).rows[0]!;
      await tx.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')", [o.id, req.userId]);
      await tx.query("SELECT set_config('app.current_org', $1, true)", [o.id]);
      await audit(tx, { orgId: o.id, actorId: req.userId!, action: "org.created", entityType: "organization", entityId: o.id });
      return o;
    });
    res.status(201).json({ ...org, role: "owner" });
  });

  router.get("/orgs/:orgId", member, requirePermission("org:read"), async (req, res) => {
    const { rows } = await pool.query("SELECT id, name, created_at FROM organizations WHERE id = $1", [
      req.membership!.orgId,
    ]);
    res.json({ ...rows[0], role: req.membership!.role });
  });

  router.patch("/orgs/:orgId", member, requirePermission("org:update"), async (req, res) => {
    const { name } = CreateOrgSchema.parse(req.body);
    const { orgId } = req.membership!;
    const org = await withTenant(pool, orgId, async (tx) => {
      const { rows } = await tx.query("UPDATE organizations SET name = $1 WHERE id = $2 RETURNING id, name", [name, orgId]);
      await audit(tx, { orgId, actorId: req.userId!, action: "org.renamed", entityType: "organization", entityId: orgId, metadata: { name } });
      return rows[0];
    });
    res.json(org);
  });

  /* ---------- members ---------- */

  router.get("/orgs/:orgId/members", member, requirePermission("members:read"), async (req, res) => {
    const { rows } = await pool.query(
      `SELECT u.id AS user_id, u.name, u.email, m.role, m.created_at AS joined_at
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.org_id = $1 ORDER BY m.created_at`,
      [req.membership!.orgId],
    );
    res.json({ items: rows });
  });

  router.post("/orgs/:orgId/members", member, requirePermission("members:manage"), async (req, res) => {
    const { email, role } = AddMemberSchema.parse(req.body);
    const { orgId, role: actorRole } = req.membership!;
    if (ROLE_RANK[role] > ROLE_RANK[actorRole]) {
      throw new HttpError(403, "You cannot grant a role higher than your own", "forbidden");
    }
    const result = await withTenant(pool, orgId, async (tx) => {
      const user = (await tx.query<{ id: string; name: string }>(
        "SELECT id, name FROM users WHERE lower(email) = $1", [email],
      )).rows[0];
      if (!user) throw new HttpError(404, "No user with that email — ask them to register first", "user_not_found");
      await tx.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3)", [orgId, user.id, role]);
      await audit(tx, { orgId, actorId: req.userId!, action: "member.added", entityType: "user", entityId: user.id, metadata: { role } });
      return { user_id: user.id, name: user.name, email, role };
    });
    res.status(201).json(result);
  });

  router.patch("/orgs/:orgId/members/:userId", member, requirePermission("members:change_role"), async (req, res) => {
    const targetId = UuidParam.parse(req.params.userId);
    const { role } = ChangeRoleSchema.parse(req.body);
    const { orgId } = req.membership!;
    if (targetId === req.userId) throw new HttpError(400, "You cannot change your own role", "bad_request");

    const updated = await withTenant(pool, orgId, async (tx) => {
      const { rows } = await tx.query(
        "UPDATE memberships SET role = $1 WHERE org_id = $2 AND user_id = $3 RETURNING user_id, role",
        [role, orgId, targetId],
      );
      if (!rows[0]) throw new HttpError(404, "Member not found", "not_found");
      await audit(tx, { orgId, actorId: req.userId!, action: "member.role_changed", entityType: "user", entityId: targetId, metadata: { role } });
      return rows[0];
    });
    res.json(updated);
  });

  /** Admins remove lower-ranked members; anyone except an owner may remove themselves (leave). */
  router.delete("/orgs/:orgId/members/:userId", member, async (req, res) => {
    const targetId = UuidParam.parse(req.params.userId);
    const { orgId, role: actorRole } = req.membership!;
    const leaving = targetId === req.userId;

    await withTenant(pool, orgId, async (tx) => {
      const target = (await tx.query<{ role: keyof typeof ROLE_RANK }>(
        "SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2 FOR UPDATE", [orgId, targetId],
      )).rows[0];
      if (!target) throw new HttpError(404, "Member not found", "not_found");

      if (leaving) {
        if (target.role === "owner") throw new HttpError(400, "Owners must transfer ownership before leaving", "bad_request");
      } else if (ROLE_RANK[actorRole] < ROLE_RANK.admin || ROLE_RANK[target.role] >= ROLE_RANK[actorRole]) {
        throw new HttpError(403, "You cannot remove this member", "forbidden");
      }
      await tx.query("DELETE FROM memberships WHERE org_id = $1 AND user_id = $2", [orgId, targetId]);
      await audit(tx, { orgId, actorId: req.userId!, action: leaving ? "member.left" : "member.removed", entityType: "user", entityId: targetId });
    });
    res.status(204).end();
  });

  /* ---------- audit log ---------- */

  router.get("/orgs/:orgId/audit", member, requirePermission("audit:read"), async (req, res) => {
    const { limit, offset } = PageQuery.parse(req.query);
    const rows = await withTenant(pool, req.membership!.orgId, async (tx) =>
      (await tx.query(
        `SELECT id, actor_id, action, entity_type, entity_id, metadata, created_at
         FROM audit_logs ORDER BY id DESC LIMIT $1 OFFSET $2`,
        [limit, offset],
      )).rows,
    );
    res.json({ items: rows });
  });

  return router;
}
