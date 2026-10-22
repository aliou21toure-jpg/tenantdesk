-- 003: PostgreSQL Row-Level Security — tenant isolation enforced by the database.
--
-- The app runs every tenant query inside a transaction that first calls
--   SELECT set_config('app.current_org', '<org uuid>', true)
-- These policies then hide every row belonging to another organization.
-- If the app forgets to set the org, current_setting(..., true) is NULL and
-- the query sees NO rows: a bug fails closed instead of leaking data.
--
-- FORCE makes the policies apply to the table owner too (the app's DB role).
-- Note: superusers always bypass RLS, so the app must NOT connect as one.

CREATE FUNCTION app_current_org() RETURNS UUID
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.current_org', true), '')::uuid $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['clients', 'invoices', 'invoice_items', 'audit_logs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (org_id = app_current_org())
         WITH CHECK (org_id = app_current_org())', t);
  END LOOP;
END $$;

-- Audit logs are append-only: no updates or deletes from the application.
CREATE FUNCTION forbid_audit_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_change();
