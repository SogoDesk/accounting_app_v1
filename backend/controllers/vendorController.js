const pool = require("../config/db");
const { auditLog } = require("../middleware/auditMiddleware");
const { generateVendorCode } = require("../utils/codeGenerator");
const { ensureApSchema } = require("../modules/ap/ensureApSchema");
const { canActOnEntity } = require("../middleware/scopeMiddleware");

const toNullable = (value) => {
  if (value === undefined || value === null || value === "") return null;
  return value;
};

const sanitizeVendorRecord = (vendor = {}) => vendor;

const getAllVendors = async (req, res) => {
  try {
    await ensureApSchema();
    const { status, region_id, search } = req.query;
    const conditions = ["v.deleted_at IS NULL"];
    const values = [];
    let idx = 1;

    if (status) {
      conditions.push(`v.status = $${idx++}`);
      values.push(String(status).toUpperCase());
    }

    if (region_id) {
      conditions.push(`v.region_id = $${idx++}`);
      values.push(Number(region_id));
    }

    if (search) {
      conditions.push(`(v.vendor_name ILIKE $${idx} OR COALESCE(v.vendor_code, '') ILIKE $${idx})`);
      values.push(`%${search}%`);
      idx += 1;
    }

    // Row-level RBAC: restrict to vendors in the caller's allowed entities.
    if (req.scopeEnforced && Array.isArray(req.allowedEntityIds)) {
      conditions.push(`v.region_id = ANY($${idx++})`);
      values.push(req.allowedEntityIds);
    }

    const result = await pool.query(
      `
      SELECT
        v.*,
        r.region_name
      FROM vendors v
      JOIN regions r ON r.id = v.region_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY v.id DESC
      `,
      values,
    );

    return res.json({ success: true, data: result.rows.map(sanitizeVendorRecord) });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to fetch vendors", error: error.message });
  }
};

const getVendorById = async (req, res) => {
  try {
    await ensureApSchema();
    const result = await pool.query(
      `
      SELECT v.*, r.region_name
      FROM vendors v
      JOIN regions r ON r.id = v.region_id
      WHERE v.id = $1 AND v.deleted_at IS NULL
      LIMIT 1
      `,
      [req.params.id],
    );

    if (!result.rows.length || !canActOnEntity(req, result.rows[0].region_id)) {
      return res.status(404).json({ success: false, message: "Vendor not found" });
    }

    return res.json({ success: true, data: sanitizeVendorRecord(result.rows[0]) });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to fetch vendor", error: error.message });
  }
};

const createVendor = async (req, res) => {
  try {
    await ensureApSchema();
    const {
      vendor_name,
      vendor_code,
      region_id,
      billing_address,
      tax_identifier,
      currency,
      default_payment_terms,
      primary_contact_name,
      primary_contact_email,
      primary_contact_phone,
      bank_name,
      bank_account_name,
      bank_account_number,
      bank_routing_number,
      bank_swift_ifsc,
      status,
    } = req.body;

    if (!vendor_name || !region_id) {
      return res.status(400).json({ success: false, message: "Vendor name and region are required" });
    }
    if (!canActOnEntity(req, region_id)) {
      return res.status(403).json({ success: false, message: "Not authorized to create vendors in this region" });
    }

    let finalVendorCode = null;
    if (vendor_code && String(vendor_code).trim()) {
      const requestedCode = String(vendor_code).trim().toUpperCase();
      const duplicate = await pool.query(`SELECT id FROM vendors WHERE vendor_code = $1 LIMIT 1`, [requestedCode]);
      finalVendorCode = duplicate.rows.length ? await generateVendorCode(pool, vendor_name) : requestedCode;
    } else {
      finalVendorCode = await generateVendorCode(pool, vendor_name);
    }

    let finalCurrency = String(currency || "").toUpperCase();
    if (!finalCurrency) {
      const regionResult = await pool.query(`SELECT default_currency FROM regions WHERE id = $1 LIMIT 1`, [Number(region_id)]);
      finalCurrency = String(regionResult.rows[0]?.default_currency || "USD").toUpperCase();
    }

    const result = await pool.query(
      `
      INSERT INTO vendors (
        vendor_name, vendor_code, region_id, billing_address, tax_identifier, currency,
        default_payment_terms, primary_contact_name, primary_contact_email, primary_contact_phone,
        bank_name, bank_account_name, bank_account_number, bank_routing_number, bank_swift_ifsc,
        status, created_by
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING *
      `,
      [
        vendor_name,
        finalVendorCode,
        Number(region_id),
        toNullable(billing_address),
        toNullable(tax_identifier),
        finalCurrency,
        toNullable(default_payment_terms || "NET_30"),
        toNullable(primary_contact_name),
        toNullable(primary_contact_email),
        toNullable(primary_contact_phone),
        toNullable(bank_name),
        toNullable(bank_account_name),
        toNullable(bank_account_number),
        toNullable(bank_routing_number),
        toNullable(bank_swift_ifsc),
        String(status || "ACTIVE").toUpperCase(),
        req.user?.id || null,
      ],
    );

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "CREATE",
      entityType: "vendors",
      entityId: result.rows[0].id,
      newValues: result.rows[0],
      ipAddress: req.ip,
    });

    return res.status(201).json({ success: true, message: "Vendor created", data: sanitizeVendorRecord(result.rows[0]) });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(400).json({ success: false, message: "Vendor code already exists" });
    }
    return res.status(500).json({ success: false, message: "Failed to create vendor", error: error.message });
  }
};

