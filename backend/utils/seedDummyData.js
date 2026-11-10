// =============================================================================
// seedDummyData.js — realistic dummy dataset for dev & testing
//
//   Run:   cd backend && node utils/seedDummyData.js
//   or:    npm run seed:dummy        (after adding the script to package.json)
//
// Covers all modules across 3 entities/currencies (US/USD, UK/GBP, India/INR),
// including the headline cross-border case: a UK contractor (paid in GBP via an
// AP bill) staffed at a US client (billed in USD via an AR invoice).
//
// Idempotent: re-running upserts on natural keys, so it won't create duplicates.
// Only uses base-schema columns, so it works whether or not migration 001 ran.
// =============================================================================

require("dotenv").config();
const bcrypt = require("bcryptjs");
const pool = require("../config/db");
const { ensureApSchema } = require("../modules/ap/ensureApSchema");

// ---- date helpers (relative to today) --------------------------------------
const fmt = (d) => d.toISOString().slice(0, 10);
const today = new Date();
const dAdd = (base, days) => {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
};
const monthsAgo = (n) => {
  const d = new Date(today);
  d.setMonth(d.getMonth() - n);
  return d;
};

// ---- generic upsert returning id -------------------------------------------
// ON CONFLICT DO UPDATE (no-op) guarantees a RETURNING row even on conflict.
async function upsert(db, table, conflictCol, row) {
  const cols = Object.keys(row);
  const vals = Object.values(row);
  const ph = cols.map((_, i) => `$${i + 1}`);
  const sql = `
    INSERT INTO ${table} (${cols.join(", ")})
    VALUES (${ph.join(", ")})
    ON CONFLICT (${conflictCol}) DO UPDATE SET ${conflictCol} = EXCLUDED.${conflictCol}
    RETURNING id`;
  const { rows } = await db.query(sql, vals);
  return rows[0].id;
}

