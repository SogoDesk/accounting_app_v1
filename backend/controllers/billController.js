const pool = require("../config/db");
const { auditLog } = require("../middleware/auditMiddleware");
const { ensureApSchema } = require("../modules/ap/ensureApSchema");
const { generateBillNumber } = require("../utils/codeGenerator");
const glPosting = require("../services/gl/postingService");
const { canActOnEntity } = require("../middleware/scopeMiddleware");
const { sendReport } = require("../services/reports/reportExport");
const { convertToUsd } = require("../utils/fx");
const { groupCurrency, attachReportingFields } = require("../utils/reportingCurrency");

// Mirrors the BillsPage "Payment" column (derived from amounts, not approval).
const billPaymentStatus = (row) => {
  if (String(row?.bill_status || "").toUpperCase() === "CANCELLED") return "CANCELLED";
  const total = Number(row?.total_amount || 0);
  const outstanding = Number(row?.balance_outstanding || 0);
  const paid = Math.max(total - outstanding, 0);
  if (total > 0 && outstanding <= 0.005) return "PAID";
  if (paid > 0.005) return "PARTIALLY_PAID";
  return "UNPAID";
};

const ALLOWED_BILL_STATUSES = new Set(["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "PARTIALLY_PAID", "PAID", "OVERDUE", "CANCELLED"]);
const ALLOWED_APPROVAL_STATUSES = new Set(["NOT_SUBMITTED", "PENDING", "APPROVED", "REJECTED"]);

const toMoney = (value) => {
  const amount = Number(value || 0);
  return Number.isNaN(amount) ? 0 : amount;
};

const toNullable = (value) => {
  if (value === undefined || value === null || value === "") return null;
  return value;
};

const sanitizeDate = (value) => {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
};

const sanitizeTaxLines = (taxLines = []) => {
  if (!Array.isArray(taxLines)) return [];
  return taxLines
    .filter((line) => String(line?.tax_name || "").trim() || toMoney(line?.tax_percent) > 0)
    .map((line, index) => ({
      id: index + 1,
      tax_name: String(line.tax_name || "Tax").trim(),
      tax_percent: toMoney(line.tax_percent),
      tax_amount: toMoney(line.tax_amount),
    }));
};

const normalizeLineItems = (lineItems = []) => {
  if (!Array.isArray(lineItems) || !lineItems.length) {
    throw new Error("At least one bill line item is required");
  }

  const normalized = lineItems
    .map((item) => {
      const description = String(item.description || "").trim();
      const quantity = toMoney(item.quantity || 1);
      const unitPrice = toMoney(item.unit_price ?? item.rate);
      if (!description) return null;
      return {
        description,
        quantity: quantity > 0 ? quantity : 1,
        unit_price: unitPrice,
        line_total: Number((quantity > 0 ? quantity : 1) * unitPrice).toFixed(2),
        expense_category: toNullable(item.expense_category),
        cost_center: toNullable(item.cost_center),
      };
    })
    .filter(Boolean)
    .map((item) => ({
      ...item,
      line_total: Number(item.line_total),
    }));

  if (!normalized.length) {
    throw new Error("At least one valid bill line item is required");
  }

  return normalized;
};

const computeAmounts = (lineItems, taxLines = []) => {
  const subtotal = lineItems.reduce((sum, item) => sum + toMoney(item.line_total), 0);
  const computedTaxLines = sanitizeTaxLines(
    taxLines.map((line) => ({
      ...line,
      tax_amount: Number(((subtotal * toMoney(line.tax_percent)) / 100).toFixed(2)),
    })),
  );
  const taxAmount = computedTaxLines.reduce((sum, line) => sum + toMoney(line.tax_amount), 0);
  return {
    subtotal: Number(subtotal.toFixed(2)),
    taxAmount: Number(taxAmount.toFixed(2)),
    totalAmount: Number((subtotal + taxAmount).toFixed(2)),
    computedTaxLines,
  };
};

const deriveBillStatus = ({ currentStatus, approvalStatus, totalAmount, paidAmount, dueDate }) => {
  const normalizedCurrent = String(currentStatus || "").toUpperCase();
  if (normalizedCurrent === "CANCELLED") return "CANCELLED";
  if (toMoney(totalAmount) > 0 && toMoney(paidAmount) >= toMoney(totalAmount)) return "PAID";
  if (toMoney(paidAmount) > 0 && toMoney(paidAmount) < toMoney(totalAmount)) return "PARTIALLY_PAID";
  if (String(approvalStatus || "").toUpperCase() === "REJECTED") return "REJECTED";
  if (String(approvalStatus || "").toUpperCase() === "PENDING") return "SUBMITTED";
  if (String(approvalStatus || "").toUpperCase() === "APPROVED") {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = dueDate ? new Date(dueDate) : null;
    if (due && !Number.isNaN(due.getTime())) {
      due.setHours(0, 0, 0, 0);
      if (due < today) return "OVERDUE";
    }
    return "APPROVED";
  }
  return normalizedCurrent || "DRAFT";
};

const getApprovalHistory = async (db, billId) => {
  const result = await db.query(
    `
    SELECT ba.*, u.full_name AS acted_by_name
    FROM bill_approvals ba
    LEFT JOIN users u ON u.id = ba.acted_by
    WHERE ba.bill_id = $1
    ORDER BY ba.id ASC
    `,
    [billId],
  );
  return result.rows;
};

const getBillItems = async (db, billId) => {
  const result = await db.query(`SELECT * FROM bill_items WHERE bill_id = $1 ORDER BY id ASC`, [billId]);
  return result.rows;
};

const mapBill = async (db, row) => {
  const [items, approvals] = await Promise.all([getBillItems(db, row.id), getApprovalHistory(db, row.id)]);
  return {
    ...row,
    line_items: items,
    tax_lines: Array.isArray(row.tax_lines_json) ? row.tax_lines_json : [],
    approval_history: approvals,
  };
};

const recalculateBillBalances = async (db, billId) => {
  const billResult = await db.query(`SELECT * FROM bills WHERE id = $1 LIMIT 1`, [billId]);
  if (!billResult.rows.length) throw new Error("Bill not found");

  const bill = billResult.rows[0];
  const paymentResult = await db.query(
    `SELECT COALESCE(SUM(amount_paid), 0) AS paid_amount FROM vendor_payments WHERE bill_id = $1`,
    [billId],
  );

  const paidAmount = toMoney(paymentResult.rows[0]?.paid_amount || 0);
  const balanceOutstanding = Math.max(toMoney(bill.total_amount) - paidAmount, 0);
  const billStatus = deriveBillStatus({
    currentStatus: bill.bill_status,
    approvalStatus: bill.approval_status,
    totalAmount: bill.total_amount,
    paidAmount,
    dueDate: bill.due_date,
  });

  const result = await db.query(
    `
    UPDATE bills
    SET payment_paid_amount = $1,
        balance_outstanding = $2,
        bill_status = $3,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $4
    RETURNING *
    `,
    [paidAmount, balanceOutstanding, billStatus, billId],
  );

  return result.rows[0];
};

const getAllBills = async (req, res) => {
  try {
    await ensureApSchema();
    const { status, approval_status, vendor_id, region_id, search } = req.query;
    const conditions = ["b.deleted_at IS NULL"];
    const values = [];
    let idx = 1;

    if (status) {
      conditions.push(`b.bill_status = $${idx++}`);
      values.push(String(status).toUpperCase());
    }
    if (approval_status) {
      conditions.push(`b.approval_status = $${idx++}`);
      values.push(String(approval_status).toUpperCase());
    }
    if (vendor_id) {
      conditions.push(`b.vendor_id = $${idx++}`);
      values.push(Number(vendor_id));
    }
    if (region_id) {
      conditions.push(`b.region_id = $${idx++}`);
      values.push(Number(region_id));
    }
    // Row-level RBAC: restrict to the caller's allowed entities (regions).
    if (req.scopeEnforced && Array.isArray(req.allowedEntityIds)) {
      conditions.push(`b.region_id = ANY($${idx++})`);
      values.push(req.allowedEntityIds);
    }
    if (search) {
      conditions.push(`(b.bill_number ILIKE $${idx} OR v.vendor_name ILIKE $${idx} OR COALESCE(b.external_reference, '') ILIKE $${idx})`);
      values.push(`%${search}%`);
      idx += 1;
    }

    const result = await pool.query(
      `
      SELECT
        b.*,
        v.vendor_name,
        v.vendor_code,
        r.region_name,
        COUNT(bi.id)::int AS line_items_count
      FROM bills b
      JOIN vendors v ON v.id = b.vendor_id
      JOIN regions r ON r.id = b.region_id
      LEFT JOIN bill_items bi ON bi.bill_id = b.id
      WHERE ${conditions.join(" AND ")}
      GROUP BY b.id, v.vendor_name, v.vendor_code, r.region_name
      ORDER BY b.bill_date DESC, b.id DESC
      `,
      values,
    );

    // Consolidate mixed-currency figures into the company group currency so the
    // BillsPage/Dashboard KPIs can sum across regions without adding raw £+₹+$.
    // The *_reporting fields are ALWAYS group currency; a single-region view uses
    // the native fields instead (all one currency), decided on the client.
    const reportingCcy = await groupCurrency(pool);
    await attachReportingFields(
      result.rows,
      { total_amount: "total_amount_reporting", balance_outstanding: "balance_outstanding_reporting" },
      { db: pool, reportingCcy },
    );

    return res.json({ success: true, data: result.rows, reporting_currency: reportingCcy });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to fetch bills", error: error.message });
  }
};

const getBillById = async (req, res) => {
  try {
    await ensureApSchema();
    const result = await pool.query(
      `
      SELECT
        b.*,
        v.vendor_name,
        v.vendor_code,
        r.region_name
      FROM bills b
      JOIN vendors v ON v.id = b.vendor_id
      JOIN regions r ON r.id = b.region_id
      WHERE b.id = $1 AND b.deleted_at IS NULL
      LIMIT 1
      `,
      [req.params.id],
    );

    if (!result.rows.length || !canActOnEntity(req, result.rows[0].region_id)) {
      return res.status(404).json({ success: false, message: "Bill not found" });
    }

    return res.json({ success: true, data: await mapBill(pool, result.rows[0]) });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to fetch bill", error: error.message });
  }
};

const upsertBillItems = async (db, billId, lineItems) => {
  await db.query(`DELETE FROM bill_items WHERE bill_id = $1`, [billId]);
  for (const item of lineItems) {
    await db.query(
      `
      INSERT INTO bill_items (bill_id, description, quantity, unit_price, line_total, expense_category, cost_center)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      `,
      [
        billId,
        item.description,
        item.quantity,
        item.unit_price,
        item.line_total,
        toNullable(item.expense_category),
        toNullable(item.cost_center),
      ],
    );
  }
};

const createBill = async (req, res) => {
  const db = await pool.connect();
  try {
    await ensureApSchema(db);

    const {
      bill_number,
      vendor_id,
      region_id,
      bill_date,
      due_date,
      service_period_start,
      service_period_end,
      currency,
      invoice_reference,
      external_reference,
      notes,
      tax_lines = [],
      line_items = [],
    } = req.body;

    if (!vendor_id || !region_id || !bill_date || !due_date) {
      return res.status(400).json({ success: false, message: "Vendor, region, bill date, and due date are required" });
    }

    // Row-level RBAC: never trust a body-supplied region_id outside the caller's scope.
    if (!canActOnEntity(req, region_id)) {
      return res.status(403).json({ success: false, message: "Not authorized for this entity (region)" });
    }

    const normalizedLineItems = normalizeLineItems(line_items);
    const { subtotal, taxAmount, totalAmount, computedTaxLines } = computeAmounts(normalizedLineItems, Array.isArray(tax_lines) ? tax_lines : []);
    const finalBillNumber = bill_number?.trim() ? bill_number.trim().toUpperCase() : await generateBillNumber(db);

    const duplicate = await db.query(`SELECT id FROM bills WHERE bill_number = $1 LIMIT 1`, [finalBillNumber]);
    if (duplicate.rows.length) {
      return res.status(400).json({ success: false, message: "Bill number already exists" });
    }

    await db.query("BEGIN");

    const headerResult = await db.query(
      `
      INSERT INTO bills (
        bill_number, vendor_id, region_id, bill_date, due_date, service_period_start, service_period_end,
        subtotal, tax_amount, total_amount, currency, bill_status, approval_status,
        payment_paid_amount, balance_outstanding, invoice_reference, external_reference, notes, tax_lines_json, created_by
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'DRAFT','NOT_SUBMITTED',0,$10,$12,$13,$14,$15,$16)
      RETURNING *
      `,
      [
        finalBillNumber,
        Number(vendor_id),
        Number(region_id),
        sanitizeDate(bill_date),
        sanitizeDate(due_date),
        sanitizeDate(service_period_start),
        sanitizeDate(service_period_end),
        subtotal,
        taxAmount,
        totalAmount,
        String(currency || "USD").toUpperCase(),
        toNullable(invoice_reference),
        toNullable(external_reference),
        toNullable(notes),
        computedTaxLines,
        req.user?.id || null,
      ],
    );

    const createdBill = headerResult.rows[0];
    await upsertBillItems(db, createdBill.id, normalizedLineItems);

    await db.query("COMMIT");

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "CREATE",
      entityType: "bills",
      entityId: createdBill.id,
      newValues: createdBill,
      ipAddress: req.ip,
    });

    return res.status(201).json({ success: true, message: "Bill created", data: await mapBill(pool, createdBill) });
  } catch (error) {
    try { await db.query("ROLLBACK"); } catch (_error) {}
    return res.status(500).json({ success: false, message: error.message || "Failed to create bill", error: error.message });
  } finally {
    db.release();
  }
};

