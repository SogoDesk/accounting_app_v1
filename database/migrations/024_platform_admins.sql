-- =============================================================================
-- Migration 024 — Platform (SaaS operator) identity
--
--   platform_admins holds the operator account that onboards and manages
--   client companies (tenants). It is deliberately separate from `users`:
--     * no tenant_id, so it is not subject to tenant row-level security
--     * logs in at /platform/login with its own JWT secret
--     * exactly ONE row is allowed (enforced by the singleton index below)
--
--   Create / reset the account with:  npm run seed:platform-admin
--   Idempotent.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS platform_admins (
    id             serial       PRIMARY KEY,
    full_name      varchar(150) NOT NULL,
    email          varchar(255) NOT NULL,
    password_hash  text         NOT NULL,
    status         varchar(20)  NOT NULL DEFAULT 'ACTIVE',
    last_login_at  timestamp,
    created_at     timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT platform_admins_status_check CHECK (status IN ('ACTIVE', 'DISABLED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_admins_email_key
    ON platform_admins (lower(email));

-- Only one platform account may ever exist.
CREATE UNIQUE INDEX IF NOT EXISTS platform_admins_singleton
    ON platform_admins ((true));

COMMIT;
