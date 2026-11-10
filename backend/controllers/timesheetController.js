const pool = require("../config/db");
const { generateInvoiceNumber } = require("../utils/codeGenerator");
const glPosting = require("../services/gl/postingService");
const { copyAttachments } = require("./attachmentController");
const { canActOnEntity } = require("../middleware/scopeMiddleware");
const { reportingCurrencyFor, attachReportingFields } = require("../utils/reportingCurrency");

const toNum = (v) => {
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
};
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Allowed status transitions for the approval workflow.
const NEXT = {
  DRAFT: ["SUBMITTED"],
  SUBMITTED: ["APPROVED", "REJECTED"],
  REJECTED: ["SUBMITTED", "DRAFT"],
  APPROVED: ["REJECTED"], // un-approve before it's invoiced
  INVOICED: [],
};

// Rows enriched with placement/candidate/client/region for display + scope.
const SELECT = `
  SELECT t.*,
         (t.units * t.bill_rate) AS bill_amount,
         (t.units * t.pay_rate)  AS pay_amount,
         p.placement_code, p.billing_type, p.region_id,
         c.full_name AS candidate_name,
         cl.client_name,
         r.region_name,
         inv.invoice_number
    FROM timesheets t
    JOIN placements p ON t.placement_id = p.id
    JOIN candidates c ON p.candidate_id = c.id
    JOIN clients cl ON p.client_id = cl.id
    JOIN regions r ON p.region_id = r.id
    LEFT JOIN invoices inv ON t.invoice_id = inv.id
`;