// Keep the GL in sync with a bill's current state. A bill only posts once it is
// APPROVED, so this reverses any live AP entry and (for a repost) re-posts with
// the new amounts — mirroring the invoice/expense reverse+repost pattern. Safe
// on unposted bills (no entries to reverse) and idempotent.
//   mode "repost" — edit: reverse then repost if still approved
//   mode "cancel" — delete/reject: reverse only
//   mode "ensure" — post if approved and not yet posted
const syncBillGl = async (db, bill, userId, mode) => {
  if (!(await glPosting.glAvailable(db))) return;
  const posted = await glPosting.postedEntryIds("AP_BILL", bill.id, db);
  const postable = String(bill.approval_status || "").toUpperCase() === "APPROVED";
  const reverseAll = async (reason) => {
    for (const entry of posted) await glPosting.reverseEntry(db, entry.id, reason, userId);
  };
  if (mode === "cancel") { await reverseAll("Bill deleted"); return; }
  if (mode === "repost") {
    await reverseAll("Bill edited");
    if (postable) await glPosting.postBillEntered(db, bill);
    return;
  }
  if (!posted.length && postable) await glPosting.postBillEntered(db, bill); // ensure
};

const updateBill = async (req, res) => {
  const db = await pool.connect();
  try {
    await ensureApSchema(db);
    const { id } = req.params;
    const existingResult = await db.query(`SELECT * FROM bills WHERE id = $1 AND deleted_at IS NULL LIMIT 1`, [Number(id)]);
    if (!existingResult.rows.length || !canActOnEntity(req, existingResult.rows[0].region_id)) {
      return res.status(404).json({ success: false, message: "Bill not found" });
    }

    const existing = existingResult.rows[0];
    if (["PAID", "CANCELLED"].includes(String(existing.bill_status || "").toUpperCase())) {
      return res.status(400).json({ success: false, message: "Paid or cancelled bills cannot be edited" });
    }

    const payload = req.body;
    if (payload.region_id != null && !canActOnEntity(req, payload.region_id)) {
      return res.status(403).json({ success: false, message: "Not authorized to assign bills to this region" });
    }
    const normalizedLineItems = normalizeLineItems(payload.line_items || []);
    const { subtotal, taxAmount, totalAmount, computedTaxLines } = computeAmounts(normalizedLineItems, Array.isArray(payload.tax_lines) ? payload.tax_lines : []);
    const finalBillNumber = payload.bill_number?.trim()
      ? payload.bill_number.trim().toUpperCase()
      : existing.bill_number;

    const duplicate = await db.query(`SELECT id FROM bills WHERE bill_number = $1 AND id <> $2 LIMIT 1`, [finalBillNumber, Number(id)]);
    if (duplicate.rows.length) {
      return res.status(400).json({ success: false, message: "Bill number already exists" });
    }

    await db.query("BEGIN");

    const result = await db.query(
      `
      UPDATE bills
      SET bill_number = $1,
          vendor_id = $2,
          region_id = $3,
          bill_date = $4,
          due_date = $5,
          service_period_start = $6,
          service_period_end = $7,
          subtotal = $8,
          tax_amount = $9,
          total_amount = $10,
          currency = $11,
          invoice_reference = $12,
          external_reference = $13,
          notes = $14,
          tax_lines_json = $15,
          balance_outstanding = GREATEST($10 - COALESCE(payment_paid_amount, 0), 0),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $16
      RETURNING *
      `,
      [
        finalBillNumber,
        Number(payload.vendor_id),
        Number(payload.region_id),
        sanitizeDate(payload.bill_date),
        sanitizeDate(payload.due_date),
        sanitizeDate(payload.service_period_start),
        sanitizeDate(payload.service_period_end),
        subtotal,
        taxAmount,
        totalAmount,
        String(payload.currency || existing.currency || "USD").toUpperCase(),
        toNullable(payload.invoice_reference),
        toNullable(payload.external_reference),
        toNullable(payload.notes),
        computedTaxLines,
        Number(id),
      ],
    );

    await upsertBillItems(db, Number(id), normalizedLineItems);
    const updatedBill = await recalculateBillBalances(db, Number(id));

    // If this bill was already approved (and thus posted), reverse the old GL
    // entry and re-post with the new amounts so the ledger tracks the edit.
    await syncBillGl(db, updatedBill, req.user?.id || null, "repost");

    await db.query("COMMIT");

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "UPDATE",
      entityType: "bills",
      entityId: Number(id),
      oldValues: existing,
      newValues: updatedBill,
      ipAddress: req.ip,
    });

    return res.json({ success: true, message: "Bill updated", data: await mapBill(pool, updatedBill) });
  } catch (error) {
    try { await db.query("ROLLBACK"); } catch (_error) {}
    return res.status(500).json({ success: false, message: error.message || "Failed to update bill", error: error.message });
  } finally {
    db.release();
  }
};

