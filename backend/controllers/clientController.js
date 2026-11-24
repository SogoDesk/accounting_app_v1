



const { getTenantClient } = require("../config/tenantContext");
const { auditLog } = require("../middleware/auditMiddleware");
const { canActOnEntity } = require("../middleware/scopeMiddleware");
const { generateClientCode } = require("../utils/codeGenerator");
const { groupCurrency, attachReportingFields } = require("../utils/reportingCurrency");

const getTenantContext = (req) => {
  const db = getTenantClient();
  const tenantId = req.user?.tenantId;
  if (!db) throw new Error("Tenant database context is missing for this request");
  if (tenantId == null) throw new Error("Authenticated user has no tenantId");
  return { db, tenantId };
};

const toNullable = (value) => {
  if (value === undefined || value === null || value === "") return null;
  return value;
};

const toNumberOrZero = (value) => {
  if (value === undefined || value === null || value === "") return 0;
  const num = Number(value);
  return Number.isNaN(num) ? 0 : num;
};

const sanitizeClientRecord = (client = {}) =>
  Object.fromEntries(
    Object.entries(client).filter(([key]) => !key.startsWith("quick")),
  );

const getAllClients = async (req, res) => {
  try {
    const { db, tenantId } = getTenantContext(req);
    const { status, region_id, search } = req.query;
    const paginate = req.query.page != null || req.query.limit != null;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 500));
    const conditions = ["cl.tenant_id = $1"];
    const values = [tenantId];
    let idx = 2;

    if (status) {
      conditions.push(`cl.status = $${idx++}`);
      values.push(status);
    }

    if (region_id) {
      conditions.push(`cl.region_id = $${idx++}`);
      values.push(Number(region_id));
    }

    if (search) {
      conditions.push(`(cl.client_name ILIKE $${idx} OR cl.client_code ILIKE $${idx})`);
      values.push(`%${search}%`);
      idx += 1;
    }

    if (req.scopeEnforced && Array.isArray(req.allowedEntityIds)) {
      conditions.push(`cl.region_id = ANY($${idx++})`);
      values.push(req.allowedEntityIds);
    }

    const queryValues = [...values];
    let pageClause = "";
    if (paginate) {
      const offset = (page - 1) * limit;
      pageClause = `LIMIT $${idx++} OFFSET $${idx}`;
      queryValues.push(limit, offset);
    }

    const result = await db.query(
      `SELECT
         cl.*,
         r.region_name,
         r.default_currency AS region_currency,
         COALESCE(cl.currency, r.default_currency) AS balance_currency,
         COALESCE((
           SELECT SUM(i.balance_outstanding)
             FROM invoices i
            WHERE i.client_id = cl.id
              AND i.tenant_id = cl.tenant_id
         ), 0) AS open_balance
       FROM clients cl
       JOIN regions r ON cl.region_id = r.id
       WHERE ${conditions.join(" AND ")}
       ORDER BY cl.id DESC
       ${pageClause}`,
      queryValues,
    );

    const data = result.rows.map(sanitizeClientRecord);
    const reportingCcy = await groupCurrency(db);
    await attachReportingFields(
      data,
      { open_balance: "open_balance_reporting" },
      { db, reportingCcy, currencyField: "balance_currency" },
    );

    return res.json({ success: true, data, reporting_currency: reportingCcy });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

