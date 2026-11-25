-- =============================================================================
-- Migration 021 — Backfill tenant_id = 1
--
--   Every pre-existing row belongs to the original company (tenant 1).
--   Only UPDATEs, no DDL (see the note in 020). Idempotent.
--   Must run BEFORE 022 enables row-level security (after that, rows with
--   tenant_id NULL are invisible to the app role).
--   The ledger immutability trigger (006) only blocks changes to
--   entry_hash / entry_date / entity_id, so setting tenant_id is allowed.
--   Depends on: 019, 020.
-- =============================================================================

BEGIN;

DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND c.column_name  = 'tenant_id'
       AND tb.table_type  = 'BASE TABLE'
  LOOP
    EXECUTE format('UPDATE public.%I SET tenant_id = 1 WHERE tenant_id IS NULL', t);
  END LOOP;
END $$;

COMMIT;
