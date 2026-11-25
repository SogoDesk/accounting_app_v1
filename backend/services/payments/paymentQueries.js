// Read side of customer payments: list, detail, invoice options, export, and
// the invoice-with-context lookup the write side shares. Every function takes db.

const { hasColumn } = require("../../utils/codeGenerator");
const { groupCurrency, attachReportingFields } = require("../../utils/reportingCurrency");
const { convertToUsd } = require("../../utils/fx");
const { regionTdsSelect } = require("./withholdingService");

let _billToColumnCache = null;
const hasBillToRegion = async (db) => {
  if (_billToColumnCache === null) _billToColumnCache = await hasColumn(db, "invoices", "bill_to_region_id");
  return _billToColumnCache;
};

// An inter-company invoice has no client; its party is the bill-to entity.
const getBillToParts = async (db, alias = "i") => {
  const present = await hasBillToRegion(db);
  return {
    join: present ? `LEFT JOIN regions btr ON ${alias}.bill_to_region_id = btr.id` : "",
    partyName: present ? "COALESCE(cl.client_name, btr.region_name)" : "cl.client_name",
  };
};

// The invoice row plus party, region, TDS flag, placement and candidate.
const getInvoiceWithContext = async (db, invoiceId) => {
  const billTo = await getBillToParts(db);
  const result = await db.query(`
    SELECT i.*, ${billTo.partyName} AS client_name, r.region_name,
      ${await regionTdsSelect(db)}, p.placement_code, p.job_title, c.full_name AS candidate_name
    FROM invoices i LEFT JOIN clients cl ON i.client_id = cl.id
    JOIN regions r ON i.region_id = r.id ${billTo.join}
    LEFT JOIN placements p ON i.placement_id = p.id
    LEFT JOIN candidates c ON p.candidate_id = c.id
    WHERE i.id = $1 LIMIT 1
  `, [invoiceId]);
  return result.rows[0] || null;
};

const buildPaymentSelectQuery = async (db) => {
  const hasPaymentCodeColumn = await hasColumn(db, "payments", "payment_code");
  const billTo = await getBillToParts(db);
  return `
    SELECT p.id, p.invoice_id, p.payment_date, p.amount_received, p.payment_mode,
      p.reference_number, p.exchange_rate, p.amount_in_base_currency, p.fx_gain_loss,
      p.tds_applicable, p.tds_percent, p.tds_amount, p.notes, p.created_by,
      p.created_at, p.updated_at,
      ${hasPaymentCodeColumn ? "p.payment_code" : "NULL::varchar AS payment_code"},
      i.region_id, i.invoice_number, i.invoice_date, i.due_date, i.invoice_status,
      i.total_amount AS invoice_total_amount, i.subtotal AS invoice_subtotal,
      i.payment_received_amount AS invoice_received_amount,
      i.balance_outstanding AS invoice_balance_outstanding,
      COALESCE(p.currency, i.currency) AS currency, ${billTo.partyName} AS client_name,
      r.region_name, pl.placement_code, pl.job_title, c.full_name AS candidate_name,
      u.full_name AS created_by_name
    FROM payments p JOIN invoices i ON p.invoice_id = i.id
    LEFT JOIN clients cl ON i.client_id = cl.id JOIN regions r ON i.region_id = r.id
    ${billTo.join} LEFT JOIN placements pl ON i.placement_id = pl.id
    LEFT JOIN candidates c ON pl.candidate_id = c.id LEFT JOIN users u ON p.created_by = u.id
  `;
};

/**
 * Payments, newest first, with amounts converted to the group currency.
 * filters: search, invoice_id, client_id, payment_mode. Returns { rows, reportingCcy }.
 */