const getClientById = async (req, res) => {
  try {
    const { db, tenantId } = getTenantContext(req);
    const result = await db.query(
      `SELECT cl.*, r.region_name, r.default_currency AS region_currency
         FROM clients cl
         JOIN regions r ON cl.region_id = r.id
        WHERE cl.id = $1 AND cl.tenant_id = $2
        LIMIT 1`,
      [req.params.id, tenantId],
    );

    if (!result.rows.length || !canActOnEntity(req, result.rows[0].region_id)) {
      return res.status(404).json({ success: false, message: "Client not found" });
    }

    return res.json({ success: true, data: sanitizeClientRecord(result.rows[0]) });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

const getClientOverview = async (req, res) => {
  try {
    const { db, tenantId } = getTenantContext(req);
    const id = Number(req.params.id);
    const clientRes = await db.query(
      `SELECT cl.*, r.region_name, r.default_currency AS region_currency
         FROM clients cl
         JOIN regions r ON cl.region_id = r.id
        WHERE cl.id = $1 AND cl.tenant_id = $2`,
      [id, tenantId],
    );

    if (!clientRes.rows.length || !canActOnEntity(req, clientRes.rows[0].region_id)) {
      return res.status(404).json({ success: false, message: "Client not found" });
    }

    const invoices = await db.query(
      `SELECT id, invoice_number, invoice_date, due_date, total_amount, payment_received_amount,
              balance_outstanding, invoice_status, currency
         FROM invoices
        WHERE client_id = $1 AND tenant_id = $2
        ORDER BY invoice_date DESC, id DESC
        LIMIT 100`,
      [id, tenantId],
    );

    const summary = await db.query(
      `SELECT
         COALESCE(SUM(total_amount),0) AS invoiced,
         COALESCE(SUM(payment_received_amount),0) AS collected,
         COALESCE(SUM(balance_outstanding),0) AS outstanding,
         COALESCE(SUM(CASE WHEN balance_outstanding > 0 AND due_date < CURRENT_DATE THEN balance_outstanding ELSE 0 END),0) AS overdue,
         COUNT(*)::int AS invoice_count,
         COALESCE(SUM(CASE WHEN balance_outstanding > 0 AND due_date >= CURRENT_DATE THEN balance_outstanding ELSE 0 END),0) AS current_bucket,
         COALESCE(SUM(CASE WHEN balance_outstanding > 0 AND (CURRENT_DATE - due_date) BETWEEN 1 AND 30 THEN balance_outstanding ELSE 0 END),0) AS d30,
         COALESCE(SUM(CASE WHEN balance_outstanding > 0 AND (CURRENT_DATE - due_date) BETWEEN 31 AND 60 THEN balance_outstanding ELSE 0 END),0) AS d60,
         COALESCE(SUM(CASE WHEN balance_outstanding > 0 AND (CURRENT_DATE - due_date) BETWEEN 61 AND 90 THEN balance_outstanding ELSE 0 END),0) AS d90,
         COALESCE(SUM(CASE WHEN balance_outstanding > 0 AND (CURRENT_DATE - due_date) > 90 THEN balance_outstanding ELSE 0 END),0) AS d90p
       FROM invoices
       WHERE client_id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );

    const payments = await db.query(
      `SELECT p.id, p.payment_date, p.amount_received, p.payment_mode, p.reference_number,
              i.invoice_number, i.currency
         FROM payments p
         JOIN invoices i ON p.invoice_id = i.id AND i.tenant_id = p.tenant_id
        WHERE i.client_id = $1 AND p.tenant_id = $2
        ORDER BY p.payment_date DESC, p.id DESC
        LIMIT 50`,
      [id, tenantId],
    );

    const placements = await db.query(
      `SELECT pl.id, pl.placement_code, pl.job_title, pl.placement_status, pl.bill_rate, pl.currency,
              c.full_name AS candidate_name
         FROM placements pl
         LEFT JOIN candidates c ON pl.candidate_id = c.id AND c.tenant_id = pl.tenant_id
        WHERE pl.client_id = $1 AND pl.tenant_id = $2
        ORDER BY pl.start_date DESC
        LIMIT 50`,
      [id, tenantId],
    );

    return res.json({
      success: true,
      data: {
        client: sanitizeClientRecord(clientRes.rows[0]),
        summary: summary.rows[0],
        invoices: invoices.rows,
        payments: payments.rows,
        placements: placements.rows,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

const createClient = async (req, res) => {
  try {
    const { db, tenantId } = getTenantContext(req);
    const {
      client_name, client_code, region_id, billing_address, tax_identifier,
      currency, default_payment_terms, default_invoice_cycle, primary_contact_name,
      primary_contact_email, primary_contact_phone, credit_limit, status,
    } = req.body;

    if (!client_name || !region_id) {
      return res.status(400).json({ success: false, message: "Client name and region are required" });
    }
    if (!canActOnEntity(req, region_id)) {
      return res.status(403).json({ success: false, message: "Not authorized to create clients in this region" });
    }

    let finalClientCode;
    if (client_code && String(client_code).trim()) {
      const requestedCode = String(client_code).trim().toUpperCase();
      const existingCode = await db.query(
        `SELECT id FROM clients WHERE client_code = $1 AND tenant_id = $2 LIMIT 1`,
        [requestedCode, tenantId],
      );
      finalClientCode = existingCode.rows.length
        ? await generateClientCode(db, client_name)
        : requestedCode;
    } else {
      finalClientCode = await generateClientCode(db, client_name);
    }

    let finalCurrency = currency;
    if (!finalCurrency) {
      const regionResult = await db.query(
        `SELECT default_currency FROM regions WHERE id = $1 LIMIT 1`,
        [region_id],
      );
      finalCurrency = regionResult.rows[0]?.default_currency || "USD";
    }

    const result = await db.query(
      `INSERT INTO clients (
         tenant_id, client_name, client_code, region_id, billing_address, tax_identifier,
         currency, default_payment_terms, default_invoice_cycle, primary_contact_name,
         primary_contact_email, primary_contact_phone, credit_limit, status, created_by
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        tenantId, client_name, finalClientCode, region_id, toNullable(billing_address),
        toNullable(tax_identifier), String(finalCurrency).toUpperCase(),
        toNullable(default_payment_terms), toNullable(default_invoice_cycle),
        toNullable(primary_contact_name), toNullable(primary_contact_email),
        toNullable(primary_contact_phone), toNumberOrZero(credit_limit),
        status || "ACTIVE", req.user?.id || null,
      ],
    );

    await auditLog({
      userId: req.user?.id, userEmail: req.user?.email, action: "CREATE",
      entityType: "clients", entityId: result.rows[0].id,
      newValues: result.rows[0], ipAddress: req.ip,
    });

    return res.status(201).json({
      success: true,
      message: "Client created",
      data: sanitizeClientRecord(result.rows[0]),
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).json({ success: false, message: "Client name or code already exists" });
    }
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

const updateClient = async (req, res) => {
  try {
    const { db, tenantId } = getTenantContext(req);
    const { id } = req.params;
    const old = await db.query(
      `SELECT * FROM clients WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );

    if (!old.rows.length || !canActOnEntity(req, old.rows[0].region_id)) {
      return res.status(404).json({ success: false, message: "Client not found" });
    }

    const {
      client_name, client_code, region_id, billing_address, tax_identifier,
      currency, default_payment_terms, default_invoice_cycle, primary_contact_name,
      primary_contact_email, primary_contact_phone, credit_limit, status,
    } = req.body;

    if (region_id != null && !canActOnEntity(req, region_id)) {
      return res.status(403).json({ success: false, message: "Not authorized to assign clients to this region" });
    }

    let finalClientCode = String(client_code || old.rows[0].client_code || "").trim().toUpperCase();
    if (!finalClientCode) {
      finalClientCode = await generateClientCode(db, client_name || old.rows[0].client_name);
    } else {
      const duplicate = await db.query(
        `SELECT id FROM clients WHERE client_code = $1 AND id <> $2 AND tenant_id = $3 LIMIT 1`,
        [finalClientCode, id, tenantId],
      );
      if (duplicate.rows.length) {
        return res.status(400).json({ success: false, message: "Client code already exists" });
      }
    }

    let finalCurrency = currency;
    if (!finalCurrency && region_id) {
      const regionResult = await db.query(
        `SELECT default_currency FROM regions WHERE id = $1 LIMIT 1`,
        [region_id],
      );
      finalCurrency = regionResult.rows[0]?.default_currency || old.rows[0].currency || "USD";
    }

    const result = await db.query(
      `UPDATE clients
          SET client_name = COALESCE($1, client_name),
              client_code = $2,
              region_id = COALESCE($3, region_id),
              billing_address = $4,
              tax_identifier = $5,
              currency = $6,
              default_payment_terms = $7,
              default_invoice_cycle = $8,
              primary_contact_name = $9,
              primary_contact_email = $10,
              primary_contact_phone = $11,
              credit_limit = $12,
              status = $13,
              updated_at = NOW()
        WHERE id = $14 AND tenant_id = $15
        RETURNING *`,
      [
        client_name, finalClientCode, region_id, toNullable(billing_address),
        toNullable(tax_identifier), String(finalCurrency || "USD").toUpperCase(),
        toNullable(default_payment_terms), toNullable(default_invoice_cycle),
        toNullable(primary_contact_name), toNullable(primary_contact_email),
        toNullable(primary_contact_phone), toNumberOrZero(credit_limit),
        status ?? old.rows[0].status, id, tenantId,
      ],
    );

    await auditLog({
      userId: req.user?.id, userEmail: req.user?.email, action: "UPDATE",
      entityType: "clients", entityId: Number(id),
      oldValues: old.rows[0], newValues: result.rows[0], ipAddress: req.ip,
    });

    return res.json({
      success: true,
      message: "Client updated",
      data: sanitizeClientRecord(result.rows[0]),
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).json({ success: false, message: "Client name or code already exists" });
    }
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

const deleteClient = async (req, res) => {
  try {
    const { db, tenantId } = getTenantContext(req);
    const { id } = req.params;
    const existing = await db.query(
      `SELECT region_id FROM clients WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );

    if (!existing.rows.length || !canActOnEntity(req, existing.rows[0].region_id)) {
      return res.status(404).json({ success: false, message: "Client not found" });
    }

    const deps = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM placements WHERE client_id = $1 AND tenant_id = $2)::int AS placements_count,
         (SELECT COUNT(*) FROM invoices WHERE client_id = $1 AND tenant_id = $2)::int AS invoices_count`,
      [id, tenantId],
    );

    const d = deps.rows[0] || {};
    if (Number(d.placements_count) > 0 || Number(d.invoices_count) > 0) {
      return res.status(400).json({
        success: false,
        message: "Cannot delete client with linked placements or invoices",
      });
    }

    const result = await db.query(
      `DELETE FROM clients WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId],
    );

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "Client not found" });
    }

    await auditLog({
      userId: req.user?.id, userEmail: req.user?.email, action: "DELETE",
      entityType: "clients", entityId: Number(id),
      oldValues: result.rows[0], ipAddress: req.ip,
    });

    return res.json({ success: true, message: "Client deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

module.exports = {
  getAllClients,
  getClientById,
  getClientOverview,
  createClient,
  updateClient,
  deleteClient,
};





