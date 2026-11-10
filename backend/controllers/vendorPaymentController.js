const pool = require("../config/db");
const { auditLog } = require("../middleware/auditMiddleware");
const { ensureApSchema } = require("../modules/ap/ensureApSchema");
const { recalculateBillBalances } = require("./billController");
const glPosting = require("../services/gl/postingService");
const { generateVendorPaymentCode, generateVendorPaymentReference } = require("../utils/codeGenerator");
const { canActOnEntity } = require("../middleware/scopeMiddleware");
const { groupCurrency, attachReportingFields } = require("../utils/reportingCurrency");

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

const fetchBillOptions = async (db) => db.query(
  `
  SELECT
    b.id,
    b.bill_number,
    b.bill_date,
    b.due_date,
    b.bill_status,
    b.approval_status,
    b.total_amount,
    b.payment_paid_amount,
    b.balance_outstanding,
    b.currency,
    b.vendor_id,
    b.region_id,
    v.vendor_name,
    r.region_name
  FROM bills b
  JOIN vendors v ON v.id = b.vendor_id
  JOIN regions r ON r.id = b.region_id
  WHERE b.deleted_at IS NULL
    AND b.bill_status <> 'CANCELLED'
  ORDER BY b.bill_date DESC, b.id DESC
  `,
);

