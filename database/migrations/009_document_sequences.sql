-- =============================================================================
-- Migration 009 — Race-free document numbering
--
--   Replaces the old SELECT-WHERE-+1 scan (TOCTOU race + O(n^2) growth) in
--   utils/codeGenerator.js with on-demand per-(scope,year) Postgres sequences
--   (doc_seq_<scope>_<year>), assigned via nextval — atomic under concurrency.
--
--   This migration SEEDS each sequence from the current MAX number already in
--   the data so numbering continues unbroken (e.g. existing INV-2026-000142 ->
--   next nextval = 143). nextDocNumber() also CREATE SEQUENCE IF NOT EXISTS, so
--   brand-new (scope,year) combinations start cleanly at 1 with no seeding.
--
--   Idempotent: re-running re-sets each sequence to the current committed max.
--   Guarded by to_regclass so it is safe if a table is absent. Depends on the
--   base tables (invoices, bills, payments, vendor_payments).
-- =============================================================================

BEGIN;

DO $$
DECLARE r record;
BEGIN
  -- invoices: INV-YYYY-NNNNNN
  IF to_regclass('public.invoices') IS NOT NULL THEN
    FOR r IN
      SELECT (substring(invoice_number from '^INV-([0-9]{4})-'))::int AS yr,
             MAX((substring(invoice_number from '^INV-[0-9]{4}-([0-9]+)$'))::bigint) AS mx
      FROM invoices WHERE invoice_number ~ '^INV-[0-9]{4}-[0-9]+$'
      GROUP BY 1
    LOOP
      EXECUTE format('CREATE SEQUENCE IF NOT EXISTS doc_seq_invoice_%s', r.yr);
      EXECUTE format('SELECT setval(%L, %s, true)', 'doc_seq_invoice_' || r.yr, r.mx);
    END LOOP;
  END IF;

  -- bills: BILL-YYYY-NNNNNN
  IF to_regclass('public.bills') IS NOT NULL THEN
    FOR r IN
      SELECT (substring(bill_number from '^BILL-([0-9]{4})-'))::int AS yr,
             MAX((substring(bill_number from '^BILL-[0-9]{4}-([0-9]+)$'))::bigint) AS mx
      FROM bills WHERE bill_number ~ '^BILL-[0-9]{4}-[0-9]+$'
      GROUP BY 1
    LOOP
      EXECUTE format('CREATE SEQUENCE IF NOT EXISTS doc_seq_bill_%s', r.yr);
      EXECUTE format('SELECT setval(%L, %s, true)', 'doc_seq_bill_' || r.yr, r.mx);
    END LOOP;
  END IF;

  -- payments: payment_code PAY-YYYY-NNNNNN and reference_number REF-YYYY-NNNNNN
  IF to_regclass('public.payments') IS NOT NULL THEN
    FOR r IN
      SELECT (substring(payment_code from '^PAY-([0-9]{4})-'))::int AS yr,
             MAX((substring(payment_code from '^PAY-[0-9]{4}-([0-9]+)$'))::bigint) AS mx
      FROM payments WHERE payment_code ~ '^PAY-[0-9]{4}-[0-9]+$'
      GROUP BY 1
    LOOP
      EXECUTE format('CREATE SEQUENCE IF NOT EXISTS doc_seq_payment_%s', r.yr);
      EXECUTE format('SELECT setval(%L, %s, true)', 'doc_seq_payment_' || r.yr, r.mx);
    END LOOP;

    FOR r IN
      SELECT (substring(reference_number from '^REF-([0-9]{4})-'))::int AS yr,
             MAX((substring(reference_number from '^REF-[0-9]{4}-([0-9]+)$'))::bigint) AS mx
      FROM payments WHERE reference_number ~ '^REF-[0-9]{4}-[0-9]+$'
      GROUP BY 1
    LOOP
      EXECUTE format('CREATE SEQUENCE IF NOT EXISTS doc_seq_payref_%s', r.yr);
      EXECUTE format('SELECT setval(%L, %s, true)', 'doc_seq_payref_' || r.yr, r.mx);
    END LOOP;
  END IF;

  -- vendor_payments: payment_code VPAY-YYYY-NNNNNN
  IF to_regclass('public.vendor_payments') IS NOT NULL THEN
    FOR r IN
      SELECT (substring(payment_code from '^VPAY-([0-9]{4})-'))::int AS yr,
             MAX((substring(payment_code from '^VPAY-[0-9]{4}-([0-9]+)$'))::bigint) AS mx
      FROM vendor_payments WHERE payment_code ~ '^VPAY-[0-9]{4}-[0-9]+$'
      GROUP BY 1
    LOOP
      EXECUTE format('CREATE SEQUENCE IF NOT EXISTS doc_seq_vpay_%s', r.yr);
      EXECUTE format('SELECT setval(%L, %s, true)', 'doc_seq_vpay_' || r.yr, r.mx);
    END LOOP;
  END IF;
END $$;

COMMIT;