const updateBillStatus = async (req, res) => {
  const db = await pool.connect();
  try {
    await ensureApSchema(db);
    const { id } = req.params;
    const requestedStatus = String(req.body.status || req.body.bill_status || "").toUpperCase();
    const comments = toNullable(req.body.comments);

    if (!ALLOWED_BILL_STATUSES.has(requestedStatus)) {
      return res.status(400).json({ success: false, message: "Invalid bill status" });
    }

    const existingResult = await db.query(`SELECT * FROM bills WHERE id = $1 AND deleted_at IS NULL LIMIT 1`, [Number(id)]);
    if (!existingResult.rows.length || !canActOnEntity(req, existingResult.rows[0].region_id)) {
      return res.status(404).json({ success: false, message: "Bill not found" });
    }
    const existing = existingResult.rows[0];

    let approvalStatus = existing.approval_status;
    let approvedBy = existing.approved_by;
    let approvedAt = existing.approved_at;

    if (requestedStatus === "SUBMITTED") approvalStatus = "PENDING";
    if (requestedStatus === "APPROVED") {
      approvalStatus = "APPROVED";
      approvedBy = req.user?.id || null;
      approvedAt = new Date();
    }
    if (requestedStatus === "REJECTED") approvalStatus = "REJECTED";

    if (!ALLOWED_APPROVAL_STATUSES.has(String(approvalStatus).toUpperCase())) {
      approvalStatus = "NOT_SUBMITTED";
    }

    await db.query("BEGIN");

    const result = await db.query(
      `
      UPDATE bills
      SET bill_status = $1,
          approval_status = $2,
          approved_by = $3,
          approved_at = $4,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $5
      RETURNING *
      `,
      [requestedStatus, approvalStatus, approvedBy, approvedAt, Number(id)],
    );

    const currentStepResult = await db.query(`SELECT COALESCE(MAX(step_no), 0) + 1 AS next_step FROM bill_approvals WHERE bill_id = $1`, [Number(id)]);
    await db.query(
      `
      INSERT INTO bill_approvals (bill_id, step_no, action, comments, acted_by)
      VALUES ($1,$2,$3,$4,$5)
      `,
      [Number(id), Number(currentStepResult.rows[0]?.next_step || 1), requestedStatus, comments, req.user?.id || null],
    );

    const updatedBill = await recalculateBillBalances(db, Number(id));

    // Keep the GL aligned with the approval state, atomically: APPROVED posts the
    // payable; moving out of APPROVED (rejected / re-submitted) reverses it.
    // "repost" reverses any live entry, then re-posts only if still approved.
    await syncBillGl(db, updatedBill, req.user?.id || null, "repost");

    await db.query("COMMIT");

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "UPDATE_STATUS",
      entityType: "bills",
      entityId: Number(id),
      oldValues: existing,
      newValues: updatedBill,
      ipAddress: req.ip,
    });

    return res.json({ success: true, message: "Bill status updated", data: await mapBill(pool, updatedBill) });
  } catch (error) {
    try { await db.query("ROLLBACK"); } catch (_error) {}
    return res.status(500).json({ success: false, message: "Failed to update bill status", error: error.message });
  } finally {
    db.release();
  }
};