const getAllVendorPayments = async (req, res) => {
  try {
    await ensureApSchema();
    const { search = "", bill_id = "", vendor_id = "", payment_method = "" } = req.query;
    const conditions = [];
    const values = [];
    let idx = 1;

    if (bill_id) {
      conditions.push(`vp.bill_id = $${idx++}`);
      values.push(Number(bill_id));
    }
    if (vendor_id) {
      conditions.push(`b.vendor_id = $${idx++}`);
      values.push(Number(vendor_id));
    }
    if (payment_method) {
      conditions.push(`UPPER(COALESCE(vp.payment_method, '')) = $${idx++}`);
      values.push(String(payment_method).toUpperCase());
    }
    if (search) {
      conditions.push(`(COALESCE(vp.payment_code, '') ILIKE $${idx} OR b.bill_number ILIKE $${idx} OR v.vendor_name ILIKE $${idx} OR COALESCE(vp.reference_number, '') ILIKE $${idx})`);
      values.push(`%${search}%`);
      idx += 1;
    }

    // Row-level RBAC: restrict to vendor payments on bills in the caller's entities.
    if (req.scopeEnforced && Array.isArray(req.allowedEntityIds)) {
      conditions.push(`b.region_id = ANY($${idx++})`);
      values.push(req.allowedEntityIds);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await pool.query(
      `
      SELECT
        vp.*,
        b.bill_number,
        b.bill_status,
        b.total_amount AS bill_total_amount,
        b.balance_outstanding AS bill_balance_outstanding,
        b.currency,
        b.region_id,
        v.vendor_name,
        r.region_name,
        u.full_name AS created_by_name
      FROM vendor_payments vp
      JOIN bills b ON b.id = vp.bill_id
      JOIN vendors v ON v.id = b.vendor_id
      JOIN regions r ON r.id = b.region_id
      LEFT JOIN users u ON u.id = vp.created_by
      ${where}
      ORDER BY vp.payment_date DESC, vp.id DESC
      `,
      values,
    );

    // Consolidate to the company group currency for cross-region KPI sums.
    const reportingCcy = await groupCurrency(pool);
    await attachReportingFields(
      result.rows,
      { amount_paid: "amount_paid_reporting" },
      { db: pool, reportingCcy },
    );

    return res.json({ success: true, data: result.rows, reporting_currency: reportingCcy });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to fetch vendor payments", error: error.message });
  }
};

const getVendorPaymentById = async (req, res) => {
  try {
    await ensureApSchema();
    const result = await pool.query(
      `
      SELECT
        vp.*,
        b.bill_number,
        b.bill_status,
        b.total_amount AS bill_total_amount,
        b.balance_outstanding AS bill_balance_outstanding,
        b.currency,
        b.region_id,
        v.vendor_name,
        r.region_name
      FROM vendor_payments vp
      JOIN bills b ON b.id = vp.bill_id
      JOIN vendors v ON v.id = b.vendor_id
      JOIN regions r ON r.id = b.region_id
      WHERE vp.id = $1
      LIMIT 1
      `,
      [Number(req.params.id)],
    );

    if (!result.rows.length || !canActOnEntity(req, result.rows[0].region_id)) {
      return res.status(404).json({ success: false, message: "Vendor payment not found" });
    }

    return res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to fetch vendor payment", error: error.message });
  }
};

const getVendorPaymentBillOptions = async (req, res) => {
  try {
    await ensureApSchema();
    const result = await fetchBillOptions(pool);
    return res.json({ success: true, data: result.rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to load bill options", error: error.message });
  }
};

// GET /vendor-payments/next-code — pre-fill the modal like AR's /payments/next-code.
const getNextVendorPaymentCode = async (req, res) => {
  try {
    await ensureApSchema();
    const [payment_code, reference_number] = await Promise.all([
      generateVendorPaymentCode(pool),
      generateVendorPaymentReference(pool),
    ]);
    return res.json({ success: true, data: { payment_code, reference_number } });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to generate next code", error: error.message });
  }
};

const createVendorPayment = async (req, res) => {
  const db = await pool.connect();
  try {
    await ensureApSchema(db);
    const {
      payment_code,
      bill_id,
      bill_ids,
      payment_date,
      amount_paid,
      payment_method,
      reference_number,
      notes,
    } = req.body;

    // One disbursement can settle several approved bills (mirrors AR multi-invoice receipts).
    const targetBillIds = Array.from(new Set(
      (Array.isArray(bill_ids) && bill_ids.length ? bill_ids : [bill_id])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0),
    ));

    const finalDate = sanitizeDate(payment_date);
    if (!targetBillIds.length || !finalDate) {
      return res.status(400).json({ success: false, message: "At least one bill and payment date are required" });
    }

    await db.query("BEGIN");

    // Lock all target bills for the txn so concurrent payments can't over-pay.
    await db.query(`SELECT id FROM bills WHERE id = ANY($1) FOR UPDATE`, [targetBillIds]);

    const bills = [];
    for (const id of targetBillIds) {
      const r = await db.query(`SELECT * FROM bills WHERE id = $1 AND deleted_at IS NULL LIMIT 1`, [id]);
      if (!r.rows.length) {
        await db.query("ROLLBACK");
        return res.status(404).json({ success: false, message: `Bill ${id} not found` });
      }
      const bill = r.rows[0];
      if (!canActOnEntity(req, bill.region_id)) {
        await db.query("ROLLBACK");
        return res.status(403).json({ success: false, message: "Not authorized for this entity (region)" });
      }
      if (String(bill.approval_status || "").toUpperCase() !== "APPROVED") {
        await db.query("ROLLBACK");
        return res.status(400).json({ success: false, message: `Bill ${bill.bill_number} is not approved` });
      }
      bills.push(bill);
    }

    // All bills in one payment must share a currency.
    const currencies = Array.from(new Set(bills.map((b) => String(b.currency || "USD").toUpperCase())));
    if (currencies.length > 1) {
      await db.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "Selected bills must use the same currency for one payment" });
    }

    const credits = bills.map((bill) => ({ bill, maxCash: Math.max(toMoney(bill.balance_outstanding), 0) }));
    const suggestedTotal = credits.reduce((s, c) => s + c.maxCash, 0);
    let remaining = (amount_paid !== undefined && amount_paid !== "") ? toMoney(amount_paid) : suggestedTotal;

    if (remaining <= 0) {
      await db.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "Amount paid must be greater than zero" });
    }
    if (remaining > suggestedTotal + 0.005) {
      await db.query("ROLLBACK");
      return res.status(400).json({ success: false, message: `Amount cannot exceed total outstanding of ${suggestedTotal.toFixed(2)}` });
    }

    const finalReference = reference_number && String(reference_number).trim()
      ? String(reference_number).trim().toUpperCase()
      : await generateVendorPaymentReference(db);
    const userCode = payment_code && String(payment_code).trim() ? String(payment_code).trim().toUpperCase() : null;

    const createdPayments = [];
    const updatedBills = [];
    for (let i = 0; i < credits.length; i += 1) {
      const { bill, maxCash } = credits[i];
      const cashAmount = Number(Math.min(maxCash, remaining).toFixed(2));
      remaining = Number((remaining - cashAmount).toFixed(2));
      if (cashAmount <= 0) continue;

      // First row may take the user-supplied code; the rest auto-generate.
      let codeForRow = (i === 0 && userCode) ? userCode : await generateVendorPaymentCode(db);
      const dup = await db.query(`SELECT id FROM vendor_payments WHERE payment_code = $1 LIMIT 1`, [codeForRow]);
      if (dup.rows.length) codeForRow = await generateVendorPaymentCode(db);

      const inserted = await db.query(
        `
        INSERT INTO vendor_payments (payment_code, bill_id, payment_date, amount_paid, payment_method, reference_number, notes, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING *
        `,
        [
          codeForRow,
          bill.id,
          finalDate,
          cashAmount,
          toNullable(payment_method),
          finalReference,
          toNullable(notes),
          req.user?.id || null,
        ],
      );
      const vpRow = inserted.rows[0];
      createdPayments.push(vpRow);

      // Post the disbursement → Dr Accounts Payable, Cr Bank (with realized FX).
      if (await glPosting.glAvailable(db)) {
        await glPosting.postVendorPayment(db, {
          id: vpRow.id,
          bill_id: bill.id,
          payment_date: vpRow.payment_date,
          amount_paid: vpRow.amount_paid,
          currency: bill.currency,
          payment_code: vpRow.payment_code,
          created_by: req.user?.id || null,
        }, bill);
      }

      updatedBills.push(await recalculateBillBalances(db, bill.id));
    }

    if (!createdPayments.length) {
      await db.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "No payable balance found on the selected bills" });
    }

    await db.query("COMMIT");

    for (const payment of createdPayments) {
      await auditLog({
        userId: req.user?.id,
        userEmail: req.user?.email,
        action: "CREATE_PAYMENT",
        entityType: "vendor_payments",
        entityId: payment.id,
        newValues: payment,
        ipAddress: req.ip,
      });
    }

    return res.status(201).json({
      success: true,
      message: createdPayments.length > 1 ? `${createdPayments.length} vendor payments created` : "Vendor payment created",
      data: { payment: createdPayments[0], payments: createdPayments, bills: updatedBills, bill: updatedBills[0] },
    });
  } catch (error) {
    try { await db.query("ROLLBACK"); } catch (_error) {}
    return res.status(500).json({ success: false, message: "Failed to create vendor payment", error: error.message });
  } finally {
    db.release();
  }
};

