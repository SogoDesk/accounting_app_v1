-- 015_region_tds.sql
-- TDS (Tax Deducted at Source) is an Indian withholding regime with no US/UK
-- equivalent, but the payment dialog asked "TDS paid?" for every region. Make it
-- a per-region setting so only the entities it applies to are asked.
-- Safe to re-run.

-- Guarded so the India backfill runs only when the column is first created:
-- a bare UPDATE would re-tick regions an admin had deliberately switched off
-- every time the migration was replayed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'regions'
      AND column_name = 'tds_applicable'
  ) THEN
    ALTER TABLE regions
      ADD COLUMN tds_applicable boolean NOT NULL DEFAULT false;

    -- Indian entities were already being asked for TDS on every payment, so
    -- carry that forward instead of silently switching them off.
    UPDATE regions
       SET tds_applicable = true
     WHERE upper(coalesce(country_code, '')) = 'IN'
        OR upper(coalesce(default_currency, '')) = 'INR';
  END IF;
END $$;
