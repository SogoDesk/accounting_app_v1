-- =============================================================================
-- Migration 016 — Inter-company invoices
--
--   Adds a second invoice shape: one TetriQ entity billing another (cost
--   transfers, shared services, cross-charging). The "bill to" party is a
--   regions row, not a clients row — regions already carries company_name,
--   company_address, company_id_* and bank_*, so no new entity table is needed.
--
--   invoice_type discriminates:
--     CLIENT        (default, existing behaviour) -> client_id + placement_id
--     INTER_COMPANY (new)                         -> bill_to_region_id
--
--   region_id remains the ISSUER ("from") on both shapes, so RBAC scoping
--   (scopeMiddleware -> canActOnEntity) and GL entity_id are unchanged.
--
--   COA additions 4600 / 5700 are the P&L elimination pair, mirroring the
--   1600/2600 balance-sheet pair from 007. NOTE: 4900 was NOT used — it is
--   already 'Realized FX Gain' (002_general_ledger.sql:162). 5600 is likewise
--   taken (EMI / Finance Charges), hence 5700 rather than a symmetrical x600.
--
--   Existing rows are untouched: every current invoice has client_id and
--   placement_id NOT NULL, so the CLIENT branch of the shape CHECK holds for
--   all of them under the 'CLIENT' default.
--
--   Idempotent. DDL + seed only, no ledger UPDATEs.
--   Depends on: invoices (000), chart_of_accounts (002), regions (000),
--   journal_entries (002/007), document_numbering_config (014).
-- =============================================================================

BEGIN;

-- 1) Discriminator + bill-to party ------------------------------------------
ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS invoice_type      varchar(20) NOT NULL DEFAULT 'CLIENT',
    ADD COLUMN IF NOT EXISTS bill_to_region_id integer;

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_invoice_type_check;
ALTER TABLE invoices ADD  CONSTRAINT invoices_invoice_type_check
    CHECK (invoice_type IN ('CLIENT', 'INTER_COMPANY'));

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS fk_invoices_bill_to_region;
ALTER TABLE invoices ADD  CONSTRAINT fk_invoices_bill_to_region
    FOREIGN KEY (bill_to_region_id) REFERENCES regions(id) ON DELETE RESTRICT;

-- 2) Relax the client/placement coupling ------------------------------------
--    The FKs stay; only the NOT NULLs go. An INTER_COMPANY invoice has no
--    external client and no placement (a placement would transitively force a
--    candidate, since placements.candidate_id is NOT NULL).
ALTER TABLE invoices ALTER COLUMN client_id    DROP NOT NULL;
ALTER TABLE invoices ALTER COLUMN placement_id DROP NOT NULL;

-- 3) Shape enforcement per type ---------------------------------------------
--    This is what keeps DROP NOT NULL from weakening the CLIENT path: a CLIENT
--    invoice still cannot exist without client_id + placement_id.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_type_shape_check;
ALTER TABLE invoices ADD  CONSTRAINT invoices_type_shape_check CHECK (
    (   invoice_type = 'CLIENT'
    AND client_id         IS NOT NULL
    AND placement_id      IS NOT NULL
    AND bill_to_region_id IS NULL )
 OR (   invoice_type = 'INTER_COMPANY'
    AND bill_to_region_id IS NOT NULL
    AND client_id         IS NULL
    AND placement_id      IS NULL )
);

-- An entity cannot invoice itself.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_bill_to_not_self_check;
ALTER TABLE invoices ADD  CONSTRAINT invoices_bill_to_not_self_check
    CHECK (bill_to_region_id IS NULL OR bill_to_region_id <> region_id);

-- Inter-company invoices are zero-rated (decision: tax never applies, 2100 is
-- never hit). Enforced here as well as in validateInvoiceLineItems so the rule
-- cannot be bypassed by the timesheet path or a direct write.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_ic_zero_rated_check;
ALTER TABLE invoices ADD  CONSTRAINT invoices_ic_zero_rated_check CHECK (
    invoice_type <> 'INTER_COMPANY'
    OR (tax_amount = 0 AND tax_lines_json = '[]'::jsonb)
);

CREATE INDEX IF NOT EXISTS idx_invoices_type
    ON invoices (invoice_type);
CREATE INDEX IF NOT EXISTS idx_invoices_bill_to_region
    ON invoices (bill_to_region_id)
    WHERE bill_to_region_id IS NOT NULL;

-- 4) P&L elimination pair ----------------------------------------------------
--    1600/2600 (007) net the balance sheet; these net the P&L. Without them,
--    glReports.consolidated() would still double-count group revenue.
--    Kept is_control = true: system-posted only, never hand-picked in a manual
--    journal, same treatment as 1100/2000/1600/2600.
INSERT INTO chart_of_accounts (account_code, account_name, account_type, normal_balance, is_control, is_active)
VALUES
  ('4600', 'Inter-company Revenue', 'INCOME',  'CREDIT', true, true),
  ('5700', 'Inter-company Cost',    'EXPENSE', 'DEBIT',  true, true)
ON CONFLICT (account_code) DO NOTHING;

-- 5) Distinct GL source for inter-company invoices ---------------------------
--    NOT reusing 'INTERCOMPANY' (007): that source is claimed by
--    intercompanyService.postTransfer with source_ref = transfer id. Sharing it
--    would collide on source_ref (transfer 5 vs invoice 5) and break
--    syncInvoiceGl's reverse/repost lookup. Both legs of an IC invoice use
--    source='IC_INVOICE', source_ref=<invoice id>, distinguished by entity_id.
ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS je_source_check;
ALTER TABLE journal_entries ADD  CONSTRAINT je_source_check CHECK (source IN (
  'MANUAL','AR_INVOICE','AR_PAYMENT','AP_BILL','AP_PAYMENT','FX_REVAL',
  'OPENING','EXPENSE','EXPENSE_REIMBURSE','INTERCOMPANY','IC_INVOICE'));

-- 6) Numbering: IC-YYYY-NNNNNN via the existing doc_seq mechanism ------------
--    codeGenerator.nextDocNumber(db, 'intercompany_invoice', 'IC') will
--    CREATE SEQUENCE IF NOT EXISTS doc_seq_intercompany_invoice_<year> on first
--    use, so there is nothing to seed — no IC numbers exist yet.
INSERT INTO document_numbering_config (doc_type, label, prefix, padding, include_year)
VALUES ('intercompany_invoice', 'Inter-company Invoices', 'IC', 6, true)
ON CONFLICT (doc_type) DO NOTHING;

COMMIT;

-- =============================================================================
-- Follow-on code changes (not in this migration):
--   * glReports.consolidated() must eliminate 4600/5700 alongside 1600/2600.
--   * postingService gains the two-sided IC posting (Dr 1600 / Cr 4600 on the
--     issuer; Dr 5700 / Cr 2600 on the counterparty).
--   * paymentController INNER JOINs to clients become LEFT JOINs.
--   * timesheetController must set invoice_type = 'CLIENT' explicitly.
-- =============================================================================
