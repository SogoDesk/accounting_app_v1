const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { authenticate: auth } = require("../middleware/authMiddleware");
const { scopeAccess } = require("../middleware/scopeMiddleware");
const { permit } = require("../middleware/permissionMiddleware");
const { buildCsv, sendCsvResponse } = require("../utils/exportUtils");
const { sendReport } = require("../services/reports/reportExport");

// Row-level RBAC: every report/dashboard query is scoped to the caller's
// allowed entities (== regions.id). authenticate runs first, then scopeAccess
// attaches req.allowedEntityIds / req.scopeEnforced.
router.use(auth, scopeAccess);

// The aggregate dashboard summaries stay broad (the Dashboard is open to every
// role, and each query is already entity-scoped). But the CSV EXTRACTS pull
// detailed financial data (client statements, revenue, overdues), so gate those
// behind the finance permission — honoured for custom roles, legacy-role
// fallback for the default roles.
const financeExport = permit("invoices", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN");

const getFilters = (query) => ({
  month: query.month || null,
  regionId: query.region_id ? Number(query.region_id) : null,
  clientId: query.client_id ? Number(query.client_id) : null,
});

// Append `<col> = ANY($n)` restricting to the caller's allowed entities, but
// only when RBAC is installed (scopeEnforced). Pre-migration it is a no-op so
// the app keeps working before migration 005 rolls out.
const scopeEntity = (req, col, cond, vals) => {
  if (req.scopeEnforced && Array.isArray(req.allowedEntityIds)) {
    cond.push(`${col} = ANY($${vals.length + 1})`);
    vals.push(req.allowedEntityIds);
  }
};

// Dashboard summary
router.get("/dashboard-summary", auth, async (req, res) => {
  try {
    const { month, regionId, clientId } = getFilters(req.query);
    const cond = []; const vals = []; let i = 1;
    if (regionId) { cond.push(`i.region_id=$${i++}`); vals.push(regionId); }
    if (clientId) { cond.push(`i.client_id=$${i++}`); vals.push(clientId); }
    if (month) { cond.push(`TO_CHAR(i.invoice_date,'YYYY-MM')=$${i++}`); vals.push(month); }
    scopeEntity(req, "i.region_id", cond, vals);
    const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";

    const plCond = []; const plVals = [];
    if (regionId) { plCond.push(`region_id=$${plVals.length + 1}`); plVals.push(regionId); }
    if (clientId) { plCond.push(`client_id=$${plVals.length + 1}`); plVals.push(clientId); }
    scopeEntity(req, "region_id", plCond, plVals);
    const plWhere = plCond.length ? `WHERE placement_status='ACTIVE' AND ${plCond.join(" AND ")}` : "WHERE placement_status='ACTIVE'";

    const [inv, pay, pl, counts] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total_invoices, COALESCE(SUM(total_amount),0) AS invoiced_amount, COALESCE(SUM(payment_received_amount),0) AS received_amount, COALESCE(SUM(balance_outstanding),0) AS outstanding_amount, COUNT(*) FILTER(WHERE invoice_status NOT IN('PAID','CANCELLED') AND due_date < CURRENT_DATE) AS overdue_invoices_count FROM invoices i ${where}`, vals),
      pool.query(`SELECT COUNT(*) AS total_payments FROM payments p JOIN invoices i ON p.invoice_id=i.id ${where}`, vals),
      pool.query(`SELECT COALESCE(SUM(CASE WHEN billing_type='HOURLY' THEN bill_rate*expected_hours_per_month WHEN billing_type='MONTHLY' THEN monthly_billing_amount WHEN billing_type='ONE_TIME' THEN one_time_fee_amount ELSE 0 END),0) AS projected_revenue FROM placements ${plWhere}`, plVals),
      pool.query("SELECT (SELECT COUNT(*) FROM regions) AS total_regions, (SELECT COUNT(*) FROM clients) AS total_clients, (SELECT COUNT(*) FROM candidates) AS total_candidates, (SELECT COUNT(*) FROM placements) AS total_placements"),
    ]);

    const summary = { ...inv.rows[0], ...pay.rows[0], ...pl.rows[0], ...counts.rows[0] };
    const received = Number(summary.received_amount || 0);
    summary.actual_revenue = received;
    return res.json({ success: true, data: summary });
  } catch (err) { return res.status(500).json({ success: false, message: "Server error" }); }
});

// Monthly revenue summary
router.get("/monthly-revenue-summary", auth, async (req, res) => {
  try {
    const { month, regionId, clientId } = getFilters(req.query);
    const cond = []; const vals = []; let i = 1;
    if (regionId) { cond.push(`i.region_id=$${i++}`); vals.push(regionId); }
    if (clientId) { cond.push(`i.client_id=$${i++}`); vals.push(clientId); }
    if (month) { cond.push(`TO_CHAR(i.invoice_date,'YYYY-MM')=$${i++}`); vals.push(month); }
    scopeEntity(req, "i.region_id", cond, vals);
    const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";

    const result = await pool.query(`
      SELECT TO_CHAR(invoice_date,'YYYY-MM') AS month_key,
        COALESCE(SUM(total_amount),0) AS invoiced_revenue,
        COALESCE(SUM(payment_received_amount),0) AS actual_revenue,
        COUNT(*) AS invoice_count
      FROM invoices i ${where}
      GROUP BY TO_CHAR(invoice_date,'YYYY-MM')
      ORDER BY month_key DESC LIMIT 24`, vals);
    return res.json({ success: true, data: result.rows });
  } catch (err) { return res.status(500).json({ success: false, message: "Server error" }); }
});

// Region revenue summary
router.get("/region-revenue-summary", auth, async (req, res) => {
  try {
    const cond = []; const vals = [];
    scopeEntity(req, "r.id", cond, vals);
    const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
    const result = await pool.query(`
      SELECT r.id AS region_id, r.region_name,
        COALESCE(SUM(i.total_amount),0) AS invoiced_revenue,
        COALESCE(SUM(i.payment_received_amount),0) AS actual_revenue,
        COALESCE(SUM(i.balance_outstanding),0) AS outstanding
      FROM regions r
      LEFT JOIN invoices i ON r.id=i.region_id
      ${where}
      GROUP BY r.id, r.region_name ORDER BY invoiced_revenue DESC`, vals);
    return res.json({ success: true, data: result.rows });
  } catch (err) { return res.status(500).json({ success: false, message: "Server error" }); }
});

// Client revenue summary
router.get("/client-revenue-summary", auth, async (req, res) => {
  try {
    const { regionId } = getFilters(req.query);
    const cond = []; const vals = []; let i = 1;
    if (regionId) { cond.push(`cl.region_id=$${i++}`); vals.push(regionId); }
    scopeEntity(req, "cl.region_id", cond, vals);
    const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
    const result = await pool.query(`
      SELECT cl.id AS client_id, cl.client_name,
        COALESCE(SUM(i.total_amount),0) AS invoiced_revenue,
        COALESCE(SUM(i.payment_received_amount),0) AS actual_revenue,
        COALESCE(SUM(i.balance_outstanding),0) AS outstanding,
        COUNT(DISTINCT i.id) AS invoice_count
      FROM clients cl
      LEFT JOIN invoices i ON cl.id=i.client_id
      ${where}
      GROUP BY cl.id, cl.client_name ORDER BY invoiced_revenue DESC LIMIT 20`, vals);
    return res.json({ success: true, data: result.rows });
  } catch (err) { return res.status(500).json({ success: false, message: "Server error" }); }
});

// Overdue invoices
router.get("/overdue-invoices", auth, async (req, res) => {
  try {
    const cond = []; const vals = [];
    scopeEntity(req, "i.region_id", cond, vals);
    const extra = cond.length ? ` AND ${cond.join(" AND ")}` : "";
    const result = await pool.query(`
      SELECT i.id, i.invoice_number, cl.client_name, i.due_date,
        i.balance_outstanding, i.currency, i.invoice_status,
        CURRENT_DATE - i.due_date AS days_overdue
      FROM invoices i
      JOIN clients cl ON i.client_id=cl.id
      WHERE i.invoice_status NOT IN('PAID','CANCELLED')
        AND i.due_date < CURRENT_DATE AND i.balance_outstanding > 0${extra}
      ORDER BY days_overdue DESC`, vals);
    return res.json({ success: true, data: result.rows });
  } catch (err) { return res.status(500).json({ success: false, message: "Server error" }); }
});

// Receivables aging
router.get("/receivables-aging-summary", auth, async (req, res) => {
  try {
    const cond = []; const vals = [];
    scopeEntity(req, "region_id", cond, vals);
    const extra = cond.length ? ` AND ${cond.join(" AND ")}` : "";
    const result = await pool.query(`
      SELECT
        COALESCE(SUM(balance_outstanding) FILTER(WHERE due_date >= CURRENT_DATE),0) AS current_bucket,
        COALESCE(SUM(balance_outstanding) FILTER(WHERE CURRENT_DATE - due_date BETWEEN 1 AND 30),0) AS bucket_1_30,
        COALESCE(SUM(balance_outstanding) FILTER(WHERE CURRENT_DATE - due_date BETWEEN 31 AND 60),0) AS bucket_31_60,
        COALESCE(SUM(balance_outstanding) FILTER(WHERE CURRENT_DATE - due_date BETWEEN 61 AND 90),0) AS bucket_61_90,
        COALESCE(SUM(balance_outstanding) FILTER(WHERE CURRENT_DATE - due_date > 90),0) AS bucket_90_plus
      FROM invoices WHERE invoice_status NOT IN('PAID','CANCELLED') AND balance_outstanding > 0${extra}`, vals);
    return res.json({ success: true, data: result.rows[0] });
  } catch (err) { return res.status(500).json({ success: false, message: "Server error" }); }
});

// CSV exports
router.get("/exports/monthly-revenue-summary", financeExport, async (req, res) => {
  try {
    const cond = []; const vals = [];
    scopeEntity(req, "region_id", cond, vals);
    const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
    const result = await pool.query(`SELECT TO_CHAR(invoice_date,'YYYY-MM') AS month, SUM(total_amount) AS invoiced, SUM(payment_received_amount) AS received, SUM(balance_outstanding) AS outstanding FROM invoices ${where} GROUP BY 1 ORDER BY 1 DESC`, vals);
    return sendReport(res, {
      title: "Monthly Revenue Summary",
      columns: [
        { key: "month", label: "Month" }, { key: "invoiced", label: "Invoiced", type: "money" },
        { key: "received", label: "Received", type: "money" }, { key: "outstanding", label: "Outstanding", type: "money" },
      ],
      rows: result.rows,
    }, req.query.format || "csv");
  } catch (err) { return res.status(500).json({ success: false, message: "Server error" }); }
});

router.get("/exports/client-revenue-summary", financeExport, async (req, res) => {
  try {
    const cond = []; const vals = [];
    scopeEntity(req, "cl.region_id", cond, vals);
    const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
    const result = await pool.query(`SELECT cl.client_name, SUM(i.total_amount) AS invoiced, SUM(i.payment_received_amount) AS received, SUM(i.balance_outstanding) AS outstanding FROM clients cl LEFT JOIN invoices i ON cl.id=i.client_id ${where} GROUP BY cl.client_name ORDER BY invoiced DESC`, vals);
    return sendReport(res, {
      title: "Client Revenue Summary",
      columns: [
        { key: "client_name", label: "Client" }, { key: "invoiced", label: "Invoiced", type: "money" },
        { key: "received", label: "Received", type: "money" }, { key: "outstanding", label: "Outstanding", type: "money" },
      ],
      rows: result.rows,
    }, req.query.format || "csv");
  } catch (err) { return res.status(500).json({ success: false, message: "Server error" }); }
});

router.get("/exports/overdue-invoices", financeExport, async (req, res) => {
  try {
    const cond = []; const vals = [];
    scopeEntity(req, "i.region_id", cond, vals);
    const extra = cond.length ? ` AND ${cond.join(" AND ")}` : "";
    const result = await pool.query(`SELECT i.invoice_number, cl.client_name, i.due_date, i.balance_outstanding, i.currency, CURRENT_DATE - i.due_date AS days_overdue, i.invoice_status FROM invoices i JOIN clients cl ON i.client_id=cl.id WHERE i.invoice_status NOT IN('PAID','CANCELLED') AND i.due_date < CURRENT_DATE AND i.balance_outstanding > 0${extra} ORDER BY days_overdue DESC`, vals);
    return sendReport(res, {
      title: "Overdue Invoices",
      columns: [
        { key: "invoice_number", label: "Invoice" }, { key: "client_name", label: "Client" },
        { key: "due_date", label: "Due", type: "date" }, { key: "balance_outstanding", label: "Outstanding", type: "money" },
        { key: "currency", label: "Ccy" }, { key: "days_overdue", label: "Days", type: "number" },
        { key: "invoice_status", label: "Status" },
      ],
      rows: result.rows,
    }, req.query.format || "csv");
  } catch (err) { return res.status(500).json({ success: false, message: "Server error" }); }
});

router.get("/exports/client-statement", financeExport, async (req, res) => {
  try {
    const clientId = Number(req.query.client_id);
    if (!clientId) {
      return res
        .status(400)
        .json({ success: false, message: "client_id is required" });
    }

    const clientResult = await pool.query(
      `SELECT client_name, client_code, region_id FROM clients WHERE id = $1 LIMIT 1`,
      [clientId],
    );

    if (!clientResult.rows.length) {
      return res
        .status(404)
        .json({ success: false, message: "Client not found" });
    }

    if (
      req.scopeEnforced &&
      Array.isArray(req.allowedEntityIds) &&
      !req.allowedEntityIds.includes(Number(clientResult.rows[0].region_id))
    ) {
      return res.status(403).json({ success: false, message: "Not authorized for this client" });
    }

    const result = await pool.query(
      `
      WITH entries AS (
        SELECT
          i.invoice_date::date AS txn_date,
          'INVOICE'::text AS entry_type,
          i.invoice_number AS reference,
          i.currency,
          COALESCE(i.total_amount, 0)::numeric AS debit,
          0::numeric AS credit
        FROM invoices i
        WHERE i.client_id = $1

        UNION ALL

        SELECT
          p.payment_date::date AS txn_date,
          'PAYMENT'::text AS entry_type,
          COALESCE(NULLIF(p.payment_code, ''), NULLIF(p.reference_number, ''), 'PAY-' || p.id::text) AS reference,
          COALESCE(p.currency, i.currency) AS currency,
          0::numeric AS debit,
          COALESCE(p.amount_received, 0)::numeric AS credit
        FROM payments p
        JOIN invoices i ON i.id = p.invoice_id
        WHERE i.client_id = $1
      )
      SELECT
        txn_date,
        entry_type,
        reference,
        currency,
        debit,
        credit,
        SUM(debit - credit) OVER (
          ORDER BY txn_date ASC, entry_type DESC, reference ASC
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS running_balance
      FROM entries
      ORDER BY txn_date ASC, entry_type DESC, reference ASC
      `,
      [clientId],
    );

    const payload = result.rows.map((row) => ({
      client_name: clientResult.rows[0].client_name,
      client_code: clientResult.rows[0].client_code || "",
      txn_date: row.txn_date,
      entry_type: row.entry_type,
      reference: row.reference,
      currency: row.currency,
      debit: row.debit,
      credit: row.credit,
      running_balance: row.running_balance,
    }));

    sendCsvResponse(
      res,
      buildCsv(payload, [
        "client_name",
        "client_code",
        "txn_date",
        "entry_type",
        "reference",
        "currency",
        "debit",
        "credit",
        "running_balance",
      ]),
      `client_statement_${clientResult.rows[0].client_code || clientId}.csv`,
    );
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
