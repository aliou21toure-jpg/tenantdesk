import { Router } from "express";
import type pg from "pg";
import { withTenant } from "../db.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { ClientSchema, PageQuery, UuidParam } from "../lib/schemas.js";
import { requirePermission } from "../middleware/auth.js";

/**
 * Mounted at /orgs/:orgId/clients after requireMembership.
 * Queries rely on Row-Level Security for tenant isolation AND filter by org_id
 * explicitly (defense in depth: two independent safeguards).
 */
export function clientsRouter(pool: pg.Pool): Router {
  const router = Router({ mergeParams: true });

  router.get("/", requirePermission("clients:read"), async (req, res) => {
    const { limit, offset } = PageQuery.parse(req.query);
    const { orgId } = req.membership!;
    const items = await withTenant(pool, orgId, async (tx) =>
      (await tx.query(
        "SELECT id, name, email, created_at FROM clients WHERE org_id = $1 ORDER BY name LIMIT $2 OFFSET $3",
        [orgId, limit, offset],
      )).rows,
    );
    res.json({ items });
  });

  router.post("/", requirePermission("clients:write"), async (req, res) => {
    const input = ClientSchema.parse(req.body);
    const { orgId } = req.membership!;
    const client = await withTenant(pool, orgId, async (tx) => {
      const c = (await tx.query<{ id: string }>(
        "INSERT INTO clients (org_id, name, email) VALUES ($1, $2, $3) RETURNING id, name, email, created_at",
        [orgId, input.name, input.email ?? null],
      )).rows[0]!;
      await audit(tx, { orgId, actorId: req.userId!, action: "client.created", entityType: "client", entityId: c.id });
      return c;
    });
    res.status(201).json(client);
  });

  router.get("/:clientId", requirePermission("clients:read"), async (req, res) => {
    const id = UuidParam.parse(req.params.clientId);
    const { orgId } = req.membership!;
    const client = await withTenant(pool, orgId, async (tx) =>
      (await tx.query("SELECT id, name, email, created_at FROM clients WHERE org_id = $1 AND id = $2", [orgId, id])).rows[0],
    );
    if (!client) throw new HttpError(404, "Client not found", "not_found");
    res.json(client);
  });

  router.patch("/:clientId", requirePermission("clients:write"), async (req, res) => {
    const id = UuidParam.parse(req.params.clientId);
    const input = ClientSchema.partial().parse(req.body);
    const { orgId } = req.membership!;
    const client = await withTenant(pool, orgId, async (tx) => {
      const { rows } = await tx.query(
        `UPDATE clients SET name = COALESCE($3, name),
                            email = CASE WHEN $4::boolean THEN $5 ELSE email END
         WHERE org_id = $1 AND id = $2 RETURNING id, name, email, created_at`,
        [orgId, id, input.name ?? null, input.email !== undefined, input.email ?? null],
      );
      if (rows[0]) await audit(tx, { orgId, actorId: req.userId!, action: "client.updated", entityType: "client", entityId: id });
      return rows[0];
    });
    if (!client) throw new HttpError(404, "Client not found", "not_found");
    res.json(client);
  });

  router.delete("/:clientId", requirePermission("clients:delete"), async (req, res) => {
    const id = UuidParam.parse(req.params.clientId);
    const { orgId } = req.membership!;
    const deleted = await withTenant(pool, orgId, async (tx) => {
      // Fails with 409 (FK violation) if the client still has invoices.
      const { rowCount } = await tx.query("DELETE FROM clients WHERE org_id = $1 AND id = $2", [orgId, id]);
      if (rowCount) await audit(tx, { orgId, actorId: req.userId!, action: "client.deleted", entityType: "client", entityId: id });
      return Boolean(rowCount);
    });
    if (!deleted) throw new HttpError(404, "Client not found", "not_found");
    res.status(204).end();
  });

  return router;
}
