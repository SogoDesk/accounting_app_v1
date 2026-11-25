-- =============================================================================
-- Migration 004 — Organization hierarchy + location axis (Blueprint Step 1)
--
--   Adds a hierarchical org tree (GROUP -> ENTITY -> BRANCH) ON TOP of the
--   existing regions-as-entity model WITHOUT breaking it: each ENTITY org_unit
--   links to a region (entity_id keeps referencing regions). Adds location_id
--   to the ledger, plus integer-minor money columns and schema-free custom
--   fields. Non-destructive and idempotent.
--
--   NOTE: all DDL (ADD COLUMN / CREATE INDEX) runs BEFORE any UPDATE on the
--   ledger tables — updating journal_lines/entries queues the deferred GL
--   balance-trigger events, after which Postgres forbids ALTER TABLE on those
--   tables ("pending trigger events").
--
--   Depends on: regions (001 functional_currency), journal_entries/lines (002).
-- =============================================================================

BEGIN;

-- 1) The org tree -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS org_units (
    id                  bigserial PRIMARY KEY,
    parent_id           bigint REFERENCES org_units(id) ON DELETE RESTRICT,
    unit_type           text NOT NULL CHECK (unit_type IN ('GROUP','ENTITY','REGION','BRANCH')),
    code                text NOT NULL UNIQUE,
    name                text NOT NULL,
    is_legal_entity     boolean NOT NULL DEFAULT false,
    functional_currency varchar(10),
    region_id           int REFERENCES regions(id) ON DELETE SET NULL,  -- link ENTITY -> existing region
    path                text NOT NULL DEFAULT '',
    depth               int  NOT NULL DEFAULT 0,
    status              text NOT NULL DEFAULT 'ACTIVE',
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_org_path   ON org_units (path text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_org_parent ON org_units (parent_id);
CREATE INDEX IF NOT EXISTS idx_org_region ON org_units (region_id);

-- maintain materialized path + depth automatically (serial id is set before BEFORE triggers)
CREATE OR REPLACE FUNCTION org_set_path() RETURNS trigger AS $$
DECLARE p_path text; p_depth int;
BEGIN
    IF NEW.parent_id IS NULL THEN
        NEW.path := NEW.id::text; NEW.depth := 0;
    ELSE
        SELECT path, depth INTO p_path, p_depth FROM org_units WHERE id = NEW.parent_id;
        NEW.path := p_path || '.' || NEW.id; NEW.depth := p_depth + 1;
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_org_set_path ON org_units;
CREATE TRIGGER trg_org_set_path BEFORE INSERT ON org_units
    FOR EACH ROW EXECUTE FUNCTION org_set_path();

-- nearest legal entity walking up the tree
CREATE OR REPLACE FUNCTION owning_entity_id(p_unit bigint) RETURNS bigint AS $$
  WITH RECURSIVE up AS (
    SELECT id, parent_id, is_legal_entity FROM org_units WHERE id = p_unit
    UNION ALL
    SELECT o.id, o.parent_id, o.is_legal_entity FROM org_units o JOIN up ON o.id = up.parent_id
  ) SELECT id FROM up WHERE is_legal_entity ORDER BY id LIMIT 1;
$$ LANGUAGE sql STABLE;

-- 2) Seed: root GROUP -> one ENTITY per region -> one default BRANCH per entity
INSERT INTO org_units (parent_id, unit_type, code, name, is_legal_entity)
SELECT NULL, 'GROUP', 'GRP', 'Group (Consolidated)', false
WHERE NOT EXISTS (SELECT 1 FROM org_units WHERE code = 'GRP');

INSERT INTO org_units (parent_id, unit_type, code, name, is_legal_entity, functional_currency, region_id)
SELECT g.id, 'ENTITY', r.region_code, r.region_name, true,
       COALESCE(r.functional_currency, r.default_currency), r.id
FROM regions r CROSS JOIN (SELECT id FROM org_units WHERE code = 'GRP') g
WHERE NOT EXISTS (SELECT 1 FROM org_units o WHERE o.region_id = r.id AND o.unit_type = 'ENTITY');

INSERT INTO org_units (parent_id, unit_type, code, name, is_legal_entity, functional_currency, region_id)
SELECT e.id, 'BRANCH', e.code || '-HQ', e.name || ' — HQ', false, e.functional_currency, e.region_id
FROM org_units e
WHERE e.unit_type = 'ENTITY'
  AND NOT EXISTS (SELECT 1 FROM org_units b WHERE b.parent_id = e.id AND b.unit_type = 'BRANCH');

-- 3) ALL ledger DDL FIRST (before any UPDATE queues deferred trigger events) --
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS location_id bigint REFERENCES org_units(id);
ALTER TABLE journal_lines
    ADD COLUMN IF NOT EXISTS location_id       bigint REFERENCES org_units(id),
    ADD COLUMN IF NOT EXISTS debit_minor       bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS credit_minor      bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS base_minor_debit  bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS base_minor_credit bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS custom_fields     jsonb  NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_je_location ON journal_entries (location_id);
CREATE INDEX IF NOT EXISTS idx_jl_location ON journal_lines (location_id);
CREATE INDEX IF NOT EXISTS idx_jl_custom   ON journal_lines USING gin (custom_fields);

CREATE TABLE IF NOT EXISTS custom_field_defs (
    id          bigserial PRIMARY KEY,
    applies_to  text NOT NULL,
    key         text NOT NULL,
    label       text NOT NULL,
    data_type   text NOT NULL CHECK (data_type IN ('text','number','date','bool','select')),
    options     jsonb,
    required    boolean NOT NULL DEFAULT false,
    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (applies_to, key)
);

-- 4) NOW the backfills (these queue deferred GL trigger events; no DDL after) -
UPDATE journal_entries je SET location_id = b.id
  FROM org_units e JOIN org_units b ON b.parent_id = e.id AND b.unit_type = 'BRANCH'
 WHERE e.unit_type = 'ENTITY' AND e.region_id = je.entity_id AND je.location_id IS NULL;

UPDATE journal_lines jl SET location_id = b.id
  FROM org_units e JOIN org_units b ON b.parent_id = e.id AND b.unit_type = 'BRANCH'
 WHERE e.unit_type = 'ENTITY' AND e.region_id = jl.entity_id AND jl.location_id IS NULL;

UPDATE journal_lines SET
    debit_minor       = ROUND(debit * 100)::bigint,
    credit_minor      = ROUND(credit * 100)::bigint,
    base_minor_debit  = ROUND(debit_base * 100)::bigint,
    base_minor_credit = ROUND(credit_base * 100)::bigint
WHERE debit_minor = 0 AND credit_minor = 0 AND (debit <> 0 OR credit <> 0 OR debit_base <> 0 OR credit_base <> 0);

COMMIT;

-- =============================================================================
-- Next blueprint steps: 005 RBAC (user_org_access + RLS), then route the
-- posting service through the refactored ledgerEngine (location tagging, integer
-- math, hash chain, race-free entry numbers), then intercompany + FX revaluation.
-- =============================================================================
