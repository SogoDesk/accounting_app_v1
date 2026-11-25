-- =============================================================================
-- Migration 019 — Multi-tenancy foundation
--
--   tenants — one row per company. Login is (tenant_code, email, password).
--   users.tenant_id (added in 020) ties each user to exactly ONE company.
--   users.is_platform_admin marks SaaS operators allowed on /api/platform.
--
--   Matches the schema of the team dev DB (accounting_dev_db). Idempotent.
--   Change tenant 1's name/code below before a fresh install if needed.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS tenants (
    id           serial       PRIMARY KEY,
    tenant_name  varchar(150) NOT NULL,
    tenant_code  varchar(50)  NOT NULL,
    status       varchar(20)  DEFAULT 'ACTIVE',
    created_at   timestamp    DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT tenants_tenant_code_key UNIQUE (tenant_code)
);

-- Existing company = tenant 1 (fixed id so the backfill in 021 is deterministic)
INSERT INTO tenants (id, tenant_name, tenant_code)
VALUES (1, 'Acme Company', 'ACME')
ON CONFLICT (id) DO NOTHING;

SELECT setval(pg_get_serial_sequence('tenants', 'id'),
              GREATEST((SELECT MAX(id) FROM tenants), 1), true);

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin boolean NOT NULL DEFAULT false;

COMMIT;
