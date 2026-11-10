-- =============================================================================
-- 017_fix_je_source_recognition.sql
--
-- Migration 008 added 'RECOGNITION' to journal_entries.je_source_check, but
-- migration 016 later re-defined that constraint WITHOUT it — silently breaking
-- every recognition post (recognitionService posts source='RECOGNITION') and,
-- with it, the monthly close that runs recognition. This restores the full,
-- correct source list (016's list + RECOGNITION).
--
-- Idempotent: safe to re-run.
-- =============================================================================
BEGIN;

ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS je_source_check;
ALTER TABLE journal_entries ADD  CONSTRAINT je_source_check CHECK (source IN (
  'MANUAL','AR_INVOICE','AR_PAYMENT','AP_BILL','AP_PAYMENT','FX_REVAL',
  'OPENING','EXPENSE','EXPENSE_REIMBURSE','INTERCOMPANY','IC_INVOICE','RECOGNITION'));

COMMIT;
