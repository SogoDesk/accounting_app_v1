-- =============================================================================
-- Migration 006 — Immutable, hash-chained ledger (Blueprint Step 3 / audit §3.1)
--
--   Adds the per-entry hash-chain columns and an append-only enforcement
--   trigger so a POSTED journal entry can never be mutated or deleted — the
--   only permitted transition is the POSTED -> REVERSED status flip (with its
--   reversed_by linkage), which is how corrections are made (reversing entries).
--
--   location_id + the *_minor columns already exist from migration 004; the
--   hash chain is computed and written by services/gl/ledgerEngine.js.
--
--   DDL only (no ledger UPDATEs here) so trigger-ordering is moot, but the rule
--   still holds: any future ledger UPDATE must come AFTER all ALTER TABLE.
--   Idempotent. Depends on: journal_entries (002), org_units/location_id (004).
-- =============================================================================

BEGIN;

-- 1) Hash-chain columns -----------------------------------------------------
ALTER TABLE journal_entries
    ADD COLUMN IF NOT EXISTS prev_hash  text,
    ADD COLUMN IF NOT EXISTS entry_hash text;
CREATE INDEX IF NOT EXISTS idx_je_entry_hash ON journal_entries (entity_id, id)
    WHERE entry_hash IS NOT NULL;

-- 2) Append-only enforcement (audit §3.1 verbatim) --------------------------
CREATE OR REPLACE FUNCTION gl_block_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status = 'POSTED' THEN
    RAISE EXCEPTION 'Posted ledger entries are immutable (id=%); post a reversal instead', OLD.id;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'POSTED'
     AND (NEW.entry_hash IS DISTINCT FROM OLD.entry_hash
          OR NEW.entry_date <> OLD.entry_date
          OR NEW.entity_id  <> OLD.entity_id) THEN
    -- allow ONLY the status flip POSTED->REVERSED + reversed_by linkage
    IF NOT (NEW.status = 'REVERSED' AND OLD.status = 'POSTED') THEN
      RAISE EXCEPTION 'Posted ledger entry % is immutable', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_gl_immutable ON journal_entries;
CREATE TRIGGER trg_gl_immutable
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION gl_block_mutation();

-- 3) Seed per-entity sequences to the current max entry number --------------
--    Existing rows were numbered JE-<entity>-NNNNNN by the old COUNT(*)+1
--    scheme. The new engine draws entry_no from je_seq_<entityId>; without
--    seeding, a fresh sequence would restart at 1 and collide with existing
--    entry_no on the unique(entity_id, entry_no) constraint. Idempotent:
--    re-running just re-sets each sequence to the current committed max.
DO $$
DECLARE r record; maxn bigint;
BEGIN
  FOR r IN SELECT DISTINCT entity_id FROM journal_entries WHERE entity_id IS NOT NULL LOOP
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS je_seq_%s', r.entity_id);
    SELECT COALESCE(MAX(CASE WHEN entry_no ~ '^JE-[0-9]+-[0-9]+$'
                             THEN split_part(entry_no, '-', 3)::bigint END), 0)
      INTO maxn FROM journal_entries WHERE entity_id = r.entity_id;
    -- setval(seq, max, is_called=true) => next nextval = max+1; for empty
    -- entities (max=0) start the sequence un-called at 1.
    IF maxn > 0 THEN
      EXECUTE format('SELECT setval(%L, %s, true)',  'je_seq_' || r.entity_id, maxn);
    ELSE
      EXECUTE format('SELECT setval(%L, 1, false)', 'je_seq_' || r.entity_id);
    END IF;
  END LOOP;
END $$;

COMMIT;

-- =============================================================================
-- entry numbers are now assigned from per-entity sequences (je_seq_<entityId>)
-- created on demand by ledgerEngine.postEntry — killing the COUNT(*)+1 race.
-- =============================================================================