async function seed() {
  await ensureApSchema(); // make sure AP tables (vendors/bills/...) exist
  const db = await pool.connect();
  try {
    await db.query("BEGIN");

    // ---- 1. Roles ----------------------------------------------------------
    const roleNames = ["SUPER_ADMIN", "FINANCE_ADMIN", "ACCOUNT_MANAGER", "RECRUITER"];
    const roleId = {};
    for (const name of roleNames) {
      roleId[name] = await upsert(db, "roles", "role_name", {
        role_name: name,
        description: `${name} role`,
      });
    }

    // ---- 2. Users (all dev passwords; admin = Admin@123) -------------------
    const adminHash = await bcrypt.hash("Admin@123", 12);
    const userHash = await bcrypt.hash("Password@123", 12);
    const users = [
      { full_name: "System Admin", email: "admin@accounting.com", role: "SUPER_ADMIN", hash: adminHash },
      { full_name: "Fiona Finance", email: "finance@tetriq.com", role: "FINANCE_ADMIN", hash: userHash },
      { full_name: "Mark US Manager", email: "manager.us@tetriq.com", role: "ACCOUNT_MANAGER", hash: userHash },
      { full_name: "Mary UK Manager", email: "manager.uk@tetriq.com", role: "ACCOUNT_MANAGER", hash: userHash },
      { full_name: "Riya Recruiter", email: "recruiter@tetriq.com", role: "RECRUITER", hash: userHash },
    ];
    const userId = {};
    for (const u of users) {
      userId[u.email] = await upsert(db, "users", "email", {
        full_name: u.full_name,
        email: u.email,
        password_hash: u.hash,
        role_id: roleId[u.role],
        status: "ACTIVE",
      });
    }
    const admin = userId["admin@accounting.com"];

    // ---- 3. Regions / legal entities --------------------------------------
    const regions = [
      {
        region_name: "United States", region_code: "US", default_currency: "USD",
        company_name: "TetriQ Solutions Inc", country_name: "United States", country_code: "US",
        company_id_label: "EIN", company_id_value: "84-1234567",
        bank_name: "Bank of America", bank_account_name: "TetriQ Solutions Inc",
        bank_account_number: "001234567890", bank_routing_number: "026009593", bank_swift_ifsc: "BOFAUS3N",
      },
      {
        region_name: "United Kingdom", region_code: "UK", default_currency: "GBP",
        company_name: "TetriQ Solutions Ltd", country_name: "United Kingdom", country_code: "GB",
        company_id_label: "Company No", company_id_value: "09876543",
        bank_name: "Barclays", bank_account_name: "TetriQ Solutions Ltd",
        bank_account_number: "12345678", bank_routing_number: "20-00-00", bank_swift_ifsc: "BARCGB22",
      },
      {
        region_name: "India", region_code: "IN", default_currency: "INR",
        company_name: "TetriQ Solutions Pvt Ltd", country_name: "India", country_code: "IN",
        company_id_label: "GSTIN", company_id_value: "29ABCDE1234F1Z5",
        bank_name: "HDFC Bank", bank_account_name: "TetriQ Solutions Pvt Ltd",
        bank_account_number: "50100123456789", bank_routing_number: "HDFC0001234", bank_swift_ifsc: "HDFCINBB",
      },
    ];
    const regionId = {};
    for (const r of regions) {
      regionId[r.region_code] = await upsert(db, "regions", "region_code", { ...r, status: "ACTIVE" });
    }

    // ---- 4. Candidates -----------------------------------------------------
    const candidates = [
      { candidate_code: "CND-001", full_name: "Oliver Brown", email: "oliver.brown@example.co.uk", country: "United Kingdom", job_title: "Senior Java Developer", skills: "Java, Spring, AWS" },
      { candidate_code: "CND-002", full_name: "Priya Sharma", email: "priya.sharma@example.in", country: "India", job_title: "Data Engineer", skills: "Python, Spark, SQL" },
      { candidate_code: "CND-003", full_name: "John Smith", email: "john.smith@example.com", country: "United States", job_title: "DevOps Engineer", skills: "Kubernetes, Terraform, CI/CD" },
      { candidate_code: "CND-004", full_name: "Rahul Verma", email: "rahul.verma@example.in", country: "India", job_title: "React Developer", skills: "React, TypeScript, Node" },
    ];
    const candId = {};
    for (const c of candidates) {
      candId[c.candidate_code] = await upsert(db, "candidates", "candidate_code", { ...c, status: "ACTIVE", created_by: admin });
    }

    // ---- 5. Clients --------------------------------------------------------
    const clients = [
      { client_code: "CLI-US-01", client_name: "Acme Corp", region: "US", currency: "USD", primary_contact_name: "Alan Acme", primary_contact_email: "ap@acme.com" },
      { client_code: "CLI-US-02", client_name: "Globex Inc", region: "US", currency: "USD", primary_contact_name: "Gina Globex", primary_contact_email: "billing@globex.com" },
      { client_code: "CLI-UK-01", client_name: "Britannia Tech", region: "UK", currency: "GBP", primary_contact_name: "Bert Brit", primary_contact_email: "accounts@britannia.co.uk" },
      { client_code: "CLI-IN-01", client_name: "Bharat Systems", region: "IN", currency: "INR", primary_contact_name: "Bina Bharat", primary_contact_email: "finance@bharatsys.in" },
    ];
    const clientId = {};
    for (const c of clients) {
      clientId[c.client_code] = await upsert(db, "clients", "client_code", {
        client_name: c.client_name, client_code: c.client_code, region_id: regionId[c.region],
        currency: c.currency, default_payment_terms: "NET_30", default_invoice_cycle: "MONTHLY",
        primary_contact_name: c.primary_contact_name, primary_contact_email: c.primary_contact_email,
        status: "ACTIVE", created_by: admin,
      });
    }

    // ---- 6. Placements (P1 = headline cross-border case) -------------------
    const placements = [
      {
        // UK contractor, billed to a US client in USD  <-- your scenario
        placement_code: "PLC-001", candidate: "CND-001", client: "CLI-US-01", region: "US",
        job_title: "Senior Java Developer", employment_type: "C2C", billing_type: "HOURLY",
        bill_rate: 95.0, pay_rate: 55.0, currency: "USD", expected_hours_per_month: 160,
        invoice_cycle: "MONTHLY", payment_terms: "NET_30", vendor_name: "UK Contractor Payroll Ltd",
      },
      {
        placement_code: "PLC-002", candidate: "CND-003", client: "CLI-US-02", region: "US",
        job_title: "DevOps Engineer", employment_type: "W2", billing_type: "MONTHLY",
        bill_rate: 0, pay_rate: 0, currency: "USD", monthly_billing_amount: 12000,
        invoice_cycle: "MONTHLY", payment_terms: "NET_15",
      },
      {
        placement_code: "PLC-003", candidate: "CND-002", client: "CLI-UK-01", region: "UK",
        job_title: "Data Engineer", employment_type: "C2C", billing_type: "HOURLY",
        bill_rate: 70.0, pay_rate: 40.0, currency: "GBP", expected_hours_per_month: 160,
        invoice_cycle: "MONTHLY", payment_terms: "NET_30", vendor_name: "India Staffing Partner LLP",
      },
      {
        placement_code: "PLC-004", candidate: "CND-004", client: "CLI-IN-01", region: "IN",
        job_title: "React Developer", employment_type: "CONTRACT", billing_type: "MONTHLY",
        bill_rate: 0, pay_rate: 0, currency: "INR", monthly_billing_amount: 180000,
        invoice_cycle: "MONTHLY", payment_terms: "NET_45",
      },
    ];
    const placeId = {};
    for (const p of placements) {
      placeId[p.placement_code] = await upsert(db, "placements", "placement_code", {
        placement_code: p.placement_code, candidate_id: candId[p.candidate], region_id: regionId[p.region],
        client_id: clientId[p.client], vendor_name: p.vendor_name || null,
        recruiter_id: userId["recruiter@tetriq.com"], account_manager_id: userId["manager.us@tetriq.com"],
        job_title: p.job_title, employment_type: p.employment_type, placement_status: "ACTIVE",
        billing_type: p.billing_type, bill_rate: p.bill_rate, pay_rate: p.pay_rate, currency: p.currency,
        expected_hours_per_month: p.expected_hours_per_month || 0,
        monthly_billing_amount: p.monthly_billing_amount || 0,
        invoice_cycle: p.invoice_cycle, payment_terms: p.payment_terms,
        start_date: fmt(monthsAgo(4)), created_by: admin,
      });
    }

    // ---- 7. Invoices (AR) — varied statuses & currencies ------------------
    // base rate = transaction ccy -> USD, used to fill amount_in_base_currency on payments
    const usdRate = { USD: 1, GBP: 1.27, INR: 0.012 };
    const invoices = [
      { num: "INV-2026-0001", place: "PLC-001", client: "CLI-US-01", region: "US", ccy: "USD", units: 160, rate: 95, status: "PAID", mAgo: 2 },
      { num: "INV-2026-0002", place: "PLC-001", client: "CLI-US-01", region: "US", ccy: "USD", units: 152, rate: 95, status: "PARTIALLY_PAID", mAgo: 1 },
      { num: "INV-2026-0003", place: "PLC-002", client: "CLI-US-02", region: "US", ccy: "USD", units: 1, rate: 12000, status: "SENT", mAgo: 0 },
      { num: "INV-2026-0004", place: "PLC-003", client: "CLI-UK-01", region: "UK", ccy: "GBP", units: 160, rate: 70, status: "PAID", mAgo: 2 },
      { num: "INV-2026-0005", place: "PLC-003", client: "CLI-UK-01", region: "UK", ccy: "GBP", units: 144, rate: 70, status: "OVERDUE", mAgo: 2 },
      { num: "INV-2026-0006", place: "PLC-004", client: "CLI-IN-01", region: "IN", ccy: "INR", units: 1, rate: 180000, status: "DRAFT", mAgo: 0 },
    ];
    const invId = {};
    for (const inv of invoices) {
      const subtotal = +(inv.units * inv.rate).toFixed(2);
      const tax = 0;
      const total = +(subtotal + tax).toFixed(2);
      const invDate = monthsAgo(inv.mAgo);
      const dueDate = dAdd(invDate, 30);
      let received = 0;
      if (inv.status === "PAID") received = total;
      else if (inv.status === "PARTIALLY_PAID") received = +(total / 2).toFixed(2);
      const balance = +(total - received).toFixed(2);

      invId[inv.num] = await upsert(db, "invoices", "invoice_number", {
        invoice_number: inv.num, placement_id: placeId[inv.place], client_id: clientId[inv.client],
        region_id: regionId[inv.region], invoice_date: fmt(invDate), due_date: fmt(dueDate),
        billing_period_start: fmt(monthsAgo(inv.mAgo + 1)), billing_period_end: fmt(invDate),
        hours_or_units: inv.units, bill_rate: inv.rate, subtotal, tax_amount: tax, total_amount: total,
        currency: inv.ccy, invoice_status: inv.status,
        payment_received_amount: received, balance_outstanding: balance, created_by: admin,
      });

      // payment record for paid / partially paid invoices
      if (received > 0) {
        const payDate = dAdd(invDate, 20);
        await upsert(db, "payments", "payment_code", {
          payment_code: `PAY-${inv.num}`, invoice_id: invId[inv.num], payment_date: fmt(payDate),
          amount_received: received, payment_mode: "BANK_TRANSFER", reference_number: `WIRE-${inv.num}`,
          exchange_rate: usdRate[inv.ccy], amount_in_base_currency: +(received * usdRate[inv.ccy]).toFixed(2),
          created_by: admin,
        });
      }
    }

    // ---- 8. Vendors (AP) ---------------------------------------------------
    const vendors = [
      { vendor_code: "VEN-UK-01", vendor_name: "UK Contractor Payroll Ltd", region: "UK", currency: "GBP", primary_contact_email: "pay@ukpayroll.co.uk" },
      { vendor_code: "VEN-IN-01", vendor_name: "India Staffing Partner LLP", region: "IN", currency: "INR", primary_contact_email: "accounts@indiastaff.in" },
      { vendor_code: "VEN-US-01", vendor_name: "US Verify Inc", region: "US", currency: "USD", primary_contact_email: "billing@usverify.com" },
    ];
    const vendorId = {};
    for (const v of vendors) {
      vendorId[v.vendor_code] = await upsert(db, "vendors", "vendor_code", {
        vendor_code: v.vendor_code, vendor_name: v.vendor_name, region_id: regionId[v.region],
        currency: v.currency, default_payment_terms: "NET_30", primary_contact_email: v.primary_contact_email,
        status: "ACTIVE", created_by: admin,
      });
    }

    // ---- 9. Bills (AP) + items — pay UK contractor in GBP, etc. ------------
    const bills = [
      { num: "BILL-2026-0001", vendor: "VEN-UK-01", region: "UK", ccy: "GBP", qty: 160, price: 55, status: "PAID", approval: "APPROVED", mAgo: 2, desc: "Oliver Brown — Java contractor (Jun)" },
      { num: "BILL-2026-0002", vendor: "VEN-UK-01", region: "UK", ccy: "GBP", qty: 152, price: 55, status: "APPROVED", approval: "APPROVED", mAgo: 1, desc: "Oliver Brown — Java contractor (Jul)" },
      { num: "BILL-2026-0003", vendor: "VEN-IN-01", region: "IN", ccy: "INR", qty: 160, price: 2200, status: "PARTIALLY_PAID", approval: "APPROVED", mAgo: 1, desc: "Priya Sharma — Data engineer" },
      { num: "BILL-2026-0004", vendor: "VEN-US-01", region: "US", ccy: "USD", qty: 3, price: 45, status: "SUBMITTED", approval: "PENDING", mAgo: 0, desc: "Background checks (3 candidates)" },
    ];
    const billId = {};
    for (const b of bills) {
      const subtotal = +(b.qty * b.price).toFixed(2);
      const total = subtotal;
      const billDate = monthsAgo(b.mAgo);
      const dueDate = dAdd(billDate, 30);
      let paid = 0;
      if (b.status === "PAID") paid = total;
      else if (b.status === "PARTIALLY_PAID") paid = +(total / 2).toFixed(2);
      const balance = +(total - paid).toFixed(2);

      billId[b.num] = await upsert(db, "bills", "bill_number", {
        bill_number: b.num, vendor_id: vendorId[b.vendor], region_id: regionId[b.region],
        bill_date: fmt(billDate), due_date: fmt(dueDate), subtotal, tax_amount: 0, total_amount: total,
        currency: b.ccy, bill_status: b.status, approval_status: b.approval,
        payment_paid_amount: paid, balance_outstanding: balance,
        approved_by: b.approval === "APPROVED" ? userId["finance@tetriq.com"] : null,
        created_by: admin,
      });

      // a single line item per bill (bill_items has no unique key -> guard manually)
      const exists = await db.query("SELECT 1 FROM bill_items WHERE bill_id = $1 LIMIT 1", [billId[b.num]]);
      if (exists.rowCount === 0) {
        await db.query(
          `INSERT INTO bill_items (bill_id, description, quantity, unit_price, line_total)
           VALUES ($1, $2, $3, $4, $5)`,
          [billId[b.num], b.desc, b.qty, b.price, total],
        );
      }

      // vendor payment for paid / partially-paid bills
      if (paid > 0) {
        await upsert(db, "vendor_payments", "payment_code", {
          payment_code: `VPAY-${b.num}`, bill_id: billId[b.num], payment_date: fmt(dAdd(billDate, 25)),
          amount_paid: paid, payment_method: "BANK_TRANSFER", reference_number: `VWIRE-${b.num}`,
          created_by: admin,
        });
      }
    }

    await db.query("COMMIT");

    // ---- summary -----------------------------------------------------------
    const counts = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM regions)         AS regions,
        (SELECT COUNT(*) FROM users)           AS users,
        (SELECT COUNT(*) FROM candidates)      AS candidates,
        (SELECT COUNT(*) FROM clients)         AS clients,
        (SELECT COUNT(*) FROM placements)      AS placements,
        (SELECT COUNT(*) FROM invoices)        AS invoices,
        (SELECT COUNT(*) FROM payments)        AS payments,
        (SELECT COUNT(*) FROM vendors)         AS vendors,
        (SELECT COUNT(*) FROM bills)           AS bills,
        (SELECT COUNT(*) FROM vendor_payments) AS vendor_payments
    `);
    console.log("✅ Dummy data seeded. Table counts:");
    console.table(counts.rows[0]);
    console.log("\nLogin accounts (all dev only):");
    console.log("  admin@accounting.com   / Admin@123     (SUPER_ADMIN)");
    console.log("  finance@tetriq.com     / Password@123  (FINANCE_ADMIN)");
    console.log("  manager.us@tetriq.com  / Password@123  (ACCOUNT_MANAGER)");
    console.log("  manager.uk@tetriq.com  / Password@123  (ACCOUNT_MANAGER)");
    console.log("  recruiter@tetriq.com   / Password@123  (RECRUITER)");
  } catch (err) {
    await db.query("ROLLBACK");
    console.error("❌ Seed failed (rolled back):", err.message);
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
}

seed();
