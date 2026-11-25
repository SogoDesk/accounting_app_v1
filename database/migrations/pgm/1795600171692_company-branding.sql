-- Up Migration

-- Company-level branding (workflow step 0.6). Every customer-facing name, logo
-- and colour comes from data: a region's own values win, then these, then the
-- tenant's name and neutral defaults (services/branding/brandingService.js).
-- All optional, so existing companies keep working unchanged.
ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS display_name      text,
  ADD COLUMN IF NOT EXISTS logo_url          text,
  ADD COLUMN IF NOT EXISTS primary_color     varchar(7),
  ADD COLUMN IF NOT EXISTS accent_color      varchar(7),
  ADD COLUMN IF NOT EXISTS email_sender_name text;

ALTER TABLE company_settings
  ADD CONSTRAINT company_settings_primary_color_hex
    CHECK (primary_color IS NULL OR primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  ADD CONSTRAINT company_settings_accent_color_hex
    CHECK (accent_color IS NULL OR accent_color ~ '^#[0-9A-Fa-f]{6}$');

-- Region colours defaulted to #111827 / #1D4ED8, so every region "had" colours
-- and company-level colours could never apply. A region now has colours only
-- when someone set them; the old defaults become the neutral fallback in
-- brandingService, so existing invoices look exactly as before.
ALTER TABLE regions
  ALTER COLUMN invoice_brand_primary_color DROP DEFAULT,
  ALTER COLUMN invoice_brand_accent_color DROP DEFAULT;

-- regions has forced row-level security: clear the old defaults tenant by tenant.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    UPDATE regions SET invoice_brand_primary_color = NULL
     WHERE upper(invoice_brand_primary_color) = '#111827';
    UPDATE regions SET invoice_brand_accent_color = NULL
     WHERE upper(invoice_brand_accent_color) = '#1D4ED8';
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- Down Migration

-- Restores the column defaults; colours cleared above stay NULL (they render
-- the same through the fallback).
ALTER TABLE regions
  ALTER COLUMN invoice_brand_primary_color SET DEFAULT '#111827',
  ALTER COLUMN invoice_brand_accent_color SET DEFAULT '#1D4ED8';

ALTER TABLE company_settings
  DROP CONSTRAINT IF EXISTS company_settings_accent_color_hex,
  DROP CONSTRAINT IF EXISTS company_settings_primary_color_hex,
  DROP COLUMN IF EXISTS email_sender_name,
  DROP COLUMN IF EXISTS accent_color,
  DROP COLUMN IF EXISTS primary_color,
  DROP COLUMN IF EXISTS logo_url,
  DROP COLUMN IF EXISTS display_name;
