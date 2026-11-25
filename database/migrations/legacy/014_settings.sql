-- =============================================================================
-- Migration 014 — Settings module
--
--   Adds the config tables behind Settings → Numbering / Tax & Terms /
--   Roles & Permissions. Company settings, exchange rates and invoice reminder
--   settings already exist (001 / 000_base) and are only READ/updated by the new
--   Settings screens, so no DDL for them here.
--
--   The runtime equivalent is backend/modules/settings/ensureSettingsSchema.js
--   (self-healing, called by the Settings controllers), so the screens work even
--   before this migration is applied by hand. Idempotent. Safe to re-run.
-- =============================================================================

BEGIN;

-- 1) Per-document numbering config ------------------------------------------
CREATE TABLE IF NOT EXISTS document_numbering_config (
    doc_type      text PRIMARY KEY,
    label         text NOT NULL,
    prefix        text NOT NULL,
    padding       integer NOT NULL DEFAULT 6,
    include_year  boolean NOT NULL DEFAULT true,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT document_numbering_padding_check CHECK (padding BETWEEN 1 AND 12)
);

INSERT INTO document_numbering_config (doc_type, label, prefix, padding, include_year) VALUES
    ('invoice', 'Invoices',          'INV',  6, true),
    ('bill',    'Vendor Bills',      'BILL', 6, true),
    ('payment', 'Customer Payments', 'PAY',  6, true),
    ('vpay',    'Vendor Payments',   'VPAY', 6, true)
ON CONFLICT (doc_type) DO NOTHING;

-- 2) Reusable tax rates ------------------------------------------------------
CREATE TABLE IF NOT EXISTS tax_rates (
    id           serial PRIMARY KEY,
    name         text NOT NULL,
    rate_percent numeric(6,3) NOT NULL DEFAULT 0,
    region_id    integer REFERENCES regions(id) ON DELETE SET NULL,
    is_default   boolean NOT NULL DEFAULT false,
    status       text NOT NULL DEFAULT 'ACTIVE',
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tax_rates_status_check CHECK (status IN ('ACTIVE','INACTIVE')),
    CONSTRAINT tax_rates_rate_check CHECK (rate_percent >= 0 AND rate_percent <= 100)
);

-- 3) Role permission matrix --------------------------------------------------
ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;
UPDATE roles SET is_system = true
    WHERE role_name IN ('SUPER_ADMIN','FINANCE_ADMIN','ACCOUNT_MANAGER','RECRUITER');

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id        integer NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_key text NOT NULL,
    PRIMARY KEY (role_id, permission_key)
);

-- Seed defaults that reproduce the existing menu visibility. Guarded per role
-- (only seeds a role that has no rows yet) so re-runs never clobber edits.
-- See ensureSettingsSchema.js DEFAULT_ROLE_PERMISSIONS for the authoritative map.

COMMIT;
