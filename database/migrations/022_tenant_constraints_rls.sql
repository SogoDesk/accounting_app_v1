-- =============================================================================
-- Migration 022 — Enforce tenancy: NOT NULL, per-tenant keys, row-level security
--
--   1) tenant_id NOT NULL on every tenant-owned table.
--   2) Single-company UNIQUE rules become (tenant_id, ...), e.g. two companies
--      may both have invoice INV-000001. users.email stays GLOBALLY unique.
--   3) Singleton / keyed settings tables become one row (or key) per tenant.
--   4) ROW LEVEL SECURITY, FORCED (applies to the table owner too), with
--      tenant_isolation_policy: rows visible/writable only when
--      tenant_id = current_setting('app.tenant_id'). The backend sets that per
--      request (middleware/tenantMiddleware.js) and per job.
--
--   Matches the team dev DB (accounting_dev_db). Idempotent: on a DB that is
--   already in this shape every step is a no-op. Depends on: 019-021.
--   Run as the table owner, BEFORE any non-tenant-1 data exists.
-- =============================================================================

BEGIN;

-- Helper: replace UNIQUE(cols) with UNIQUE(tenant_id, cols) named new_name.
-- Drops any unique constraint or unique index whose columns are exactly cols.
CREATE OR REPLACE FUNCTION pg_temp.scope_unique(tbl text, cols text[], new_name text)
RETURNS void AS $$
DECLARE r record;
BEGIN
  IF to_regclass('public.' || tbl) IS NULL THEN RETURN; END IF;

  FOR r IN
    SELECT i.indexrelid::regclass::text AS idx, k.conname
      FROM pg_index i
      LEFT JOIN pg_constraint k ON k.conindid = i.indexrelid AND k.contype IN ('u','p')
     WHERE i.indrelid = ('public.' || tbl)::regclass
       AND i.indisunique AND NOT i.indisprimary
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
              FROM unnest(i.indkey) WITH ORDINALITY AS u(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = u.attnum)
           = (SELECT array_agg(x ORDER BY x) FROM unnest(cols) x)
  LOOP
    IF r.conname IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', tbl, r.conname);
    ELSE
      EXECUTE format('DROP INDEX public.%s', r.idx);
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = ('public.' || tbl)::regclass AND conname = new_name) THEN
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I UNIQUE (tenant_id, %s)',
                   tbl, new_name,
                   (SELECT string_agg(quote_ident(x), ', ') FROM unnest(cols) x));
  END IF;
END $$ LANGUAGE plpgsql;

-- Helper: make the primary key (tenant_id, cols).
CREATE OR REPLACE FUNCTION pg_temp.scope_pkey(tbl text, cols text[])
RETURNS void AS $$
DECLARE
  pk text;
  want text := 'PRIMARY KEY (' ||
               array_to_string(ARRAY['tenant_id'] || cols, ', ') || ')';
BEGIN
  IF to_regclass('public.' || tbl) IS NULL THEN RETURN; END IF;
  SELECT conname INTO pk FROM pg_constraint
   WHERE conrelid = ('public.' || tbl)::regclass AND contype = 'p'
     AND pg_get_constraintdef(oid) <> want;
  IF pk IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', tbl, pk);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = ('public.' || tbl)::regclass AND contype = 'p') THEN
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I %s', tbl, tbl || '_pkey', want);
  END IF;
END $$ LANGUAGE plpgsql;

-- 1) NOT NULL ----------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables tb USING (table_schema, table_name)
     WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
       AND tb.table_type = 'BASE TABLE' AND c.is_nullable = 'YES'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN tenant_id SET NOT NULL', t);
  END LOOP;
END $$;

