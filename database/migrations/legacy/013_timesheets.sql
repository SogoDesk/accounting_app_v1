-- 013_timesheets.sql
-- Timesheets for placements: log actual units (hours/days/weeks) per period,
-- run them through an approval gate, then bill approved time to an invoice.
-- Rates are snapshotted at entry so later placement-rate changes don't rewrite
-- historical timesheet economics. Safe to re-run.

CREATE TABLE IF NOT EXISTS timesheets (
  id            serial PRIMARY KEY,
  placement_id  integer NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  units         numeric(12,2) NOT NULL DEFAULT 0,   -- hours / days / weeks per the placement's billing type
  bill_rate     numeric(12,2) NOT NULL DEFAULT 0,   -- snapshot of the placement bill rate
  pay_rate      numeric(12,2) NOT NULL DEFAULT 0,   -- snapshot of the placement pay rate
  currency      varchar(10) NOT NULL,
  status        varchar(20) NOT NULL DEFAULT 'DRAFT',
  notes         text,
  invoice_id    integer REFERENCES invoices(id) ON DELETE SET NULL,
  created_by    integer REFERENCES users(id),
  approved_by   integer REFERENCES users(id),
  created_at    timestamp NOT NULL DEFAULT now(),
  updated_at    timestamp NOT NULL DEFAULT now(),
  CONSTRAINT timesheets_status_check
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','INVOICED'))
);

CREATE INDEX IF NOT EXISTS idx_timesheets_placement ON timesheets(placement_id);
CREATE INDEX IF NOT EXISTS idx_timesheets_status ON timesheets(status);
