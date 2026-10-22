-- Runs once when the Postgres container is first created.
-- The app connects as a NON-superuser role: superusers bypass Row-Level Security.
CREATE ROLE tenantdesk LOGIN PASSWORD 'tenantdesk' NOSUPERUSER;
CREATE DATABASE tenantdesk OWNER tenantdesk;
CREATE DATABASE tenantdesk_test OWNER tenantdesk;
