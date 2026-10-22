import { Router } from "express";
import type pg from "pg";
import { withTenant } from "../db.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { CreateInvoiceSchema, InvoiceStatusSchema, PageQuery, UuidParam } from "../lib/schemas.js";
import { requirePermission } from "../middleware/auth.js";

/** Allowed status changes. Anything not listed is rejected. */
const TRANSITIONS: Record<string, readonly string[]> = {
  draft: ["sent", "void"],
  sent: ["paid", "void"],
  paid: [],
  void: [],
};

const COLUMNS = "id, client_id, number, status, currency, issue_date, due_date, total_cents, created_by, created_at";

export function invoicesRouter(pool: pg.Pool): Router {
  const router = Router({ mergeParams: true });

  router.get("/", requirePermission("invoices:read"), async (req, res) => {
    const { limit, offset } = PageQuery.parse(req.query);
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const { orgId } = req.membership!;
    const items = await withTenant(pool, orgId, async (tx) =>
      (await tx.query(
        `SELECT ${COLUMNS} FROM invoices
         WHERE org_id = $1 AND ($2::text IS NULL OR status = $2)
         ORDER BY number DESC LIMIT $3 OFFSET $4`,
        [orgId, status, limit, offset],
      )).rows,
    );
    res.json({ items });
  });

  router.post("/", requirePermission("invoices:write"), async (req, res) => {
    const input = CreateInvoiceSchema.parse(req.body);
    const { orgId } = req.membership!;
    // The server computes the total; a client-sent total is never trusted.
    const total = input.items.reduce((sum, i) => sum + i.quantity * i.unit_price_cents, 0);

    const invoice = await withTenant(pool, orgId, async (tx) => {
      const client = await tx.query("SELECT 1 FROM clients WHERE org_id = $1 AND id = $2", [orgId, input.client_id]);
      if (!client.rowCount) throw new HttpError(404, "Client not found", "not_found");

      // Lock the org row so two concurrent requests can't take the same invoice number.
      await tx.query("SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE", [orgId]);
      const next = (await tx.query<{ n: number }>(
        "SELECT COALESCE(MAX(number), 0) + 1 AS n FROM invoices WHERE org_id = $1", [orgId],
      )).rows[0]!.n;

      const inv = (await tx.query<{ id: string }>(
        `INSERT INTO invoices (org_id, client_id, number, currency, due_date, total_cents, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
        [orgId, input.client_id, next, input.currency, input.due_date ?? null, total, req.userId],
      )).rows[0]!;

      for (const item of input.items) {
        await tx.query(
          `INSERT INTO invoice_items (org_id, invoice_id, description, quantity, unit_price_cents)
           VALUES ($1, $2, $3, $4, $5)`,
          [orgId, inv.id, item.description, item.quantity, item.unit_price_cents],
        );
      }
      await audit(tx, { orgId, actorId: req.userId!, action: "invoice.created", entityType: "invoice", entityId: inv.id, metadata: { number: next, total_cents: total } });
      return { ...inv, items: input.items };
    });
    res.status(201).json(invoice);
  });

  router.get("/:invoiceId", requirePermission("invoices:read"), async (req, res) => {
    const id = UuidParam.parse(req.params.invoiceId);
    const { orgId } = req.membership!;
    const invoice = await withTenant(pool, orgId, async (tx) => {
      const inv = (await tx.query(`SELECT ${COLUMNS} FROM invoices WHERE org_id = $1 AND id = $2`, [orgId, id])).rows[0];
      if (!inv) return null;
      const items = (await tx.query(
        "SELECT description, quantity, unit_price_cents FROM invoice_items WHERE invoice_id = $1 ORDER BY id",
        [id],
      )).rows;
      return { ...inv, items };
    });
    if (!invoice) throw new HttpError(404, "Invoice not found", "not_found");
    res.json(invoice);
  });

  router.post("/:invoiceId/status", requirePermission("invoices:change_status"), async (req, res) => {
    const id = UuidParam.parse(req.params.invoiceId);
    const { status } = InvoiceStatusSchema.parse(req.body);
    const { orgId } = req.membership!;

    const invoice = await withTenant(pool, orgId, async (tx) => {
      const current = (await tx.query<{ status: string }>(
        "SELECT status FROM invoices WHERE org_id = $1 AND id = $2 FOR UPDATE", [orgId, id],
      )).rows[0];
      if (!current) throw new HttpError(404, "Invoice not found", "not_found");
      if (!TRANSITIONS[current.status]!.includes(status)) {
        throw new HttpError(409, `Cannot change status from ${current.status} to ${status}`, "invalid_transition");
      }
      const updated = (await tx.query(`UPDATE invoices SET status = $1 WHERE id = $2 RETURNING ${COLUMNS}`, [status, id])).rows[0];
      await audit(tx, { orgId, actorId: req.userId!, action: `invoice.${status}`, entityType: "invoice", entityId: id, metadata: { from: current.status } });
      return updated;
    });
    res.json(invoice);
  });

  return router;
}
