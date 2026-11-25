-- =============================================================================
-- Migration 003 — Operating Expenses module
--
--   Adds office/operational expense tracking (from the Excel "Office Expense
--   Tracker"): categories mapped to GL accounts, payment methods, recurring
--   (fixed) expenses, and the expenses register. Posts into the GL (migration
--   002) and uses functional/base amounts (migration 001).
--
--   Depends on: chart_of_accounts (002), regions, users, vendors.
--   Review before running. Apply via a migration tool. Safe to re-run.
-- =============================================================================

BEGIN;

-- 1) Chart-of-accounts additions for office expenses -------------------------
INSERT INTO chart_of_accounts (account_code, account_name, account_type, normal_balance, is_control) VALUES
    ('1050', 'Petty Cash',                 'ASSET',     'DEBIT',  false),
    ('1400', 'Input GST Recoverable',      'ASSET',     'DEBIT',  false),
    ('1500', 'Office Equipment',           'ASSET',     'DEBIT',  false),
    ('2400', 'Credit Card Payable',        'LIABILITY', 'CREDIT', false),
    ('2500', 'Reimbursements Payable',     'LIABILITY', 'CREDIT', false),
    ('5500', 'Rent & Lease',               'EXPENSE',   'DEBIT',  false),
    ('5510', 'Utilities',                  'EXPENSE',   'DEBIT',  false),
    ('5520', 'Internet & Phone',           'EXPENSE',   'DEBIT',  false),
    ('5530', 'Office Supplies',            'EXPENSE',   'DEBIT',  false),
    ('5540', 'Printing & Postage',         'EXPENSE',   'DEBIT',  false),
    ('5550', 'Travel',                     'EXPENSE',   'DEBIT',  false),
    ('5560', 'Meals & Entertainment',      'EXPENSE',   'DEBIT',  false),
    ('5570', 'Maintenance & Repairs',      'EXPENSE',   'DEBIT',  false),
    ('5580', 'Marketing & Advertising',    'EXPENSE',   'DEBIT',  false),
    ('5590', 'Insurance',                  'EXPENSE',   'DEBIT',  false),
    ('5600', 'EMI / Finance Charges',      'EXPENSE',   'DEBIT',  false)
ON CONFLICT (account_code) DO NOTHING;

-- 2) Expense categories (master) ---------------------------------------------
CREATE TABLE IF NOT EXISTS expense_categories (
    id            serial PRIMARY KEY,
    name          varchar(100) NOT NULL UNIQUE,
    gl_account_id int REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
    is_active     boolean NOT NULL DEFAULT true,
    created_at    timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3) Payment methods (master -> GL account) ----------------------------------
CREATE TABLE IF NOT EXISTS payment_methods (
    id            serial PRIMARY KEY,
    name          varchar(100) NOT NULL UNIQUE,
    method_type   varchar(20) NOT NULL DEFAULT 'BANK',   -- BANK | CARD | CASH
    gl_account_id int REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
    entity_id     int REFERENCES regions(id) ON DELETE SET NULL,
    is_active     boolean NOT NULL DEFAULT true,
    created_at    timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT payment_methods_type_check CHECK (method_type IN ('BANK', 'CARD', 'CASH'))
);