const updateVendorPayment = async (req, res) => {
  const db = await pool.connect();
  try {
    await ensureApSchema(db);
    const { id } = req.params;
    const existingResult = await db.query(`SELECT * FROM vendor_payments WHERE id = $1 LIMIT 1`, [Number(id)]);
    if (!existingResult.rows.length) {
      return res.status(404).json({ success: false, message: "Vendor payment not found" });
    }
    const existing = existingResult.rows[0];
    const targetBillId = Number(req.body.bill_id || existing.bill_id);
    const billResult = await db.query(`SELECT * FROM bills WHERE id = $1 AND deleted_at IS NULL LIMIT 1`, [targetBillId]);
    if (!billResult.rows.length) {
      return res.status(404).json({ success: false, message: "Bill not found" });
    }
    const bill = billResult.rows[0];
    if (!canActOnEntity(req, bill.region_id)) {
      return res.status(403).json({ success: false, message: "Not authorized for this bill's entity" });
    }

    const otherPaymentsResult = await db.query(
      `SELECT COALESCE(SUM(amount_paid), 0) AS paid_amount FROM vendor_payments WHERE bill_id = $1 AND id <> $2`,
      [targetBillId, Number(id)],
    );
    const otherPayments = toMoney(otherPaymentsResult.rows[0]?.paid_amount || 0);
    const finalAmount = toMoney(req.body.amount_paid ?? existing.amount_paid);
    const allowedMax = Math.max(toMoney(bill.total_amount) - otherPayments, 0);
    if (finalAmount <= 0 || finalAmount > allowedMax) {
      return res.status(400).json({ success: false, message: `Amount must be between 0.01 and ${allowedMax.toFixed(2)}` });
    }

    await db.query("BEGIN");
    const result = await db.query(
      `
      UPDATE vendor_payments
      SET payment_code = $1,
          bill_id = $2,
          payment_date = $3,
          amount_paid = $4,
          payment_method = $5,
          reference_number = $6,
          notes = $7,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $8
      RETURNING *
      `,
      [
        String(req.body.payment_code || existing.payment_code || "").trim().toUpperCase(),
        targetBillId,
        sanitizeDate(req.body.payment_date || existing.payment_date),
        finalAmount,
        toNullable(req.body.payment_method ?? existing.payment_method),
        toNullable(req.body.reference_number ?? existing.reference_number),
        toNullable(req.body.notes ?? existing.notes),
        Number(id),
      ],
    );

    if (Number(existing.bill_id) !== targetBillId) {
      await recalculateBillBalances(db, Number(existing.bill_id));
    }
    const updatedBill = await recalculateBillBalances(db, targetBillId);

    // Re-sync the GL: reverse the prior disbursement entry, re-post at new amounts.
    if (await glPosting.glAvailable(db)) {
      const posted = await glPosting.postedEntryIds("AP_PAYMENT", Number(id), db);
      for (const e of posted) await glPosting.reverseEntry(db, e.id, "Vendor payment edited", req.user?.id || null);
      const vp = result.rows[0];
      await glPosting.postVendorPayment(db, {
        id: vp.id, bill_id: targetBillId, payment_date: vp.payment_date, amount_paid: vp.amount_paid,
        currency: bill.currency, payment_code: vp.payment_code, created_by: req.user?.id || null,
      }, bill);
    }

    await db.query("COMMIT");

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "UPDATE_PAYMENT",
      entityType: "vendor_payments",
      entityId: Number(id),
      oldValues: existing,
      newValues: result.rows[0],
      ipAddress: req.ip,
    });

    return res.json({ success: true, message: "Vendor payment updated", data: { payment: result.rows[0], bill: updatedBill } });
  } catch (error) {
    try { await db.query("ROLLBACK"); } catch (_error) {}
    return res.status(500).json({ success: false, message: "Failed to update vendor payment", error: error.message });
  } finally {
    db.release();
  }
};