-- 2) Per-tenant UNIQUE rules -------------------------------------------------
SELECT pg_temp.scope_unique('accounting_periods',     ARRAY['fiscal_year_id','period_no'],          'accounting_periods_tenant_unique');
SELECT pg_temp.scope_unique('bank_transactions',      ARRAY['bank_account_id','dedupe_hash'],       'bank_transactions_tenant_dedupe_unique');
SELECT pg_temp.scope_unique('bills',                  ARRAY['bill_number'],                         'bills_tenant_bill_number_unique');
SELECT pg_temp.scope_unique('candidates',             ARRAY['candidate_code'],                      'candidates_tenant_candidate_code_unique');
SELECT pg_temp.scope_unique('chart_of_accounts',      ARRAY['account_code'],                        'chart_of_accounts_tenant_account_code_unique');
SELECT pg_temp.scope_unique('clients',                ARRAY['client_code'],                         'clients_tenant_client_code_unique');
SELECT pg_temp.scope_unique('custom_field_defs',      ARRAY['applies_to','key'],                    'custom_field_defs_tenant_applies_key_unique');
SELECT pg_temp.scope_unique('expense_categories',     ARRAY['name'],                                'expense_categories_tenant_name_unique');
SELECT pg_temp.scope_unique('fiscal_years',           ARRAY['year_label'],                          'fiscal_years_tenant_year_label_unique');
SELECT pg_temp.scope_unique('fx_revaluations',        ARRAY['entity_id','as_of_date','account_id','currency'], 'fx_revaluations_tenant_unique');
SELECT pg_temp.scope_unique('intercompany_transfers', ARRAY['transfer_no'],                         'intercompany_transfers_tenant_transfer_no_unique');
SELECT pg_temp.scope_unique('invoices',               ARRAY['invoice_number'],                      'invoices_tenant_invoice_number_unique');
SELECT pg_temp.scope_unique('journal_entries',        ARRAY['entity_id','entry_no'],                'je_entry_tenant_unique');
SELECT pg_temp.scope_unique('org_units',              ARRAY['code'],                                'org_units_tenant_code_unique');
SELECT pg_temp.scope_unique('payment_methods',        ARRAY['name'],                                'payment_methods_tenant_name_unique');
SELECT pg_temp.scope_unique('payments',               ARRAY['payment_code'],                        'payments_tenant_payment_code_unique');
SELECT pg_temp.scope_unique('placements',             ARRAY['placement_code'],                      'placements_tenant_placement_code_unique');
SELECT pg_temp.scope_unique('recognition_runs',       ARRAY['schedule_id','period_no'],             'recognition_runs_tenant_schedule_period_unique');
SELECT pg_temp.scope_unique('regions',                ARRAY['region_code'],                         'regions_tenant_region_code_unique');
SELECT pg_temp.scope_unique('regions',                ARRAY['region_name'],                         'regions_tenant_region_name_unique');
SELECT pg_temp.scope_unique('roles',                  ARRAY['role_name'],                           'roles_tenant_role_name_unique');
SELECT pg_temp.scope_unique('vendor_payments',        ARRAY['payment_code'],                        'vendor_payments_tenant_payment_code_unique');
SELECT pg_temp.scope_unique('vendors',                ARRAY['vendor_code'],                         'vendors_tenant_vendor_code_unique');

-- 3) Settings / email tables: one row or key per tenant -----------------------
ALTER TABLE company_settings DROP CONSTRAINT IF EXISTS company_settings_singleton;
SELECT pg_temp.scope_pkey('company_settings',          ARRAY[]::text[]);
SELECT pg_temp.scope_pkey('document_numbering_config', ARRAY['doc_type']);
SELECT pg_temp.scope_pkey('email_templates',           ARRAY['template_key']);

ALTER TABLE invoice_reminder_settings DROP CONSTRAINT IF EXISTS invoice_reminder_settings_id_check;
SELECT pg_temp.scope_pkey('invoice_reminder_settings', ARRAY[]::text[]);
ALTER TABLE invoice_reminder_settings DROP COLUMN IF EXISTS id;

-- reminder log: once per (tenant, invoice, reminder, channel)
ALTER TABLE invoice_reminder_logs
  DROP CONSTRAINT IF EXISTS invoice_reminder_logs_invoice_id_reminder_key_sent_on_chann_key;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_reminder_logs_once'
                AND indexdef NOT LIKE '%(tenant_id, %') THEN
    DROP INDEX idx_reminder_logs_once;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_email_outbox_dedupe'
                AND indexdef NOT LIKE '%(tenant_id, %') THEN
    DROP INDEX idx_email_outbox_dedupe;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_email_outbox_pending'
                AND indexdef NOT LIKE '%(tenant_id, %') THEN
    DROP INDEX idx_email_outbox_pending;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_email_outbox_invoice'
                AND indexdef NOT LIKE '%(tenant_id, %') THEN
    DROP INDEX idx_email_outbox_invoice;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_reminder_logs_once
    ON invoice_reminder_logs (tenant_id, invoice_id, reminder_key, channel);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_outbox_dedupe
    ON email_outbox (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_outbox_pending
    ON email_outbox (tenant_id, status, id) WHERE status IN ('QUEUED','SENDING');
CREATE INDEX IF NOT EXISTS idx_email_outbox_invoice
    ON email_outbox (tenant_id, invoice_id);

-- 4) Row-level security on every tenant-owned table ---------------------------
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables tb USING (table_schema, table_name)
     WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
       AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public' AND tablename = t
                      AND policyname = 'tenant_isolation_policy') THEN
      EXECUTE format($p$
        CREATE POLICY tenant_isolation_policy ON public.%I
          USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::integer)
          WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::integer)
      $p$, t);
    END IF;
  END LOOP;
END $$;

COMMIT;
