-- 012_candidate_compliance.sql
-- Add contractor compliance fields to candidates (QuickBooks/Zoho track 1099 +
-- W-9; neither tracks credential EXPIRY — that's a staffing-app differentiator).
-- Documents themselves reuse the generic `attachments` table (entity_type='candidate').
-- Safe to re-run.

ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS tax_id            varchar(50),      -- EIN / SSN (as the org chooses to record)
  ADD COLUMN IF NOT EXISTS is_1099           boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS w9_on_file        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS work_authorization varchar(60),     -- e.g. Citizen, GC, H1B, OPT
  ADD COLUMN IF NOT EXISTS work_auth_expiry  date,
  ADD COLUMN IF NOT EXISTS insurance_expiry  date;
