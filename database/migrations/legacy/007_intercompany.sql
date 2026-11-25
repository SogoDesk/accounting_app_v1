-- =============================================================================
-- Migration 007 — Intercompany transfers + elimination accounts
--                  (Blueprint Step 4 / audit §3.2)
--
--   A transfer between two locations posts TWO balanced journal entries linked
--   by a shared transfer_no, using reciprocal Due From / Due To control
--   accounts that net to zero on consolidation. The intercompany_transfers row
--   records both entry ids for traceability.
--
--   COA additions 1600 (Intercompany Receivable / Due From, ASSET) and
--   2600 (Intercompany Payable / Due To, LIABILITY) are the elimination
--   accounts dropped from consolidated statements (glReports).
--
--   Idempotent. No ledger UPDATEs. Depends on: org_units (004),
--   journal_entries (002), chart_of_accounts (002).
-- =============================================================================

BEGIN;

-- 1) Intercompany transfer ledger (audit §3.2 verbatim) ---------------------
CREATE TABLE IF NOT EXISTS intercompany_transfers (
    id            bigserial PRIMARY KEY,
    transfer_no   text UNIQUE NOT NULL,
    from_location bigint NOT NULL REFERENCES org_units(id),
    to_location   bigint NOT NULL REFERENCES org_units(id),
    amount        numeric(20,4) NOT NULL,
    currency      varchar(10) NOT NULL,
    transfer_date date NOT NULL,
    memo          text,
    from_entry_id bigint REFERENCES journal_entries(id),
    to_entry_id   bigint REFERENCES journal_entries(id),
    created_by    int REFERENCES users(id),
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ict_from ON intercompany_transfers (from_location);
CREATE INDEX IF NOT EXISTS idx_ict_to   ON intercompany_transfers (to_location);

-- 2) Elimination control accounts -------------------------------------------
INSERT INTO chart_of_accounts (account_code, account_name, account_type, normal_balance, is_control, is_active)
VALUES
  ('1600', 'Intercompany Receivable (Due From)', 'ASSET',     'DEBIT',  true, true),
  ('2600', 'Intercompany Payable (Due To)',      'LIABILITY', 'CREDIT', true, true)
ON CONFLICT (account_code) DO NOTHING;

-- 3) Allow the INTERCOMPANY posting source (DDL only; no ledger UPDATEs) -----
ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS je_source_check;
ALTER TABLE journal_entries ADD CONSTRAINT je_source_check CHECK (source IN (
  'MANUAL','AR_INVOICE','AR_PAYMENT','AP_BILL','AP_PAYMENT','FX_REVAL',
  'OPENING','EXPENSE','EXPENSE_REIMBURSE','INTERCOMPANY'));

COMMIT;

-- =============================================================================
-- Consolidation (glReports) excludes 1600/2600 from the consolidated P&L/BS
-- and returns their net as an `eliminations` reconciliation figure (~0).
-- =============================================================================
