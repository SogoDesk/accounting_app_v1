-- =============================================================================
-- Migration 010 — Banking: bank accounts, statement feeds, transactions, reconciliation
--
--   Supports auto bank feeds (statement import now via CSV/OFX, pluggable live
--   aggregators later) and bank reconciliation against the general ledger.
--
--   bank_accounts        — an operating bank account owned by an entity (region),
--                          mapped to a 1000-series GL account.
--   bank_statement_imports — one row per import batch (file or feed pull).
--   bank_transactions    — normalized statement lines (signed amount: + inflow /
--                          - outflow), deduped per account, with match + reconcile
--                          state and a link to the matched journal entry.
--   bank_reconciliations — a reconciliation session against a statement balance.
--
--   Idempotent. Depends on regions (000_base), chart_of_accounts (002),
--   journal_entries (002), users (000_base).
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS bank_accounts (
    id                  bigserial PRIMARY KEY,
    region_id           int  NOT NULL REFERENCES regions(id),
    gl_account_id       int  REFERENCES chart_of_accounts(id),
    name                text NOT NULL,
    bank_name           text,
    account_number_masked text,
    currency            varchar(10) NOT NULL,
    opening_balance     numeric(20,4) NOT NULL DEFAULT 0,
    opening_date        date,
    feed_source         text NOT NULL DEFAULT 'MANUAL'
                          CHECK (feed_source IN ('MANUAL','CSV','OFX','PLAID','SALTEDGE')),
    external_ref        text,
    status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
    created_by          int REFERENCES users(id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bank_accounts_region ON bank_accounts (region_id);

CREATE TABLE IF NOT EXISTS bank_statement_imports (
    id              bigserial PRIMARY KEY,
    bank_account_id bigint NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
    source          text NOT NULL,                 -- CSV | OFX | PLAID | ...
    filename        text,
    row_count       int NOT NULL DEFAULT 0,
    inserted_count  int NOT NULL DEFAULT 0,
    duplicate_count int NOT NULL DEFAULT 0,
    status          text NOT NULL DEFAULT 'COMPLETED',
    imported_by     int REFERENCES users(id),
    imported_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bank_imports_account ON bank_statement_imports (bank_account_id);

CREATE TABLE IF NOT EXISTS bank_transactions (
    id              bigserial PRIMARY KEY,
    bank_account_id bigint NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
    import_id       bigint REFERENCES bank_statement_imports(id) ON DELETE SET NULL,
    txn_date        date NOT NULL,
    value_date      date,
    description     text,
    reference       text,
    amount          numeric(20,4) NOT NULL,        -- signed: + inflow / - outflow
    currency        varchar(10) NOT NULL,
    running_balance numeric(20,4),
    external_id     text,                          -- bank-provided id (e.g. OFX FITID)
    dedupe_hash     text NOT NULL,                 -- sha256(account|date|amount|desc|ref|externalId)
    status          text NOT NULL DEFAULT 'UNMATCHED'
                      CHECK (status IN ('UNMATCHED','MATCHED','RECONCILED','IGNORED')),
    matched_entry_id   bigint REFERENCES journal_entries(id) ON DELETE SET NULL,
    matched_payment_id int,                        -- optional link to a payment (polymorphic)
    matched_type       text,                       -- JOURNAL | AR_PAYMENT | AP_PAYMENT | MANUAL_ENTRY
    reconciliation_id  bigint,                      -- FK added below once the table exists
    reconciled_at      timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (bank_account_id, dedupe_hash)
);
CREATE INDEX IF NOT EXISTS idx_bank_txns_account_date ON bank_transactions (bank_account_id, txn_date);
CREATE INDEX IF NOT EXISTS idx_bank_txns_status ON bank_transactions (bank_account_id, status);

CREATE TABLE IF NOT EXISTS bank_reconciliations (
    id                        bigserial PRIMARY KEY,
    bank_account_id           bigint NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
    statement_date            date NOT NULL,
    statement_opening_balance numeric(20,4) NOT NULL DEFAULT 0,
    statement_closing_balance numeric(20,4) NOT NULL,
    reconciled_balance        numeric(20,4) NOT NULL DEFAULT 0,
    difference                numeric(20,4) NOT NULL DEFAULT 0,
    status                    text NOT NULL DEFAULT 'IN_PROGRESS'
                                CHECK (status IN ('IN_PROGRESS','COMPLETED')),
    created_by                int REFERENCES users(id),
    created_at                timestamptz NOT NULL DEFAULT now(),
    completed_at              timestamptz
);
CREATE INDEX IF NOT EXISTS idx_bank_recon_account ON bank_reconciliations (bank_account_id, statement_date);

-- Link a reconciled transaction to its reconciliation session.
ALTER TABLE bank_transactions DROP CONSTRAINT IF EXISTS bank_txns_recon_fk;
ALTER TABLE bank_transactions
    ADD CONSTRAINT bank_txns_recon_fk
    FOREIGN KEY (reconciliation_id) REFERENCES bank_reconciliations(id) ON DELETE SET NULL;

-- Accounts used when booking bank-only lines (fees / interest) during reconciliation.
INSERT INTO chart_of_accounts (account_code, account_name, account_type, normal_balance, is_control, is_active)
VALUES
  ('5200', 'Bank Charges',         'EXPENSE', 'DEBIT',  false, true),
  ('4920', 'Bank Interest Income', 'INCOME',  'CREDIT', false, true)
ON CONFLICT (account_code) DO NOTHING;

COMMIT;
