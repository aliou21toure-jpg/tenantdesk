# TenantDesk

[![CI](https://github.com/aliou21toure-jpg/tenantdesk/actions/workflows/ci.yml/badge.svg)](https://github.com/aliou21toure-jpg/tenantdesk/actions/workflows/ci.yml)

A **multi-tenant invoicing SaaS API**: organizations, team members with roles, clients and invoices —
with tenant isolation enforced twice, in the application *and* in PostgreSQL with **Row-Level Security**.

## Security design

Multi-tenancy bugs are among the most damaging in SaaS: one missing `WHERE org_id = ...` and
customer A sees customer B's invoices (OWASP API #1: Broken Object Level Authorization).
TenantDesk is designed so that a single bug cannot leak data:

1. **Membership check** — every `/orgs/:orgId/*` request loads the caller's membership first.
   Non-members get `404`, not `403`, so the API never confirms another tenant exists.
2. **Explicit `org_id` filters** in every query.
3. **Row-Level Security** — each request runs in a transaction that sets `app.current_org`;
   PostgreSQL policies hide all other tenants' rows. Forget to set it, and queries return
   *nothing* (fails closed). Tests prove this directly against the database.
4. **Composite foreign keys** — an invoice references `(org_id, client_id)`, so it is impossible
   at the schema level to invoice another tenant's client.

## Features

- **Authentication:** Argon2id password hashing, short-lived JWT access tokens (algorithm pinned, issuer/audience checked),
  opaque refresh tokens stored as SHA-256 hashes, **rotation with reuse detection**, logout, timing-safe login
  (no account enumeration), rate limiting on auth routes
- **Authorization:** role-based access control (`owner`, `admin`, `member`, `viewer`) defined in one permission matrix;
  rules against privilege escalation (can't grant above your own role, can't change your own role, admins can't remove peers)
- **Business logic:** clients; invoices with line items, server-computed totals in integer cents, per-organization
  sequential numbering that is safe under concurrent requests (row lock), and a status state machine (`draft → sent → paid`, `void`)
- **Audit log:** every change is recorded in the same transaction; the table is append-only (enforced by a trigger)
- **API design:** consistent error format with machine-readable `code`s, pagination, full **OpenAPI 3.1** spec in `openapi.yaml`
- **43 integration tests** covering auth attacks (forged/`alg:none`/expired tokens, token replay), tenant isolation at
  API and database level, every role's permissions, invoice workflow and concurrency

## Architecture

```
request ─▶ helmet · logging (auth header redacted) · JSON
        ─▶ /auth/*             (rate limited)                  → routes/auth.ts
        ─▶ authenticate        (verify JWT → req.userId)
        ─▶ requireMembership   (load role for :orgId → req.membership, else 404)
        ─▶ requirePermission   (permission matrix → else 403)
        ─▶ route handler ─▶ withTenant(orgId) ─▶ BEGIN; set_config('app.current_org'); ...; COMMIT
                                                    └─▶ PostgreSQL RLS policies filter every row
```

| File | Responsibility |
|---|---|
| `src/lib/tokens.ts` | Password hashing, JWT signing/verification, refresh token generation and hashing |
| `src/lib/permissions.ts` | The role → permission matrix |
| `src/middleware/auth.ts` | `authenticate`, `requireMembership`, `requirePermission` |
| `src/db.ts` | Connection pool, `withTransaction`, `withTenant` |
| `src/routes/*.ts` | Auth, organizations & members, clients, invoices |
| `sql/003_row_level_security.sql` | RLS policies and the append-only audit trigger |

## Run it

```bash
docker compose up --build        # API on http://localhost:4000
```

Or for development:
```bash
docker compose up -d db
cp .env.example .env && cp .env.test.example .env.test
npm install
npm run db:migrate && npm run db:migrate:test
npm run dev
npm test
```

> The app must connect as a **non-superuser** role — PostgreSQL superusers bypass Row-Level Security.
> `docker/init-db.sql` creates that role.

## Try it

```bash
# Register (creates you + your organization)
curl -s -X POST localhost:4000/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","name":"Me","password":"a long passphrase here","organization":"My Co"}'
# → { "user_id", "org_id", "access_token", "refresh_token", ... }

TOKEN=...; ORG=...
curl -s -X POST localhost:4000/orgs/$ORG/clients -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"Acme"}'
```

See `openapi.yaml` for every endpoint (paste it into https://editor.swagger.io to browse).

## Tech stack

TypeScript · Node.js 24 · Express 5 · PostgreSQL 16 (Row-Level Security) · Argon2 · JWT · Zod · Vitest · Supertest · Docker · GitHub Actions
