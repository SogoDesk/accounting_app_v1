-- Up Migration
-- =============================================================================
-- tenant_id defaults to the tenant set on the connection.
--
-- Legacy migration 023_tenant_id_default.sql was never applied to the team dev
-- database, so the baseline (dumped from it) has no default on tenant_id. Any
-- INSERT that does not list tenant_id then fails with a NOT NULL violation
-- (for example POST /api/regions). This applies 023's change as a proper
-- migration. Idempotent: on a database that already has the default it only
-- sets the same expression again.
--
--   no tenant set            -> default is NULL -> NOT NULL rejects the insert
--   explicit other tenant    -> the RLS WITH CHECK rejects the insert
-- =============================================================================

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
    EXECUTE format(
      $f$ALTER TABLE public.%I ALTER COLUMN tenant_id
           SET DEFAULT NULLIF(current_setting('app.tenant_id', true), '')::integer$f$, t);
  END LOOP;
END $$;

-- Down Migration
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
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN tenant_id DROP DEFAULT', t);
  END LOOP;
END $$;
