const pool = require("../../config/db");

let schemaPromise = null;

const ensureApSchema = async (db = pool) => {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS vendors (
          id serial PRIMARY KEY,
          vendor_code varchar(50) UNIQUE,
          vendor_name varchar(200) NOT NULL,
          region_id int NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
          billing_address text,
          tax_identifier varchar(100),
          currency varchar(10) NOT NULL DEFAULT 'USD',
          default_payment_terms varchar(50) DEFAULT 'NET_30',
          primary_contact_name varchar(150),
          primary_contact_email varchar(150),
          primary_contact_phone varchar(30),
          bank_name varchar(150),
          bank_account_name varchar(200),
          bank_account_number varchar(100),
          bank_routing_number varchar(100),
          bank_swift_ifsc varchar(100),
          status varchar(20) NOT NULL DEFAULT 'ACTIVE',
          created_by int REFERENCES users(id) ON DELETE SET NULL,
          created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
          deleted_at timestamp NULL,
          CONSTRAINT vendors_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
        )
      `);

      await db.query(`
        CREATE TABLE IF NOT EXISTS bills (
          id serial PRIMARY KEY,
          bill_number varchar(100) UNIQUE NOT NULL,
          vendor_id int NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
          region_id int NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
          bill_date date NOT NULL,
          due_date date NOT NULL,
          service_period_start date NULL,
          service_period_end date NULL,
          subtotal numeric(12, 2) NOT NULL DEFAULT 0,
          tax_amount numeric(12, 2) NOT NULL DEFAULT 0,
          total_amount numeric(12, 2) NOT NULL DEFAULT 0,
          currency varchar(10) NOT NULL,
          bill_status varchar(30) NOT NULL DEFAULT 'DRAFT',
          approval_status varchar(30) NOT NULL DEFAULT 'NOT_SUBMITTED',
          payment_paid_amount numeric(12, 2) NOT NULL DEFAULT 0,
          balance_outstanding numeric(12, 2) NOT NULL DEFAULT 0,
          invoice_reference varchar(100),
          external_reference varchar(100),
          notes text,
          tax_lines_json jsonb NOT NULL DEFAULT '[]'::jsonb,
          created_by int REFERENCES users(id) ON DELETE SET NULL,
          approved_by int REFERENCES users(id) ON DELETE SET NULL,
          approved_at timestamp NULL,
          created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
          deleted_at timestamp NULL,
          CONSTRAINT bills_status_check CHECK (bill_status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED')),
          CONSTRAINT bills_approval_status_check CHECK (approval_status IN ('NOT_SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED'))
        )
      `);

      await db.query(`
        CREATE TABLE IF NOT EXISTS bill_items (
          id bigserial PRIMARY KEY,
          bill_id int NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
          description text NOT NULL,
          quantity numeric(12, 2) NOT NULL DEFAULT 1,
          unit_price numeric(14, 2) NOT NULL DEFAULT 0,
          line_total numeric(14, 2) NOT NULL DEFAULT 0,
          expense_category varchar(100),
          cost_center varchar(100),
          created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await db.query(`
        CREATE TABLE IF NOT EXISTS bill_approvals (
          id bigserial PRIMARY KEY,
          bill_id int NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
          step_no int NOT NULL DEFAULT 1,
          action varchar(30) NOT NULL,
          comments text,
          acted_by int REFERENCES users(id) ON DELETE SET NULL,
          acted_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
          created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await db.query(`
        CREATE TABLE IF NOT EXISTS vendor_payments (
          id serial PRIMARY KEY,
          payment_code varchar(100) UNIQUE,
          bill_id int NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
          payment_date date NOT NULL,
          amount_paid numeric(12, 2) NOT NULL,
          payment_method varchar(50),
          reference_number varchar(100),
          notes text,
          created_by int REFERENCES users(id) ON DELETE SET NULL,
          created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await db.query(`CREATE INDEX IF NOT EXISTS idx_vendors_region_id ON vendors(region_id)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_vendors_status ON vendors(status)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_bills_vendor_id ON bills(vendor_id)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_bills_region_id ON bills(region_id)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_bills_due_date ON bills(due_date)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_bills_status ON bills(bill_status)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_bills_approval_status ON bills(approval_status)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_bill_items_bill_id ON bill_items(bill_id)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_bill_approvals_bill_id ON bill_approvals(bill_id)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_vendor_payments_bill_id ON vendor_payments(bill_id)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_vendor_payments_payment_date ON vendor_payments(payment_date)`);
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }

  await schemaPromise;
};

module.exports = { ensureApSchema };
