import type { Queryable } from "../db.js";

export interface AuditEntry {
  orgId: string;
  actorId: string | null;
  action: string; // e.g. "invoice.created"
  entityType: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

/** Write an audit record using the caller's transaction, so it commits or rolls back with the change. */
export async function audit(tx: Queryable, e: AuditEntry): Promise<void> {
  await tx.query(
    `INSERT INTO audit_logs (org_id, actor_id, action, entity_type, entity_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [e.orgId, e.actorId, e.action, e.entityType, e.entityId ?? null, JSON.stringify(e.metadata ?? {})],
  );
}
