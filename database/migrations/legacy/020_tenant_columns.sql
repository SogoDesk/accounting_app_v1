-- =============================================================================
-- Migration 020 — Add tenant_id to every tenant-owned table
--
--   Adds a NULLABLE tenant_id integer (FK -> tenants) plus an index. Schema
--   only: 021 fills the rows, 022 makes the column NOT NULL. Keeping DDL and
--   UPDATEs in separate migrations avoids the "pending trigger events" error
--   on journal_lines (see the note in 004_org_hierarchy.sql).
--
--   Not tenant-owned: tenants, exchange_rates (shared FX rates).
--   The email tables get composite tenant indexes in 022 instead of a plain
--   one. Missing tables are skipped. Idempotent. Depends on: 019.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    -- identity / organization / settings
    'users', 'regions', 'org_units', 'user_org_access', 'roles', 'role_permissions',
    'company_settings', 'custom_field_defs', 'document_numbering_config',
    'tax_rates', 'fiscal_years', 'accounting_periods',
    -- accounts
    'chart_of_accounts', 'bank_accounts', 'payment_methods', 'expense_categories',
    -- customers / vendors / workforce
    'clients', 'vendors', 'candidates', 'placements', 'timesheets',
    -- receivables
    'invoices', 'invoice_items', 'invoice_payments', 'payments',
    'invoice_reminder_settings', 'invoice_reminder_logs',
    'email_templates', 'email_outbox',
    -- payables
    'bills', 'bill_items', 'bill_approvals', 'vendor_payments',
    -- expenses
    'expenses', 'recurring_expenses',
    -- general ledger
    'journal_entries', 'journal_lines', 'fx_revaluations',
    'recognition_schedules', 'recognition_runs', 'intercompany_transfers',
    -- banking
    'bank_statement_imports', 'bank_transactions', 'bank_reconciliations',
    -- cross-cutting
    'attachments', 'audit_logs', 'notifications'
  ];
  composite_indexed text[] := ARRAY[
    'email_templates', 'email_outbox', 'invoice_reminder_settings', 'invoice_reminder_logs'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'Skipping %: table does not exist', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS tenant_id integer', t);

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = ('public.' || t)::regclass AND contype = 'f'
         AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (tenant_id) REFERENCES tenants(id)%'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I
                        FOREIGN KEY (tenant_id) REFERENCES tenants(id)',
                     t, t || '_tenant_id_fkey');
    END IF;

    IF NOT (t = ANY (composite_indexed)) THEN
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (tenant_id)',
                     'idx_' || t || '_tenant_id', t);
    END IF;
  END LOOP;
END $$;

COMMIT;
