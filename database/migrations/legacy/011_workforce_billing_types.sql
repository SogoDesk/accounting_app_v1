-- 011_workforce_billing_types.sql
-- Expand placement billing types from the bare HOURLY / MONTHLY / ONE_TIME set
-- to a full staffing set that better reflects how placements are actually billed.
--
-- New set: HOURLY, DAILY, WEEKLY, MONTHLY, ANNUAL, FIXED, PERM_FEE
--   * ONE_TIME is migrated to FIXED (same meaning: a one-off / project fee).
--   * DAILY / WEEKLY bill like HOURLY (bill_rate x units/month).
--   * ANNUAL stores the annual amount in monthly_billing_amount; invoices bill 1/12.
--   * FIXED / PERM_FEE bill a flat fee from one_time_fee_amount.
--
-- Safe to re-run (drops the constraint with IF EXISTS before recreating).

BEGIN;

-- Carry forward any legacy one-time placements to the new "fixed fee" type.
UPDATE placements SET billing_type = 'FIXED' WHERE billing_type = 'ONE_TIME';

ALTER TABLE placements DROP CONSTRAINT IF EXISTS placements_billing_type_check;

ALTER TABLE placements
  ADD CONSTRAINT placements_billing_type_check
  CHECK (billing_type::text = ANY (ARRAY[
    'HOURLY'::text,
    'DAILY'::text,
    'WEEKLY'::text,
    'MONTHLY'::text,
    'ANNUAL'::text,
    'FIXED'::text,
    'PERM_FEE'::text
  ]));

COMMIT;