// GET /api/timesheets?placement_id=&status=&from=&to=
const listTimesheets = async (req, res) => {
  try {
    const { placement_id, status, from, to, entityId } = req.query;
    const params = [];
    const where = [];
    if (placement_id) { params.push(Number(placement_id)); where.push(`t.placement_id = $${params.length}`); }
    if (status) { params.push(String(status).toUpperCase()); where.push(`t.status = $${params.length}`); }
    if (from) { params.push(from); where.push(`t.period_end >= $${params.length}`); }
    if (to) { params.push(to); where.push(`t.period_start <= $${params.length}`); }
    // Region scope from the global top-nav switcher.
    if (entityId) { params.push(Number(entityId)); where.push(`p.region_id = $${params.length}`); }
    if (req.scopeEnforced && Array.isArray(req.allowedEntityIds)) {
      params.push(req.allowedEntityIds); where.push(`p.region_id = ANY($${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const { rows } = await pool.query(`${SELECT} ${whereSql} ORDER BY t.period_start DESC, t.id DESC`, params);

    // Cross-currency KPI safety: emit each row's billable/pay value in the
    // reporting currency (the region's own currency when one is selected, else
    // the group currency, USD) so the frontend never raw-sums mixed currencies.
    const reportingCcy = await reportingCurrencyFor(req);
    await attachReportingFields(rows, { bill_amount: "bill_amount_reporting", pay_amount: "pay_amount_reporting" }, { reportingCcy });
    return res.json({ success: true, data: rows, reporting_currency: reportingCcy });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Load a placement (for rate snapshot + scope) or null.
const loadPlacement = async (placementId) => {
  const { rows } = await pool.query(
    `SELECT id, region_id, client_id, candidate_id, currency, bill_rate, pay_rate,
            payment_terms, custom_payment_terms_days, tax_applicable, tax_percent,
            placement_code, job_title
       FROM placements WHERE id = $1`,
    [Number(placementId)],
  );
  return rows[0] || null;
};

// POST /api/timesheets  { placement_id, period_start, period_end, units, notes, bill_rate?, pay_rate? }
const createTimesheet = async (req, res) => {
  try {
    const placement = await loadPlacement(req.body.placement_id);
    if (!placement) return res.status(400).json({ success: false, message: "Select a valid placement." });
    if (!canActOnEntity(req, placement.region_id)) {
      return res.status(403).json({ success: false, message: "Not authorized for this placement's region." });
    }
    const { period_start, period_end, units, notes } = req.body;
    if (!period_start || !period_end) {
      return res.status(400).json({ success: false, message: "Period start and end are required." });
    }
    if (toNum(units) <= 0) {
      return res.status(400).json({ success: false, message: "Units must be greater than zero." });
    }
    // Snapshot rates from the placement unless explicitly overridden.
    const billRate = req.body.bill_rate != null && req.body.bill_rate !== "" ? toNum(req.body.bill_rate) : toNum(placement.bill_rate);
    const payRate = req.body.pay_rate != null && req.body.pay_rate !== "" ? toNum(req.body.pay_rate) : toNum(placement.pay_rate);

    const { rows } = await pool.query(
      `INSERT INTO timesheets
         (placement_id, period_start, period_end, units, bill_rate, pay_rate, currency, status, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'DRAFT',$8,$9) RETURNING *`,
      [placement.id, period_start, period_end, round2(units), billRate, payRate, placement.currency, notes || null, req.user?.id || null],
    );
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const getOwned = async (id) => {
  const { rows } = await pool.query(
    `SELECT t.*, p.region_id FROM timesheets t JOIN placements p ON t.placement_id = p.id WHERE t.id = $1`,
    [Number(id)],
  );
  return rows[0] || null;
};

// PUT /api/timesheets/:id  — edit an unlocked (DRAFT/REJECTED) timesheet
const updateTimesheet = async (req, res) => {
  try {
    const ts = await getOwned(req.params.id);
    if (!ts) return res.status(404).json({ success: false, message: "Timesheet not found." });
    if (!canActOnEntity(req, ts.region_id)) {
      return res.status(403).json({ success: false, message: "Not authorized." });
    }
    if (!["DRAFT", "REJECTED"].includes(ts.status)) {
      return res.status(400).json({ success: false, message: `A ${ts.status} timesheet can't be edited.` });
    }
    const { period_start, period_end, units, notes, bill_rate, pay_rate } = req.body;
    if (units != null && toNum(units) <= 0) {
      return res.status(400).json({ success: false, message: "Units must be greater than zero." });
    }
    const { rows } = await pool.query(
      `UPDATE timesheets SET
         period_start = COALESCE($1, period_start),
         period_end   = COALESCE($2, period_end),
         units        = COALESCE($3, units),
         notes        = $4,
         bill_rate    = COALESCE($5, bill_rate),
         pay_rate     = COALESCE($6, pay_rate),
         updated_at   = now()
       WHERE id = $7 RETURNING *`,
      [
        period_start || null, period_end || null,
        units != null && units !== "" ? round2(units) : null,
        notes || null,
        bill_rate != null && bill_rate !== "" ? toNum(bill_rate) : null,
        pay_rate != null && pay_rate !== "" ? toNum(pay_rate) : null,
        ts.id,
      ],
    );
    return res.json({ success: true, data: rows[0] });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// PATCH /api/timesheets/:id/status  { status }
const setStatus = async (req, res) => {
  try {
    const ts = await getOwned(req.params.id);
    if (!ts) return res.status(404).json({ success: false, message: "Timesheet not found." });
    if (!canActOnEntity(req, ts.region_id)) {
      return res.status(403).json({ success: false, message: "Not authorized." });
    }
    const target = String(req.body.status || "").toUpperCase();
    if (!(NEXT[ts.status] || []).includes(target)) {
      return res.status(400).json({ success: false, message: `Can't move a ${ts.status} timesheet to ${target}.` });
    }
    const approvedBy = target === "APPROVED" ? (req.user?.id || null) : null;
    const { rows } = await pool.query(
      `UPDATE timesheets SET status = $1, approved_by = $2, updated_at = now() WHERE id = $3 RETURNING *`,
      [target, approvedBy, ts.id],
    );
    return res.json({ success: true, data: rows[0] });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE /api/timesheets/:id  — only unlocked timesheets
const deleteTimesheet = async (req, res) => {
  try {
    const ts = await getOwned(req.params.id);
    if (!ts) return res.status(404).json({ success: false, message: "Timesheet not found." });
    if (!canActOnEntity(req, ts.region_id)) {
      return res.status(403).json({ success: false, message: "Not authorized." });
    }
    if (["INVOICED", "APPROVED"].includes(ts.status)) {
      return res.status(400).json({ success: false, message: `A ${ts.status} timesheet can't be deleted.` });
    }
    await pool.query(`DELETE FROM timesheets WHERE id = $1`, [ts.id]);
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const dueDateFor = (invoiceDate, terms, customDays) => {
  const map = { NET_15: 15, NET_30: 30, NET_45: 45 };
  const days = terms === "CUSTOM" ? toNum(customDays) : (map[terms] != null ? map[terms] : 30);
  const d = new Date(`${invoiceDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// POST /api/timesheets/:id/create-invoice  — one-click invoice from an APPROVED timesheet.
// Reuses the real GL posting path (postInvoiceIssued) so the ledger stays consistent.
const createInvoiceFromTimesheet = async (req, res) => {
  const client = await pool.connect();
  try {
    const ts = await getOwned(req.params.id);
    if (!ts) return res.status(404).json({ success: false, message: "Timesheet not found." });
    if (!canActOnEntity(req, ts.region_id)) {
      return res.status(403).json({ success: false, message: "Not authorized." });
    }
    if (ts.status !== "APPROVED") {
      return res.status(400).json({ success: false, message: "Only an approved timesheet can be invoiced." });
    }
    const placement = await loadPlacement(ts.placement_id);

    const units = toNum(ts.units);
    const rate = toNum(ts.bill_rate);
    const subtotal = round2(units * rate);
    const taxable = placement.tax_applicable ? subtotal : 0;
    const taxAmount = round2(taxable * (toNum(placement.tax_percent) / 100));
    const total = round2(subtotal + taxAmount);
    const invoiceDate = new Date().toISOString().slice(0, 10);
    const dueDate = dueDateFor(invoiceDate, placement.payment_terms, placement.custom_payment_terms_days);

    await client.query("BEGIN");
    const invoiceNumber = await generateInvoiceNumber(client);
    const description = `${placement.job_title || "Services"} — ${String(ts.period_start).slice(0, 10)} to ${String(ts.period_end).slice(0, 10)} (${units} units)`;

    // invoice_type is stated explicitly rather than left to the column default:
    // a timesheet invoice is always a CLIENT invoice (it is placement-derived by
    // construction), and being explicit keeps this path readable next to
    // invoiceController's branch and pins it against a future default change.
    // Written unconditionally — migration 016 is a hard dependency of this path.
    const invIns = await client.query(
      `INSERT INTO invoices
         (invoice_number, invoice_type, placement_id, client_id, region_id, invoice_date, due_date,
          billing_period_start, billing_period_end, hours_or_units, bill_rate,
          subtotal, tax_amount, total_amount, currency, invoice_status,
          balance_outstanding, notes, created_by)
       VALUES ($1,'CLIENT',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'GENERATED',$15,$16,$17)
       RETURNING *`,
      [
        invoiceNumber, placement.id, placement.client_id, placement.region_id, invoiceDate, dueDate,
        ts.period_start, ts.period_end, units, rate,
        subtotal, taxAmount, total, ts.currency, total, req.body.notes || null, req.user?.id || null,
      ],
    );
    const invoice = invIns.rows[0];

    await client.query(
      `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, line_total)
       VALUES ($1,$2,$3,$4,$5)`,
      [invoice.id, description, units, rate, subtotal],
    );

    // Mirror the AR posting used by the normal invoice flow (best-effort: GL may be off).
    try {
      if (await glPosting.glAvailable(client)) {
        await glPosting.postInvoiceIssued(client, {
          ...invoice,
          subtotal,
          tax_amount: taxAmount,
          total_amount: total,
        });
      }
    } catch (glErr) {
      // Don't fail the invoice on a GL hiccup; surface it in the response.
      invoice._glWarning = glErr.message;
    }

    await client.query(
      `UPDATE timesheets SET status = 'INVOICED', invoice_id = $1, updated_at = now() WHERE id = $2`,
      [invoice.id, ts.id],
    );

    // Carry the client-approved timesheet proof (images/PDF) onto the invoice.
    let attachmentsCopied = 0;
    try {
      attachmentsCopied = await copyAttachments(client, "timesheet", ts.id, "invoice", invoice.id);
    } catch (attErr) {
      invoice._attachmentWarning = attErr.message;
    }

    await client.query("COMMIT");
    return res.status(201).json({
      success: true,
      data: {
        invoice_id: invoice.id, invoice_number: invoiceNumber, total, currency: ts.currency,
        attachments_copied: attachmentsCopied,
        glWarning: invoice._glWarning || null,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

module.exports = {
  listTimesheets,
  createTimesheet,
  updateTimesheet,
  setStatus,
  deleteTimesheet,
  createInvoiceFromTimesheet,
};
