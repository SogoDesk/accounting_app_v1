-- =============================================================================
-- Migration 005 — Row-level RBAC (Blueprint Step 2 / audit §3.4)
--
--   A user is granted access to org_units; the grant cascades to every
--   descendant via the materialized org_units.path. user_allowed_locations()
--   expands a user's grants to the full reachable set of location ids. The
--   query layer (scopeMiddleware -> controllers) filters financial rows to the
--   owning entities of those locations.
--
--   Seed: every EXISTING user gets ADMIN on the GRP root so nothing breaks on
--   rollout. Tighten grants afterwards per user.
--
--   RLS scaffolding is included but LEFT DISABLED (commented) on purpose: it
--   requires SET LOCAL app.user_id on a per-request transaction (audit step
--   2.4) which this app does not yet run. We ship the query-layer scoping in
--   scopeMiddleware instead. To enable DB-side defense-in-depth later, wire the
--   GUC per request and uncomment the ENABLE/POLICY block at the bottom.
--
--   Idempotent. No ledger UPDATEs here, so trigger-ordering is moot.
--   Depends on: users (base), org_units (004).
-- =============================================================================

BEGIN;

-- 1) Grants table -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_org_access (
    user_id     int    NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
    org_unit_id bigint NOT NULL REFERENCES org_units(id) ON DELETE CASCADE,
    access      text   NOT NULL CHECK (access IN ('VIEW','EDIT','POST','ADMIN')),
    PRIMARY KEY (user_id, org_unit_id)
);
CREATE INDEX IF NOT EXISTS idx_uoa_user ON user_org_access (user_id);

-- 2) Expand a user's grants to self + all descendant org units (via path) ----
--    Returns the strongest access where a location is reachable by >1 grant.
CREATE OR REPLACE FUNCTION user_allowed_locations(p_user int)
RETURNS TABLE(org_unit_id bigint, access text) AS $$
  SELECT d.id AS org_unit_id,
         (ARRAY_AGG(a.access ORDER BY
            CASE a.access WHEN 'ADMIN' THEN 0 WHEN 'POST' THEN 1
                          WHEN 'EDIT' THEN 2 ELSE 3 END))[1] AS access
  FROM user_org_access a
  JOIN org_units g ON g.id = a.org_unit_id
  JOIN org_units d ON d.path LIKE g.path || '%'
  WHERE a.user_id = p_user
  GROUP BY d.id;
$$ LANGUAGE sql STABLE;

-- 3) Seed: grant every existing user ADMIN on the GRP root -------------------
INSERT INTO user_org_access (user_id, org_unit_id, access)
SELECT u.id, (SELECT id FROM org_units WHERE code = 'GRP'), 'ADMIN'
FROM users u
WHERE EXISTS (SELECT 1 FROM org_units WHERE code = 'GRP')
ON CONFLICT DO NOTHING;

COMMIT;

-- =============================================================================
-- OPTIONAL DB-side RLS (defense in depth). Only enable together with a
-- per-request `SET LOCAL app.user_id = <id>` on the request's transaction
-- (audit step 2.4). Until that is wired, leaving this on would block ALL
-- queries (current_setting('app.user_id') would be unset). Kept as scaffold:
--
--   ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
--   ALTER TABLE journal_lines   ENABLE ROW LEVEL SECURITY;
--   ALTER TABLE invoices        ENABLE ROW LEVEL SECURITY;
--   ALTER TABLE bills           ENABLE ROW LEVEL SECURITY;
--   ALTER TABLE expenses        ENABLE ROW LEVEL SECURITY;
--
--   CREATE POLICY rls_je ON journal_entries USING (
--     entity_id IN (
--       SELECT owning_entity_id(org_unit_id)
--       FROM user_allowed_locations(current_setting('app.user_id')::int)));
--   -- (repeat the analogous policy for journal_lines/invoices/bills using
--   --  entity_id, and expenses using entity_id.)
-- =============================================================================
