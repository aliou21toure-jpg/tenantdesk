-- 002: tenant-owned business data (clients, invoices, audit log)

CREATE TABLE clients (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  email      TEXT CHECK (email IS NULL OR char_length(email) <= 254),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Lets invoices reference (org_id, client_id) so an invoice can never point
  -- at another tenant's client, even through a bug in application code.
  UNIQUE (org_id, id)
);
CREATE INDEX clients_org_idx ON clients (org_id, name);

CREATE TABLE invoices (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id   UUID NOT NULL,
  number      INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid', 'void')),
  currency    TEXT NOT NULL DEFAULT 'CAD' CHECK (currency ~ '^[A-Z]{3}$'),
  issue_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date    DATE,
  total_cents BIGINT NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, client_id) REFERENCES clients (org_id, id) ON DELETE RESTRICT
);

CREATE TABLE invoice_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL,
  invoice_id       UUID NOT NULL,
  description      TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 500),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents BIGINT NOT NULL CHECK (unit_price_cents >= 0),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices (org_id, id) ON DELETE CASCADE
);
CREATE INDEX invoice_items_invoice_idx ON invoice_items (invoice_id);

CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_idx ON audit_logs (org_id, created_at DESC);