const updateVendor = async (req, res) => {
  try {
    await ensureApSchema();
    const { id } = req.params;
    const existing = await pool.query(`SELECT * FROM vendors WHERE id = $1 AND deleted_at IS NULL LIMIT 1`, [id]);

    if (!existing.rows.length || !canActOnEntity(req, existing.rows[0].region_id)) {
      return res.status(404).json({ success: false, message: "Vendor not found" });
    }

    const current = existing.rows[0];
    const payload = { ...current, ...req.body };
    if (!canActOnEntity(req, payload.region_id)) {
      return res.status(403).json({ success: false, message: "Not authorized to assign vendors to this region" });
    }
    let finalVendorCode = String(payload.vendor_code || "").trim().toUpperCase();

    if (!finalVendorCode) {
      finalVendorCode = await generateVendorCode(pool, payload.vendor_name);
    } else {
      const duplicate = await pool.query(`SELECT id FROM vendors WHERE vendor_code = $1 AND id <> $2 LIMIT 1`, [finalVendorCode, Number(id)]);
      if (duplicate.rows.length) {
        return res.status(400).json({ success: false, message: "Vendor code already exists" });
      }
    }

    const result = await pool.query(
      `
      UPDATE vendors
      SET
        vendor_name = $1,
        vendor_code = $2,
        region_id = $3,
        billing_address = $4,
        tax_identifier = $5,
        currency = $6,
        default_payment_terms = $7,
        primary_contact_name = $8,
        primary_contact_email = $9,
        primary_contact_phone = $10,
        bank_name = $11,
        bank_account_name = $12,
        bank_account_number = $13,
        bank_routing_number = $14,
        bank_swift_ifsc = $15,
        status = $16,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $17
      RETURNING *
      `,
      [
        payload.vendor_name,
        finalVendorCode,
        Number(payload.region_id),
        toNullable(payload.billing_address),
        toNullable(payload.tax_identifier),
        String(payload.currency || "USD").toUpperCase(),
        toNullable(payload.default_payment_terms || "NET_30"),
        toNullable(payload.primary_contact_name),
        toNullable(payload.primary_contact_email),
        toNullable(payload.primary_contact_phone),
        toNullable(payload.bank_name),
        toNullable(payload.bank_account_name),
        toNullable(payload.bank_account_number),
        toNullable(payload.bank_routing_number),
        toNullable(payload.bank_swift_ifsc),
        String(payload.status || "ACTIVE").toUpperCase(),
        Number(id),
      ],
    );

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "UPDATE",
      entityType: "vendors",
      entityId: Number(id),
      oldValues: current,
      newValues: result.rows[0],
      ipAddress: req.ip,
    });

    return res.json({ success: true, message: "Vendor updated", data: sanitizeVendorRecord(result.rows[0]) });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to update vendor", error: error.message });
  }
};

