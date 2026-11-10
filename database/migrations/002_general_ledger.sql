-- =============================================================================
-- Migration 002 — Double-entry General Ledger (management-accounts core)
--
--   Layered UNDER the existing AR/AP app. Subledgers (invoices, bills, payments,
--   vendor_payments) post journal entries into these tables.
--   Shared chart of accounts; every journal line is tagged by entity (region_id).
--   Lines store transaction-currency AND entity-functional-currency amounts;
--   consolidation to USD is done at report time via exchange_rates (migration 001).
--
--   Depends on: regions, users (base schema). Pairs with migration 001.
--   Review before running. Apply via a migration tool. Safe to re-run.
-- =============================================================================

BEGIN;

-- 1) Fiscal calendar ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS fiscal_years (
    id          serial PRIMARY KEY,
    year_label  varchar(20) NOT NULL UNIQUE,         -- e.g. '2026'
    start_date  date NOT NULL,
    end_date    date NOT NULL,
    status      varchar(10) NOT NULL DEFAULT 'OPEN', -- OPEN | CLOSED
    created_at  timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fiscal_years_status_check CHECK (status IN ('OPEN', 'CLOSED'))
);

CREATE TABLE IF NOT EXISTS accounting_periods (
    id              serial PRIMARY KEY,
    fiscal_year_id  int NOT NULL REFERENCES fiscal_years(id) ON DELETE CASCADE,
    period_no       int NOT NULL,                    -- 1..12
    period_label    varchar(20) NOT NULL,            -- e.g. 'Jun 2026'
    start_date      date NOT NULL,
    end_date        date NOT NULL,
    status          varchar(10) NOT NULL DEFAULT 'OPEN', -- OPEN | CLOSED
    CONSTRAINT accounting_periods_status_check CHECK (status IN ('OPEN', 'CLOSED')),
    CONSTRAINT accounting_periods_unique UNIQUE (fiscal_year_id, period_no)
);
CREATE INDEX IF NOT EXISTS idx_periods_dates ON accounting_periods (start_date, end_date);

-- 2) Chart of accounts (shared across entities) ------------------------------
CREATE TABLE IF NOT EXISTS chart_of_accounts (
    id              serial PRIMARY KEY,
    account_code    varchar(20) NOT NULL UNIQUE,
    account_name    varchar(150) NOT NULL,
    account_type    varchar(20) NOT NULL,            -- ASSET|LIABILITY|EQUITY|INCOME|EXPENSE
    normal_balance  varchar(10) NOT NULL,            -- DEBIT|CREDIT
    parent_id       int REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
    is_control      boolean NOT NULL DEFAULT false,  -- AR/AP control accounts: system-posted only
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT coa_type_check CHECK (account_type IN ('ASSET','LIABILITY','EQUITY','INCOME','EXPENSE')),
    CONSTRAINT coa_normal_check CHECK (normal_balance IN ('DEBIT','CREDIT'))
);

-- 3) Journal entries (header) ------------------------------------------------
CREATE TABLE IF NOT EXISTS journal_entries (
    id           bigserial PRIMARY KEY,
    entry_no     varchar(40) NOT NULL,
    entity_id    int NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
    entry_date   date NOT NULL,
    period_id    int NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
    description  text,
    source       varchar(20) NOT NULL DEFAULT 'MANUAL', -- MANUAL|AR_INVOICE|AR_PAYMENT|AP_BILL|AP_PAYMENT|FX_REVAL|OPENING
    source_ref   varchar(100),                        -- e.g. invoice id / bill id
    status       varchar(10) NOT NULL DEFAULT 'DRAFT', -- DRAFT|POSTED|REVERSED
    reversed_by  bigint REFERENCES journal_entries(id) ON DELETE SET NULL,
    created_by   int REFERENCES users(id) ON DELETE SET NULL,
    created_at   timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    posted_at    timestamp NULL,
    CONSTRAINT je_status_check CHECK (status IN ('DRAFT','POSTED','REVERSED')),
    CONSTRAINT je_source_check CHECK (source IN ('MANUAL','AR_INVOICE','AR_PAYMENT','AP_BILL','AP_PAYMENT','FX_REVAL','OPENING')),
    CONSTRAINT je_entry_no_unique UNIQUE (entity_id, entry_no)
);
CREATE INDEX IF NOT EXISTS idx_je_entity   ON journal_entries (entity_id);
CREATE INDEX IF NOT EXISTS idx_je_period   ON journal_entries (period_id);
CREATE INDEX IF NOT EXISTS idx_je_date     ON journal_entries (entry_date);
CREATE INDEX IF NOT EXISTS idx_je_source   ON journal_entries (source, source_ref);

-- 4) Journal lines (detail) --------------------------------------------------
CREATE TABLE IF NOT EXISTS journal_lines (
    id            bigserial PRIMARY KEY,
    entry_id      bigint NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    account_id    int NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
    entity_id     int NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
    currency      varchar(10) NOT NULL,                 -- transaction currency of this line
    debit         numeric(16, 2) NOT NULL DEFAULT 0,    -- in transaction currency
    credit        numeric(16, 2) NOT NULL DEFAULT 0,    -- in transaction currency
    exchange_rate numeric(18, 8) NOT NULL DEFAULT 1,    -- txn -> entity functional
    debit_base    numeric(16, 2) NOT NULL DEFAULT 0,    -- in entity functional currency
    credit_base   numeric(16, 2) NOT NULL DEFAULT 0,    -- in entity functional currency
    memo          text,
    placement_id  int NULL,                             -- optional analysis dimensions
    client_id     int NULL,
    vendor_id     int NULL,
    created_at    timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT jl_one_side_txn  CHECK (debit = 0 OR credit = 0),
    CONSTRAINT jl_one_side_base CHECK (debit_base = 0 OR credit_base = 0),
    CONSTRAINT jl_non_negative  CHECK (debit >= 0 AND credit >= 0 AND debit_base >= 0 AND credit_base >= 0)
);
CREATE INDEX IF NOT EXISTS idx_jl_entry   ON journal_lines (entry_id);
CREATE INDEX IF NOT EXISTS idx_jl_account ON journal_lines (account_id);
CREATE INDEX IF NOT EXISTS idx_jl_entity  ON journal_lines (entity_id);

