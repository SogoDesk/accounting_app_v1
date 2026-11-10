-- =============================================================================
-- Migration 001 — Multi-entity currency engine
-- Group reporting currency: USD
-- Entities: each row in `regions` is a legal entity with a functional currency
-- Review before running. Apply via a migration tool, NOT by hand on production.
-- Safe to re-run: uses IF NOT EXISTS guards.
-- =============================================================================

BEGIN;

-- 1) Company-wide settings (single row) -------------------------------------
CREATE TABLE IF NOT EXISTS company_settings (
    id              smallint PRIMARY KEY DEFAULT 1,
    group_currency  varchar(10) NOT NULL DEFAULT 'USD',
    created_at      timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT company_settings_singleton CHECK (id = 1)
);

INSERT INTO company_settings (id, group_currency)
VALUES (1, 'USD')
ON CONFLICT (id) DO NOTHING;

-- 2) Dated exchange rates ----------------------------------------------------
--    One row per (from, to, date, source). MANUAL overrides API for the same key.
CREATE TABLE IF NOT EXISTS exchange_rates (
    id             bigserial PRIMARY KEY,
    from_currency  varchar(10) NOT NULL,
    to_currency    varchar(10) NOT NULL,
    rate           numeric(18, 8) NOT NULL,
    rate_date      date NOT NULL,
    source         varchar(10) NOT NULL DEFAULT 'API',   -- 'API' | 'MANUAL'
    created_at     timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT exchange_rates_source_check CHECK (source IN ('API', 'MANUAL')),
    CONSTRAINT exchange_rates_rate_positive CHECK (rate > 0),
    CONSTRAINT exchange_rates_unique UNIQUE (from_currency, to_currency, rate_date, source)
);
CREATE INDEX IF NOT EXISTS idx_exchange_rates_lookup
    ON exchange_rates (from_currency, to_currency, rate_date DESC);

-- Identity rates so same-currency lookups always resolve to exactly 1.
INSERT INTO exchange_rates (from_currency, to_currency, rate, rate_date, source)
SELECT c, c, 1, CURRENT_DATE, 'MANUAL'
FROM (VALUES ('USD'), ('GBP'), ('INR')) AS v(c)
ON CONFLICT (from_currency, to_currency, rate_date, source) DO NOTHING;

-- 3) Entities: functional (book) currency per region ------------------------
--    `default_currency` stays as "suggested currency for new clients in this region".
--    `functional_currency` is the entity's book currency (usually identical).
ALTER TABLE regions
    ADD COLUMN IF NOT EXISTS functional_currency varchar(10);

UPDATE regions
    SET functional_currency = default_currency
    WHERE functional_currency IS NULL;

-- 4) AR invoices: freeze rate + functional-currency total --------------------
ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS exchange_rate numeric(18, 8) NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS amount_base   numeric(14, 2);   -- total in entity functional ccy

-- 5) AR payments: already have exchange_rate + amount_in_base_currency -------
ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS fx_gain_loss numeric(14, 2) NOT NULL DEFAULT 0;

-- 6) AP bills: currently NO fx columns — add them ---------------------------
ALTER TABLE bills
    ADD COLUMN IF NOT EXISTS exchange_rate numeric(18, 8) NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS amount_base   numeric(14, 2);

-- 7) AP vendor payments: add fx columns + realized gain/loss -----------------
ALTER TABLE vendor_payments
    ADD COLUMN IF NOT EXISTS exchange_rate numeric(18, 8) NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS amount_base   numeric(14, 2),
    ADD COLUMN IF NOT EXISTS fx_gain_loss  numeric(14, 2) NOT NULL DEFAULT 0;

-- 8) Historical backfill -----------------------------------------------------
--    For same-currency documents the rate is exactly 1, so amount_base = total.
--    Mixed-currency historical rows should be backfilled by a script that looks
--    up the rate as of each document's own date (see notes below). The simple
--    fills here assume transaction currency == entity functional currency.
UPDATE invoices i
    SET amount_base = i.total_amount
    FROM regions r
    WHERE i.region_id = r.id
      AND i.amount_base IS NULL
      AND i.currency = r.functional_currency;

UPDATE bills b
    SET amount_base = b.total_amount
    FROM regions r
    WHERE b.region_id = r.id
      AND b.amount_base IS NULL
      AND b.currency = r.functional_currency;

COMMIT;

-- =============================================================================
-- NOT auto-filled by this migration (do via a dedicated backfill script):
--   * invoices/bills where currency <> entity functional currency
--     -> look up exchange_rates for the document's own date, then
--        amount_base = round(total_amount * rate, 2), exchange_rate = rate
--   * vendor_payments.amount_base and any fx_gain_loss on already-settled docs
-- Rationale: cross-currency history needs the correct dated rate per row,
-- which is logic, not a single UPDATE. Keep frozen rates immutable afterward.
-- =============================================================================