const deleteVendor = async (req, res) => {
  try {
    await ensureApSchema();
    const { id } = req.params;
    const existingVendor = await pool.query(`SELECT region_id FROM vendors WHERE id = $1 AND deleted_at IS NULL LIMIT 1`, [Number(id)]);
    if (!existingVendor.rows.length || !canActOnEntity(req, existingVendor.rows[0].region_id)) {
      return res.status(404).json({ success: false, message: "Vendor not found" });
    }
    const billCount = await pool.query(`SELECT COUNT(*)::int AS count FROM bills WHERE vendor_id = $1 AND deleted_at IS NULL`, [Number(id)]);
    if (Number(billCount.rows[0]?.count || 0) > 0) {
      return res.status(400).json({ success: false, message: "Cannot delete vendor with linked bills" });
    }

    const result = await pool.query(
      `
      UPDATE vendors
      SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING *
      `,
      [Number(id)],
    );

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "Vendor not found" });
    }

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "DELETE",
      entityType: "vendors",
      entityId: Number(id),
      oldValues: result.rows[0],
      ipAddress: req.ip,
    });

    return res.json({ success: true, message: "Vendor deleted" });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to delete vendor", error: error.message });
  }
};

const getVendorOverview = async (req, res) => {
  try {
    await ensureApSchema();
    const id = Number(req.params.id);
    const vendorRes = await pool.query(
      `SELECT v.*, r.region_name FROM vendors v JOIN regions r ON r.id = v.region_id WHERE v.id = $1 AND v.deleted_at IS NULL LIMIT 1`, [id]);
    if (!vendorRes.rows.length || !canActOnEntity(req, vendorRes.rows[0].region_id))
      return res.status(404).json({ success: false, message: "Vendor not found" });

    const bills = await pool.query(
      `SELECT id, bill_number, bill_date, due_date, total_amount, payment_paid_amount, balance_outstanding,
              bill_status, approval_status, currency
         FROM bills WHERE vendor_id = $1 AND deleted_at IS NULL ORDER BY bill_date DESC, id DESC LIMIT 100`, [id]);

    const summary = await pool.query(
      `SELECT
         COALESCE(SUM(total_amount),0) AS billed,
         COALESCE(SUM(payment_paid_amount),0) AS paid,
         COALESCE(SUM(balance_outstanding),0) AS outstanding,
         COALESCE(SUM(CASE WHEN balance_outstanding>0 AND due_date <  CURRENT_DATE THEN balance_outstanding ELSE 0 END),0) AS overdue,
         COUNT(*)::int AS bill_count,
         COALESCE(SUM(CASE WHEN balance_outstanding>0 AND due_date >= CURRENT_DATE THEN balance_outstanding ELSE 0 END),0) AS current_bucket,
         COALESCE(SUM(CASE WHEN balance_outstanding>0 AND (CURRENT_DATE - due_date) BETWEEN 1 AND 30  THEN balance_outstanding ELSE 0 END),0) AS d30,
         COALESCE(SUM(CASE WHEN balance_outstanding>0 AND (CURRENT_DATE - due_date) BETWEEN 31 AND 60 THEN balance_outstanding ELSE 0 END),0) AS d60,
         COALESCE(SUM(CASE WHEN balance_outstanding>0 AND (CURRENT_DATE - due_date) BETWEEN 61 AND 90 THEN balance_outstanding ELSE 0 END),0) AS d90,
         COALESCE(SUM(CASE WHEN balance_outstanding>0 AND (CURRENT_DATE - due_date) > 90 THEN balance_outstanding ELSE 0 END),0) AS d90p
       FROM bills WHERE vendor_id = $1 AND deleted_at IS NULL`, [id]);

    const payments = await pool.query(
      `SELECT vp.id, vp.payment_date, vp.amount_paid, vp.payment_method, vp.reference_number, b.bill_number, b.currency
         FROM vendor_payments vp JOIN bills b ON vp.bill_id = b.id
        WHERE b.vendor_id = $1 ORDER BY vp.payment_date DESC, vp.id DESC LIMIT 50`, [id]);

    return res.json({ success: true, data: {
      vendor: sanitizeVendorRecord(vendorRes.rows[0]),
      summary: summary.rows[0],
      bills: bills.rows,
      payments: payments.rows,
    } });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to fetch vendor overview", error: error.message });
  }
};

module.exports = {
  getAllVendors,
  getVendorById,
  getVendorOverview,
  createVendor,
  updateVendor,
  deleteVendor,
};
