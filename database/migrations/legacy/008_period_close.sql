-- =============================================================================
-- Migration 008 — Period close: FX revaluation + accrual/deferral recognition
--                  (Blueprint Step 5 / audit §3.3 + §3.5)
--
--   fx_revaluations    — period-end unrealized FX gain/loss on open foreign-
--                        currency monetary balances (auto-reversed next day).
--   recognition_schedules / recognition_runs — straight-line recognition of
--                        prepaid expense / deferred revenue into P&L over time.
--
--   entity_id is the legal book = regions.id (the app keeps entity_id ==
--   region_id; see migration 004). location_id references the org tree.
--
--   COA: 4910 Unrealized FX Gain (INCOME), 5910 Unrealized FX Loss (EXPENSE),
--        2700 Deferred Revenue (LIABILITY). Prepaid uses existing 1300.
--
--   Idempotent. No ledger UPDATEs. Depends on: regions (001), org_units (004),
--   chart_of_accounts (002), journal_entries (002).
-- =============================================================================

BEGIN;

-- 1) FX revaluation register (audit §3.3) -----------------------------------
CREATE TABLE IF NOT EXISTS fx_revaluations (
    id            bigserial PRIMARY KEY,
    entity_id     int  NOT NULL REFERENCES regions(id),
    as_of_date    date NOT NULL,
    account_id    int  NOT NULL REFERENCES chart_of_accounts(id),
    currency      varchar(10) NOT NULL,
    book_base     numeric(20,4) NOT NULL,   -- current functional-ccy carrying value
    revalued_base numeric(20,4) NOT NULL,   -- balance x period-end rate
    gain_loss     numeric(20,4) NOT NULL,   -- revalued - book
    entry_id      bigint REFERENCES journal_entries(id),
    reversal_entry_id bigint REFERENCES journal_entries(id),
    reversed      boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (entity_id, as_of_date, account_id, currency)
);
CREATE INDEX IF NOT EXISTS idx_fxr_entity ON fx_revaluations (entity_id, as_of_date);

INSERT INTO chart_of_accounts (account_code, account_name, account_type, normal_balance, is_control, is_active)
VALUES
  ('4910', 'Unrealized FX Gain', 'INCOME',  'CREDIT', false, true),
  ('5910', 'Unrealized FX Loss', 'EXPENSE', 'DEBIT',  false, true)
ON CONFLICT (account_code) DO NOTHING;

-- 2) Accrual / deferral recognition engine (audit §3.5) ---------------------
CREATE TABLE IF NOT EXISTS recognition_schedules (
    id            bigserial PRIMARY KEY,
    entity_id     int  NOT NULL REFERENCES regions(id),
    location_id   bigint REFERENCES org_units(id),
    kind          text NOT NULL CHECK (kind IN ('PREPAID_EXPENSE','DEFERRED_REVENUE')),
    source_ref    text,
    total_amount  numeric(20,4) NOT NULL,
    currency      varchar(10) NOT NULL,
    balance_account_id int NOT NULL REFERENCES chart_of_accounts(id), -- prepaid asset / deferred liab
    pnl_account_id     int NOT NULL REFERENCES chart_of_accounts(id), -- expense / revenue
    start_date    date NOT NULL,
    periods       int  NOT NULL CHECK (periods > 0),
    method        text NOT NULL DEFAULT 'STRAIGHT_LINE',
    status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','COMPLETED','CANCELLED')),
    created_by    int REFERENCES users(id),
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recsched_entity ON recognition_schedules (entity_id, status);

CREATE TABLE IF NOT EXISTS recognition_runs (
    id          bigserial PRIMARY KEY,
    schedule_id bigint NOT NULL REFERENCES recognition_schedules(id) ON DELETE CASCADE,
    period_no   int NOT NULL,
    run_date    date NOT NULL,
    amount      numeric(20,4) NOT NULL,
    entry_id    bigint REFERENCES journal_entries(id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (schedule_id, period_no)
);

INSERT INTO chart_of_accounts (account_code, account_name, account_type, normal_balance, is_control, is_active)
VALUES
  ('2700', 'Deferred Revenue', 'LIABILITY', 'CREDIT', false, true)
ON CONFLICT (account_code) DO NOTHING;

-- 3) Allow the RECOGNITION posting source (FX_REVAL already permitted) -------
--    (DDL only; no ledger UPDATEs in this migration.)
ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS je_source_check;
ALTER TABLE journal_entries ADD CONSTRAINT je_source_check CHECK (source IN (
  'MANUAL','AR_INVOICE','AR_PAYMENT','AP_BILL','AP_PAYMENT','FX_REVAL',
  'OPENING','EXPENSE','EXPENSE_REIMBURSE','INTERCOMPANY','RECOGNITION'));

COMMIT;

-- =============================================================================
-- Services: fxRevaluationService.revalue() and recognitionService.runDue() post
-- through ledgerEngine.postEntry and are wired into the monthly-close scheduler
-- (services/gl/closeScheduler.js) + manual "run now" endpoints under /api/gl.
-- =============================================================================