-- 5) Balance enforcement: a POSTED entry must have Σdebit_base = Σcredit_base -
CREATE OR REPLACE FUNCTION gl_assert_entry_balanced() RETURNS trigger AS $$
DECLARE
    v_entry_id bigint;
    v_status   text;
    v_diff     numeric;
BEGIN
    IF TG_TABLE_NAME = 'journal_entries' THEN
        v_entry_id := NEW.id;
        v_status   := NEW.status;
    ELSE
        v_entry_id := COALESCE(NEW.entry_id, OLD.entry_id);
        SELECT status INTO v_status FROM journal_entries WHERE id = v_entry_id;
    END IF;

    IF v_status = 'POSTED' THEN
        SELECT COALESCE(SUM(debit_base), 0) - COALESCE(SUM(credit_base), 0)
          INTO v_diff FROM journal_lines WHERE entry_id = v_entry_id;
        IF ABS(COALESCE(v_diff, 0)) > 0.005 THEN
            RAISE EXCEPTION 'Journal entry % is unbalanced by % (functional currency)', v_entry_id, v_diff;
        END IF;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_jl_balanced ON journal_lines;
CREATE CONSTRAINT TRIGGER trg_jl_balanced
    AFTER INSERT OR UPDATE OR DELETE ON journal_lines
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION gl_assert_entry_balanced();

DROP TRIGGER IF EXISTS trg_je_balanced ON journal_entries;
CREATE CONSTRAINT TRIGGER trg_je_balanced
    AFTER INSERT OR UPDATE ON journal_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION gl_assert_entry_balanced();

-- 6) Seed the shared chart of accounts --------------------------------------
INSERT INTO chart_of_accounts (account_code, account_name, account_type, normal_balance, is_control) VALUES
    -- Assets
    ('1000', 'Bank — Operating',                'ASSET',     'DEBIT',  false),
    ('1010', 'Bank — Payroll',                  'ASSET',     'DEBIT',  false),
    ('1100', 'Accounts Receivable',             'ASSET',     'DEBIT',  true),
    ('1200', 'Withholding / TDS Receivable',    'ASSET',     'DEBIT',  false),
    ('1300', 'Prepaid Expenses',                'ASSET',     'DEBIT',  false),
    -- Liabilities
    ('2000', 'Accounts Payable',                'LIABILITY', 'CREDIT', true),
    ('2100', 'Sales Tax / VAT / GST Payable',   'LIABILITY', 'CREDIT', false),
    ('2200', 'Withholding / TDS Payable',       'LIABILITY', 'CREDIT', false),
    ('2300', 'Accrued Liabilities',             'LIABILITY', 'CREDIT', false),
    -- Equity
    ('3000', 'Owner''s Capital',                'EQUITY',    'CREDIT', false),
    ('3100', 'Retained Earnings',               'EQUITY',    'CREDIT', false),
    ('3200', 'Cumulative Translation Adjustment','EQUITY',   'CREDIT', false),
    -- Income
    ('4000', 'Staffing Revenue',                'INCOME',    'CREDIT', false),
    ('4100', 'Other Income',                    'INCOME',    'CREDIT', false),
    ('4900', 'Realized FX Gain',                'INCOME',    'CREDIT', false),
    -- Expenses
    ('5000', 'Contractor / Vendor Cost',        'EXPENSE',   'DEBIT',  false),
    ('5100', 'Salaries & Wages',                'EXPENSE',   'DEBIT',  false),
    ('5200', 'Software & Subscriptions',        'EXPENSE',   'DEBIT',  false),
    ('5300', 'Bank Charges',                    'EXPENSE',   'DEBIT',  false),
    ('5400', 'Professional Fees',               'EXPENSE',   'DEBIT',  false),
    ('5900', 'Realized FX Loss',                'EXPENSE',   'DEBIT',  false),
    ('6000', 'General & Administrative',        'EXPENSE',   'DEBIT',  false)
ON CONFLICT (account_code) DO NOTHING;

-- 7) Seed current fiscal year + 12 monthly periods (all OPEN) ----------------
WITH fy AS (
    INSERT INTO fiscal_years (year_label, start_date, end_date, status)
    VALUES (
        EXTRACT(YEAR FROM CURRENT_DATE)::text,
        make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int, 1, 1),
        make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int, 12, 31),
        'OPEN'
    )
    ON CONFLICT (year_label) DO UPDATE SET year_label = EXCLUDED.year_label
    RETURNING id
)
INSERT INTO accounting_periods (fiscal_year_id, period_no, period_label, start_date, end_date, status)
SELECT
    fy.id, m,
    to_char(make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int, m, 1), 'Mon YYYY'),
    make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int, m, 1),
    (make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int, m, 1) + INTERVAL '1 month - 1 day')::date,
    'OPEN'
FROM fy, generate_series(1, 12) AS m
ON CONFLICT (fiscal_year_id, period_no) DO NOTHING;

COMMIT;

-- =============================================================================
-- Next: wire backend/services/gl/postingService.js into invoice/bill/payment
-- creation, enter opening balances per entity, then build the reports in
-- backend/services/gl/glReports.js (trial balance -> P&L -> balance sheet).
-- =============================================================================