const deleteBill = async (req, res) => {
  const db = await pool.connect();
  try {
    await ensureApSchema(db);
    const { id } = req.params;
    const existingBill = await db.query(`SELECT * FROM bills WHERE id = $1 AND deleted_at IS NULL LIMIT 1`, [Number(id)]);
    if (!existingBill.rows.length || !canActOnEntity(req, existingBill.rows[0].region_id)) {
      return res.status(404).json({ success: false, message: "Bill not found" });
    }
    const paymentCount = await db.query(`SELECT COUNT(*)::int AS count FROM vendor_payments WHERE bill_id = $1`, [Number(id)]);
    if (Number(paymentCount.rows[0]?.count || 0) > 0) {
      return res.status(400).json({ success: false, message: "Cannot delete bill with linked payments" });
    }

    await db.query("BEGIN");

    // Reverse any live AP entry so the ledger stays balanced (posted+reversal
    // pair is retained for audit), then soft-delete — atomically.
    await syncBillGl(db, existingBill.rows[0], req.user?.id || null, "cancel");

    const result = await db.query(
      `
      UPDATE bills
      SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING *
      `,
      [Number(id)],
    );

    if (!result.rows.length) {
      await db.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Bill not found" });
    }

    await db.query("COMMIT");

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "DELETE",
      entityType: "bills",
      entityId: Number(id),
      oldValues: result.rows[0],
      ipAddress: req.ip,
    });

    return res.json({ success: true, message: "Bill deleted" });
  } catch (error) {
    try { await db.query("ROLLBACK"); } catch (_error) {}
    return res.status(500).json({ success: false, message: "Failed to delete bill", error: error.message });
  } finally {
    db.release();
  }
};