-- 4) Recurring (fixed) expenses ----------------------------------------------
CREATE TABLE IF NOT EXISTS recurring_expenses (
    id                serial PRIMARY KEY,
    entity_id         int NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
    name              varchar(200) NOT NULL,
    category_id       int REFERENCES expense_categories(id) ON DELETE SET NULL,
    vendor_id         int REFERENCES vendors(id) ON DELETE SET NULL,
    vendor_name       varchar(200),
    payment_method_id int REFERENCES payment_methods(id) ON DELETE SET NULL,
    currency          varchar(10) NOT NULL DEFAULT 'INR',
    actual_cost       numeric(14, 2) NOT NULL DEFAULT 0,
    gst_percent       numeric(6, 2) NOT NULL DEFAULT 0,
    tds_percent       numeric(6, 2) NOT NULL DEFAULT 0,
    amount            numeric(14, 2) NOT NULL DEFAULT 0,   -- actual + gst - tds
    period_months     int NOT NULL DEFAULT 1,
    monthly_equiv     numeric(14, 2) NOT NULL DEFAULT 0,   -- amount / period
    start_month       date NOT NULL,
    end_month         date NULL,
    is_active         boolean NOT NULL DEFAULT true,
    notes             text,
    created_by        int REFERENCES users(id) ON DELETE SET NULL,
    created_at        timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_recurring_expenses_entity ON recurring_expenses(entity_id);
CREATE INDEX IF NOT EXISTS idx_recurring_expenses_active ON recurring_expenses(is_active);

-- 5) Expenses register (the core) --------------------------------------------
CREATE TABLE IF NOT EXISTS expenses (
    id                serial PRIMARY KEY,
    entity_id         int NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
    expense_date      date NOT NULL,
    category_id       int REFERENCES expense_categories(id) ON DELETE SET NULL,
    expense_type      varchar(20) NOT NULL DEFAULT 'VARIABLE',   -- FIXED | VARIABLE
    recurring_id      int REFERENCES recurring_expenses(id) ON DELETE SET NULL,
    vendor_id         int REFERENCES vendors(id) ON DELETE SET NULL,
    vendor_name       varchar(200),
    description       text,
    payment_method_id int REFERENCES payment_methods(id) ON DELETE SET NULL,
    currency          varchar(10) NOT NULL DEFAULT 'INR',
    amount            numeric(14, 2) NOT NULL DEFAULT 0,         -- pre-tax
    gst_amount        numeric(14, 2) NOT NULL DEFAULT 0,
    tds_amount        numeric(14, 2) NOT NULL DEFAULT 0,
    total_amount      numeric(14, 2) NOT NULL DEFAULT 0,         -- amount + gst
    exchange_rate     numeric(18, 8) NOT NULL DEFAULT 1,
    amount_base       numeric(14, 2),                            -- functional ccy
    is_reimbursable   boolean NOT NULL DEFAULT false,
    paid_by           varchar(150),
    status            varchar(20) NOT NULL DEFAULT 'RECORDED',   -- DRAFT|RECORDED|REIMBURSED|CANCELLED
    gl_entry_id       bigint REFERENCES journal_entries(id) ON DELETE SET NULL,
    notes             text,
    created_by        int REFERENCES users(id) ON DELETE SET NULL,
    created_at        timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT expenses_type_check CHECK (expense_type IN ('FIXED', 'VARIABLE')),
    CONSTRAINT expenses_status_check CHECK (status IN ('DRAFT', 'RECORDED', 'REIMBURSED', 'CANCELLED'))
);
CREATE INDEX IF NOT EXISTS idx_expenses_entity ON expenses(entity_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category_id);
CREATE INDEX IF NOT EXISTS idx_expenses_status ON expenses(status);

-- 5b) Allow expense-sourced journal entries in the GL ------------------------
ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS je_source_check;
ALTER TABLE journal_entries ADD CONSTRAINT je_source_check
    CHECK (source IN ('MANUAL','AR_INVOICE','AR_PAYMENT','AP_BILL','AP_PAYMENT','FX_REVAL','OPENING','EXPENSE','EXPENSE_REIMBURSE'));

-- 6) Seed the 25 categories, each mapped to a GL account ----------------------
INSERT INTO expense_categories (name, gl_account_id)
SELECT v.name, a.id
FROM (VALUES
    ('Rent / Lease', '5500'),
    ('Utilities', '5510'),
    ('Internet / Phone', '5520'),
    ('Software / Subscriptions', '5200'),
    ('Office Supplies', '5530'),
    ('Printing / Postage', '5540'),
    ('Travel', '5550'),
    ('Meals', '5560'),
    ('Maintenance / Repairs', '5570'),
    ('Professional Services', '5400'),
    ('Marketing / Advertising', '5580'),
    ('Training / Education', '6000'),
    ('Insurance', '5590'),
    ('Bank Fees', '5300'),
    ('Miscellaneous', '6000'),
    ('Entertainment', '5560'),
    ('Office EMI', '5600'),
    ('Salaries', '5100'),
    ('Incentives', '5100'),
    ('Freelancer', '5400'),
    ('Employee Benefits', '6000'),
    ('Tax', '6000'),
    ('Priest', '6000'),
    ('Client Meeting', '5560'),
    ('Assests', '1500')
) AS v(name, code)
LEFT JOIN chart_of_accounts a ON a.account_code = v.code
ON CONFLICT (name) DO NOTHING;

-- 7) Seed a few payment methods ----------------------------------------------
INSERT INTO payment_methods (name, method_type, gl_account_id)
SELECT v.name, v.t, a.id
FROM (VALUES
    ('Bank Transfer', 'BANK', '1000'),
    ('Petty Cash', 'CASH', '1050'),
    ('Company Credit Card', 'CARD', '2400')
) AS v(name, t, code)
LEFT JOIN chart_of_accounts a ON a.account_code = v.code
ON CONFLICT (name) DO NOTHING;

COMMIT;

-- =============================================================================
-- Next: expense controller + routes, GL posting (Dr category expense + input
-- GST; Cr payment account or reimbursements payable; Cr TDS payable), then the
-- Expenses register UI and the spreadsheet importer.
-- =============================================================================