const listPayments = async (db, filters, scope) => {
  const { search = "", invoice_id = "", client_id = "", payment_mode = "" } = filters;
  const hasPaymentCodeColumn = await hasColumn(db, "payments", "payment_code");
  const baseQuery = await buildPaymentSelectQuery(db);
  const conditions = [], values = [];
  let idx = 1;
  if (invoice_id) { conditions.push(`p.invoice_id = $${idx++}`); values.push(Number(invoice_id)); }
  if (client_id) { conditions.push(`i.client_id = $${idx++}`); values.push(Number(client_id)); }
  if (payment_mode) { conditions.push(`COALESCE(p.payment_mode, '') = $${idx++}`); values.push(String(payment_mode).trim().toUpperCase()); }
  if (search) {
    const parts = [`i.invoice_number ILIKE $${idx}`, `cl.client_name ILIKE $${idx}`, `COALESCE(c.full_name, '') ILIKE $${idx}`, `COALESCE(p.reference_number, '') ILIKE $${idx}`];
    if (hasPaymentCodeColumn) parts.push(`COALESCE(p.payment_code, '') ILIKE $${idx}`);
    conditions.push(`(${parts.join(" OR ")})`); values.push(`%${search}%`); idx++;
  }
  if (scope.entityIds) { conditions.push(`i.region_id = ANY($${idx++})`); values.push(scope.entityIds); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await db.query(`${baseQuery} ${where} ORDER BY p.payment_date DESC, p.id DESC`, values);
  const reportingCcy = await groupCurrency(db);
  await attachReportingFields(result.rows, { amount_received: "amount_received_reporting" }, { db, reportingCcy });
  return { rows: result.rows, reportingCcy };
};

// One payment with its invoice details, or null if missing or out of scope.
const getPayment = async (db, id, scope) => {
  const baseQuery = await buildPaymentSelectQuery(db);
  const result = await db.query(`${baseQuery} WHERE p.id = $1 LIMIT 1`, [id]);
  const payment = result.rows[0];
  return payment && scope.canAct(payment.region_id) ? payment : null;
};

// Invoices a payment can be recorded against (all but cancelled), newest first.
const listInvoiceOptions = async (db) => {
  const billTo = await getBillToParts(db);
  const result = await db.query(`
    SELECT i.id, i.invoice_number, i.invoice_date, i.due_date, i.invoice_status,
      i.subtotal, i.total_amount, i.payment_received_amount, i.balance_outstanding,
      i.currency, i.client_id, i.region_id, ${billTo.partyName} AS client_name,
      r.region_name, ${await regionTdsSelect(db)}, p.placement_code, p.job_title,
      c.full_name AS candidate_name
    FROM invoices i LEFT JOIN clients cl ON i.client_id = cl.id
    JOIN regions r ON i.region_id = r.id ${billTo.join}
    LEFT JOIN placements p ON i.placement_id = p.id LEFT JOIN candidates c ON p.candidate_id = c.id
    WHERE i.invoice_status <> 'CANCELLED' ORDER BY i.id DESC
  `);
  return result.rows;
};

/**
 * The payments export as a report descriptor for services/reports/reportExport.
 * filters: search, invoice_id, payment_mode, region_id, region_name, from, to.
 */
const buildPaymentExport = async (db, filters, scope) => {
  const { search = "", invoice_id = "", payment_mode = "", region_id = "", region_name = "", from = "", to = "" } = filters;
  const baseQuery = await buildPaymentSelectQuery(db), conditions = [], values = [];
  let idx = 1;
  if (invoice_id) { conditions.push(`p.invoice_id = $${idx++}`); values.push(Number(invoice_id)); }
  if (payment_mode) { conditions.push(`COALESCE(p.payment_mode, '') = $${idx++}`); values.push(String(payment_mode).trim().toUpperCase()); }
  if (region_id) { conditions.push(`i.region_id = $${idx++}`); values.push(Number(region_id)); }
  if (region_name) { conditions.push(`r.region_name = $${idx++}`); values.push(region_name); }
  if (from) { conditions.push(`p.payment_date >= $${idx++}`); values.push(from); }
  if (to) { conditions.push(`p.payment_date <= $${idx++}`); values.push(to); }
  if (scope.entityIds) { conditions.push(`i.region_id = ANY($${idx++})`); values.push(scope.entityIds); }
  if (search) { conditions.push(`(i.invoice_number ILIKE $${idx} OR cl.client_name ILIKE $${idx} OR COALESCE(c.full_name, '') ILIKE $${idx} OR COALESCE(p.reference_number, '') ILIKE $${idx})`); values.push(`%${search}%`); idx++; }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await db.query(`${baseQuery} ${where} ORDER BY p.payment_date DESC, p.id DESC`, values);
  const cache = new Map(); let totalUsd = 0; const rows = [];
  for (const r of result.rows) {
    const usd = await convertToUsd(r.amount_received, r.currency, cache); totalUsd += usd;
    rows.push({ payment_date: String(r.payment_date).slice(0, 10), payment_code: r.payment_code || "", invoice_number: r.invoice_number || "", client_name: r.client_name || "", region_name: r.region_name || "", payment_mode: r.payment_mode || "", reference_number: r.reference_number || "", currency: r.currency, amount_received: Number(r.amount_received || 0), amount_usd: usd });
  }
  const rangeLabel = (from || to) ? `${from || "…"} to ${to || "…"}` : "All dates";
  return {
    title: "Payments", subtitle: `${rangeLabel} · ${rows.length} payment(s) · collected total in USD (consolidated)`, columns: [
      { key: "payment_date", label: "Date", type: "text" }, { key: "payment_code", label: "Payment #", type: "text" },
      { key: "invoice_number", label: "Invoice #", type: "text" }, { key: "client_name", label: "Client", type: "text" },
      { key: "region_name", label: "Location", type: "text" }, { key: "payment_mode", label: "Mode", type: "text" },
      { key: "reference_number", label: "Reference", type: "text" }, { key: "currency", label: "Currency", type: "text" },
      { key: "amount_received", label: "Amount", type: "money" }, { key: "amount_usd", label: "Amount (USD)", type: "money" },
    ], rows, totals: { amount_usd: Math.round(totalUsd * 100) / 100 },
  };
};

module.exports = {
  getInvoiceWithContext,
  listPayments,
  getPayment,
  listInvoiceOptions,
  buildPaymentExport,
};