// GET /api/bills/export?format=xlsx&from=&to=&status=&approval_status=&region_id=&vendor_id=&search=
// status here is the derived PAYMENT status (UNPAID/PARTIALLY_PAID/PAID/CANCELLED).
const exportBills = async (req, res) => {
  try {
    await ensureApSchema();
    const { status, approval_status, vendor_id, region_id, search, from, to } = req.query;
    const conditions = ["b.deleted_at IS NULL"];
    const values = [];
    let idx = 1;
    if (approval_status) { conditions.push(`b.approval_status = $${idx++}`); values.push(String(approval_status).toUpperCase()); }
    if (vendor_id) { conditions.push(`b.vendor_id = $${idx++}`); values.push(Number(vendor_id)); }
    if (region_id) { conditions.push(`b.region_id = $${idx++}`); values.push(Number(region_id)); }
    if (from) { conditions.push(`b.bill_date >= $${idx++}`); values.push(from); }
    if (to) { conditions.push(`b.bill_date <= $${idx++}`); values.push(to); }
    if (req.scopeEnforced && Array.isArray(req.allowedEntityIds)) { conditions.push(`b.region_id = ANY($${idx++})`); values.push(req.allowedEntityIds); }
    if (search) {
      conditions.push(`(b.bill_number ILIKE $${idx} OR v.vendor_name ILIKE $${idx} OR COALESCE(b.external_reference, '') ILIKE $${idx})`);
      values.push(`%${search}%`); idx += 1;
    }
    const result = await pool.query(
      `SELECT b.*, v.vendor_name, r.region_name
         FROM bills b JOIN vendors v ON v.id = b.vendor_id JOIN regions r ON r.id = b.region_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY b.bill_date DESC, b.id DESC`, values);

    const wantStatus = status ? String(status).toUpperCase() : "";
    const cache = new Map();
    let totalUsd = 0;
    const rows = [];
    for (const r of result.rows) {
      const ps = billPaymentStatus(r);
      if (wantStatus && ps !== wantStatus) continue;
      const tUsd = await convertToUsd(r.total_amount, r.currency, cache);
      totalUsd += tUsd;
      rows.push({
        bill_date: String(r.bill_date).slice(0, 10),
        bill_number: r.bill_number,
        vendor_name: r.vendor_name,
        region_name: r.region_name,
        due_date: r.due_date ? String(r.due_date).slice(0, 10) : "",
        currency: r.currency,
        total_amount: Number(r.total_amount || 0),
        balance_outstanding: Number(r.balance_outstanding || 0),
        total_usd: tUsd,
        payment_status: ps,
        approval_status: r.approval_status,
      });
    }
    const rangeLabel = (from || to) ? `${from || "…"} to ${to || "…"}` : "All dates";
    const report = {
      title: "Bills",
      subtitle: `${rangeLabel} · ${rows.length} bill(s) · total in USD (consolidated)`,
      columns: [
        { key: "bill_date", label: "Date", type: "text" },
        { key: "bill_number", label: "Bill #", type: "text" },
        { key: "vendor_name", label: "Vendor", type: "text" },
        { key: "region_name", label: "Location", type: "text" },
        { key: "due_date", label: "Due", type: "text" },
        { key: "currency", label: "Currency", type: "text" },
        { key: "total_amount", label: "Total", type: "money" },
        { key: "balance_outstanding", label: "Outstanding", type: "money" },
        { key: "total_usd", label: "Total (USD)", type: "money" },
        { key: "payment_status", label: "Payment", type: "text" },
        { key: "approval_status", label: "Approval", type: "text" },
      ],
      rows,
      totals: { total_usd: Math.round(totalUsd * 100) / 100 },
    };
    return await sendReport(res, report, req.query.format || "xlsx");
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to export bills", error: error.message });
  }
};

const downloadBillPdf = async (req, res) => {
  try {
    await ensureApSchema();
    const result = await pool.query(
      `SELECT b.*, v.vendor_name, v.vendor_code, r.region_name
         FROM bills b
         JOIN vendors v ON v.id = b.vendor_id
         JOIN regions r ON r.id = b.region_id
        WHERE b.id = $1 AND b.deleted_at IS NULL LIMIT 1`,
      [req.params.id],
    );
    if (!result.rows.length || !canActOnEntity(req, result.rows[0].region_id)) {
      return res.status(404).json({ success: false, message: "Bill not found" });
    }
    const bill = await mapBill(pool, result.rows[0]);
    const { generateBillPdf } = require("../utils/billPdf");
    return generateBillPdf(bill, res);
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to generate bill PDF", error: error.message });
  }
};

module.exports = {
  getAllBills,
  exportBills,
  getBillById,
  downloadBillPdf,
  createBill,
  updateBill,
  updateBillStatus,
  deleteBill,
  recalculateBillBalances,
};
