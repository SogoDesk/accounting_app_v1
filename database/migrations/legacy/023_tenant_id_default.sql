-- =============================================================================
-- Migration 023 — tenant_id defaults to the connection's tenant
--
--   Every tenant-owned table gets
--     tenant_id DEFAULT NULLIF(current_setting('app.tenant_id', true), '')::integer
--   so an INSERT that does not list tenant_id is stamped with the tenant the
--   backend set on the connection (tenantMiddleware / per-tenant jobs).
--
--   Safe with 022's row-level security:
--     * no tenant set          -> default is NULL -> NOT NULL rejects the insert
--     * explicit other tenant  -> WITH CHECK rejects the insert
--   so a row can never be written for a tenant other than the caller's.
--
--   Idempotent. Depends on: 022.
-- =============================================================================

BEGIN;

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

COMMIT;