const deleteVendorPayment = async (req, res) => {
  const db = await pool.connect();
  try {
    await ensureApSchema(db);
    const { id } = req.params;
    const existingResult = await db.query(
      `SELECT vp.*, b.region_id FROM vendor_payments vp JOIN bills b ON b.id = vp.bill_id WHERE vp.id = $1 LIMIT 1`,
      [Number(id)],
    );
    if (!existingResult.rows.length || !canActOnEntity(req, existingResult.rows[0].region_id)) {
      return res.status(404).json({ success: false, message: "Vendor payment not found" });
    }
    const existing = existingResult.rows[0];

    await db.query("BEGIN");
    // Reverse the disbursement's ledger entry so the GL stays balanced on delete.
    if (await glPosting.glAvailable(db)) {
      const posted = await glPosting.postedEntryIds("AP_PAYMENT", Number(id), db);
      for (const e of posted) await glPosting.reverseEntry(db, e.id, "Vendor payment deleted", req.user?.id || null);
    }
    await db.query(`DELETE FROM vendor_payments WHERE id = $1`, [Number(id)]);
    const updatedBill = await recalculateBillBalances(db, Number(existing.bill_id));
    await db.query("COMMIT");

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "DELETE_PAYMENT",
      entityType: "vendor_payments",
      entityId: Number(id),
      oldValues: existing,
      ipAddress: req.ip,
    });

    return res.json({ success: true, message: "Vendor payment deleted", data: { bill: updatedBill } });
  } catch (error) {
    try { await db.query("ROLLBACK"); } catch (_error) {}
    return res.status(500).json({ success: false, message: "Failed to delete vendor payment", error: error.message });
  } finally {
    db.release();
  }
};

const downloadVendorPaymentReceipt = async (req, res) => {
  try {
    await ensureApSchema();
    const result = await pool.query(
      `SELECT vp.*, b.bill_number, b.bill_status, b.total_amount AS bill_total_amount,
              b.balance_outstanding AS bill_balance_outstanding, b.currency, b.region_id,
              v.vendor_name, r.region_name
         FROM vendor_payments vp
         JOIN bills b ON b.id = vp.bill_id
         JOIN vendors v ON v.id = b.vendor_id
         JOIN regions r ON r.id = b.region_id
        WHERE vp.id = $1 LIMIT 1`,
      [Number(req.params.id)],
    );
    const payment = result.rows[0];
    if (!payment || !canActOnEntity(req, payment.region_id)) {
      return res.status(404).json({ success: false, message: "Vendor payment not found" });
    }
    const { generateVendorPaymentReceiptPdf } = require("../utils/vendorPaymentReceiptPdf");
    return generateVendorPaymentReceiptPdf(payment, res);
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to generate payment voucher", error: error.message });
  }
};

module.exports = {
  getAllVendorPayments,
  getVendorPaymentById,
  downloadVendorPaymentReceipt,
  getVendorPaymentBillOptions,
  getNextVendorPaymentCode,
  createVendorPayment,
  updateVendorPayment,
  deleteVendorPayment,
};
