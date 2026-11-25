-- =============================================================================
-- Migration 025 — Client admin invitations
--
--   When the platform operator onboards a client, the client's first admin is
--   created INACTIVE and receives a one-time link to set their own password.
--   Only a SHA-256 hash of the token is stored.
--
--   This is a platform-level table: the tenant column is deliberately NOT named
--   `tenant_id`, so the RLS loop in migration 022 never applies tenant
--   isolation to it (invites are looked up before any tenant is known).
--
--   Also applied automatically by services/platform/ensurePlatformSchema.js.
--   Idempotent.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_invites (
    id                serial       PRIMARY KEY,
    invite_tenant_id  integer      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id           integer      NOT NULL,
    email             varchar(255) NOT NULL,
    token_hash        char(64)     NOT NULL,
    expires_at        timestamp    NOT NULL,
    accepted_at       timestamp,
    created_at        timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT tenant_invites_token_hash_key UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS idx_tenant_invites_tenant
    ON tenant_invites (invite_tenant_id, created_at DESC);

COMMIT;
