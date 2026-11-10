const pool = require("../config/db");
const { auditLog } = require("../middleware/auditMiddleware");
const { generatePlacementCode } = require("../utils/codeGenerator");
const { canActOnEntity } = require("../middleware/scopeMiddleware");
const { groupCurrency, makeRateResolver } = require("../utils/reportingCurrency");

const toNullable = (value) => {
  if (value === undefined || value === null || value === "") return null;
  return value;
};

const toNumberOrZero = (value) => {
  if (value === undefined || value === null || value === "") return 0;
  const num = Number(value);
  return Number.isNaN(num) ? 0 : num;
};

// Projected MONTHLY revenue from a placement, by how it is billed.
//  * HOURLY/DAILY/WEEKLY -> per-unit bill_rate x expected units per month
//  * MONTHLY             -> the monthly billing amount
//  * ANNUAL             -> annual amount (stored in monthly_billing_amount) / 12
//  * FIXED/PERM_FEE     -> one-off fee (one_time_fee_amount)
const calcProjectedRevenue = (p) => {
  const type = String(p.billing_type || "").toUpperCase();
  if (type === "HOURLY" || type === "DAILY" || type === "WEEKLY") {
    return Number(p.bill_rate || 0) * Number(p.expected_hours_per_month || 0);
  }
  if (type === "MONTHLY") {
    return Number(p.monthly_billing_amount || 0);
  }
  if (type === "ANNUAL") {
    return Number(p.monthly_billing_amount || 0) / 12;
  }
  if (type === "FIXED" || type === "PERM_FEE" || type === "ONE_TIME") {
    return Number(p.one_time_fee_amount || 0);
  }
  return 0;
};

const VALID_PLACEMENT_STATUS = ["ACTIVE", "ON_HOLD", "ENDED", "CANCELLED"];
const VALID_BILLING_TYPE = ["HOURLY", "DAILY", "WEEKLY", "MONTHLY", "ANNUAL", "FIXED", "PERM_FEE"];
const VALID_EMPLOYMENT_TYPE = ["CONTRACT", "C2C", "W2", "FULL_TIME", "PERMANENT"];
const VALID_INVOICE_CYCLE = ["WEEKLY", "BIWEEKLY", "MONTHLY"];
const VALID_PAYMENT_TERMS = ["NET_15", "NET_30", "NET_45", "CUSTOM"];

const normalizeUpper = (value) => String(value || "").trim().toUpperCase();

const isIn = (value, validList) => validList.includes(normalizeUpper(value));

const baseQuery = `
  SELECT
    p.*,
    c.full_name AS candidate_name,
    c.job_title AS candidate_job_title,
    r.region_name,
    r.default_currency AS region_currency,
    cl.client_name,
    cl.currency AS client_currency,
    rec.full_name AS recruiter_name,
    acc.full_name AS account_manager_name,
    cb.full_name AS created_by_name,
    c.work_authorization,
    c.work_auth_expiry,
    c.insurance_expiry,
    c.w9_on_file,
    COALESCE((
      SELECT SUM(t.units)
        FROM timesheets t
       WHERE t.placement_id = p.id
         AND date_trunc('month', t.period_start) = date_trunc('month', CURRENT_DATE)
    ), 0) AS actual_hours
  FROM placements p
  JOIN candidates c ON p.candidate_id = c.id
  JOIN regions r ON p.region_id = r.id
  JOIN clients cl ON p.client_id = cl.id
  LEFT JOIN users rec ON p.recruiter_id = rec.id
  LEFT JOIN users acc ON p.account_manager_id = acc.id
  LEFT JOIN users cb ON p.created_by = cb.id
`;

const getAllPlacements = async (req, res) => {
  try {
    const {
      status,
      client_id,
      region_id,
      candidate_id,
      search,
    } = req.query;
    // Paginate only when explicitly requested; otherwise return the full set so
    // the PlacementsPage (no pager) lists every placement and its KPI cards cover
    // the whole book instead of a silently-capped first page.
    const paginate = req.query.page != null || req.query.limit != null;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Number(req.query.limit) || 50);
    const conditions = [];
    const values = [];
    let idx = 1;

    if (status) {
      conditions.push(`p.placement_status = $${idx++}`);
      values.push(status);
    }
    if (client_id) {
      conditions.push(`p.client_id = $${idx++}`);
      values.push(Number(client_id));
    }
    if (region_id) {
      conditions.push(`p.region_id = $${idx++}`);
      values.push(Number(region_id));
    }
    if (candidate_id) {
      conditions.push(`p.candidate_id = $${idx++}`);
      values.push(Number(candidate_id));
    }
    if (search) {
      conditions.push(`(
        p.placement_code ILIKE $${idx}
        OR c.full_name ILIKE $${idx}
        OR cl.client_name ILIKE $${idx}
        OR p.job_title ILIKE $${idx}
      )`);
      values.push(`%${search}%`);
      idx++;
    }

    // Row-level RBAC: restrict to placements in the caller's allowed entities.
    if (req.scopeEnforced && Array.isArray(req.allowedEntityIds)) {
      conditions.push(`p.region_id = ANY($${idx++})`);
      values.push(req.allowedEntityIds);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const count = await pool.query(
      `SELECT COUNT(*)
       FROM placements p
       JOIN candidates c ON p.candidate_id = c.id
       JOIN clients cl ON p.client_id = cl.id
       ${where}`,
      values,
    );

    const queryValues = [...values];
    let pageClause = "";
    if (paginate) {
      const offset = (page - 1) * limit;
      pageClause = `LIMIT $${idx++} OFFSET $${idx}`;
      queryValues.push(limit, offset);
    }

    const result = await pool.query(
      `${baseQuery}
       ${where}
       ORDER BY p.id DESC
       ${pageClause}`,
      queryValues,
    );

    // Placement revenue/cost are derived on the client from rate × hours, so we
    // can't pre-convert a stored column; instead hand the client a per-row FX
    // rate to the group currency to apply to its computed figures for the KPIs.
    const reportingCcy = await groupCurrency(pool);
    const rateTo = await makeRateResolver(reportingCcy, pool);
    const data = [];
    for (const row of result.rows) {
      data.push({
        ...row,
        projected_monthly_revenue: calcProjectedRevenue(row),
        reporting_rate: await rateTo(row.currency),
      });
    }

    return res.json({
      success: true,
      data,
      reporting_currency: reportingCcy,
      pagination: {
        total: Number(count.rows[0].count),
        page: paginate ? page : 1,
        limit: paginate ? limit : Number(count.rows[0].count),
        pages: paginate
          ? Math.ceil(Number(count.rows[0].count) / limit)
          : 1,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

const getPlacementById = async (req, res) => {
  try {
    const result = await pool.query(`${baseQuery} WHERE p.id = $1`, [
      req.params.id,
    ]);

    if (!result.rows.length || !canActOnEntity(req, result.rows[0].region_id)) {
      return res.status(404).json({
        success: false,
        message: "Placement not found",
      });
    }

    const row = result.rows[0];

    return res.json({
      success: true,
      data: {
        ...row,
        projected_monthly_revenue: calcProjectedRevenue(row),
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

const createPlacement = async (req, res) => {
  try {
    const {
      placement_code,
      candidate_id,
      region_id,
      client_id,
      end_client_name,
      vendor_name,
      recruiter_id,
      account_manager_id,
      job_title,
      employment_type,
      placement_status,
      billing_type,
      bill_rate,
      pay_rate,
      currency,
      expected_hours_per_month,
      monthly_billing_amount,
      one_time_fee_amount,
      invoice_cycle,
      payment_terms,
      custom_payment_terms_days,
      po_number,
      sow_number,
      tax_applicable,
      tax_percent,
      start_date,
      end_date,
      notes,
    } = req.body;

    if (
      !candidate_id ||
      !client_id ||
      !region_id ||
      !job_title ||
      !employment_type ||
      !billing_type ||
      !currency ||
      !start_date
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Candidate, client, region, job title, employment type, billing type, currency and start date are required",
      });
    }

    if (!canActOnEntity(req, region_id)) {
      return res.status(403).json({ success: false, message: "Not authorized to create placements in this region" });
    }

    if (!isIn(placement_status || "ACTIVE", VALID_PLACEMENT_STATUS)) {
      return res.status(400).json({
        success: false,
        message: `Invalid placement status. Allowed: ${VALID_PLACEMENT_STATUS.join(", ")}`,
      });
    }

    if (!isIn(billing_type, VALID_BILLING_TYPE)) {
      return res.status(400).json({
        success: false,
        message: `Invalid billing type. Allowed: ${VALID_BILLING_TYPE.join(", ")}`,
      });
    }

    if (!isIn(employment_type, VALID_EMPLOYMENT_TYPE)) {
      return res.status(400).json({
        success: false,
        message: `Invalid employment type. Allowed: ${VALID_EMPLOYMENT_TYPE.join(", ")}`,
      });
    }

    if (invoice_cycle && !isIn(invoice_cycle, VALID_INVOICE_CYCLE)) {
      return res.status(400).json({
        success: false,
        message: `Invalid invoice cycle. Allowed: ${VALID_INVOICE_CYCLE.join(", ")}`,
      });
    }

    if (payment_terms && !isIn(payment_terms, VALID_PAYMENT_TERMS)) {
      return res.status(400).json({
        success: false,
        message: `Invalid payment terms. Allowed: ${VALID_PAYMENT_TERMS.join(", ")}`,
      });
    }

    let finalPlacementCode = null;

    if (placement_code && String(placement_code).trim()) {
      const requestedCode = String(placement_code).trim().toUpperCase();

      const existingCode = await pool.query(
        `SELECT id FROM placements WHERE placement_code = $1 LIMIT 1`,
        [requestedCode],
      );

      if (existingCode.rows.length) {
        return res.status(400).json({
          success: false,
          message: "Placement code already exists",
        });
      }

      finalPlacementCode = requestedCode;
    } else {
      finalPlacementCode = await generatePlacementCode(pool);
    }

    const result = await pool.query(
      `INSERT INTO placements (
        placement_code,
        candidate_id,
        region_id,
        client_id,
        end_client_name,
        vendor_name,
        recruiter_id,
        account_manager_id,
        job_title,
        employment_type,
        placement_status,
        billing_type,
        bill_rate,
        pay_rate,
        currency,
        expected_hours_per_month,
        monthly_billing_amount,
        one_time_fee_amount,
        invoice_cycle,
        payment_terms,
        custom_payment_terms_days,
        po_number,
        sow_number,
        tax_applicable,
        tax_percent,
        start_date,
        end_date,
        notes,
        created_by
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
      RETURNING *`,
      [
        finalPlacementCode,
        candidate_id,
        region_id,
        client_id,
        toNullable(end_client_name),
        toNullable(vendor_name),
        toNullable(recruiter_id),
        toNullable(account_manager_id),
        job_title,
        normalizeUpper(employment_type),
        normalizeUpper(placement_status || "ACTIVE"),
        normalizeUpper(billing_type),
        toNumberOrZero(bill_rate),
        toNumberOrZero(pay_rate),
        normalizeUpper(currency),
        toNumberOrZero(expected_hours_per_month),
        toNumberOrZero(monthly_billing_amount),
        toNumberOrZero(one_time_fee_amount),
        normalizeUpper(toNullable(invoice_cycle) || "MONTHLY"),
        normalizeUpper(toNullable(payment_terms) || "NET_30"),
        toNullable(custom_payment_terms_days),
        toNullable(po_number),
        toNullable(sow_number),
        tax_applicable === true || tax_applicable === "true",
        toNumberOrZero(tax_percent),
        start_date,
        toNullable(end_date),
        toNullable(notes),
        req.user?.id || null,
      ],
    );

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "CREATE",
      entityType: "placements",
      entityId: result.rows[0].id,
      newValues: result.rows[0],
      ipAddress: req.ip,
    });

    return res.status(201).json({
      success: true,
      message: "Placement created",
      data: result.rows[0],
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).json({
        success: false,
        message: "Placement code already exists",
      });
    }
    if (err.code === "23502") {
      return res.status(400).json({
        success: false,
        message: "Missing required placement field",
      });
    }
    if (err.code === "23503") {
      return res.status(400).json({
        success: false,
        message: "Invalid candidate/client/region/user reference",
      });
    }
    if (err.code === "23514") {
      return res.status(400).json({
        success: false,
        message: "Invalid placement value for status, employment type, billing type, invoice cycle or payment terms",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

const updatePlacement = async (req, res) => {
  try {
    const { id } = req.params;

    const old = await pool.query("SELECT * FROM placements WHERE id = $1", [
      id,
    ]);
    if (!old.rows.length || !canActOnEntity(req, old.rows[0].region_id)) {
      return res.status(404).json({
        success: false,
        message: "Placement not found",
      });
    }

    const {
      placement_code,
      candidate_id,
      region_id,
      client_id,
      end_client_name,
      vendor_name,
      recruiter_id,
      account_manager_id,
      job_title,
      employment_type,
      placement_status,
      billing_type,
      bill_rate,
      pay_rate,
      currency,
      expected_hours_per_month,
      monthly_billing_amount,
      one_time_fee_amount,
      invoice_cycle,
      payment_terms,
      custom_payment_terms_days,
      po_number,
      sow_number,
      tax_applicable,
      tax_percent,
      start_date,
      end_date,
      notes,
    } = req.body;

    let finalPlacementCode = String(
      placement_code || old.rows[0].placement_code || "",
    )
      .trim()
      .toUpperCase();

    if (!finalPlacementCode) {
      finalPlacementCode = await generatePlacementCode(pool);
    } else {
      const duplicate = await pool.query(
        `SELECT id FROM placements WHERE placement_code = $1 AND id <> $2 LIMIT 1`,
        [finalPlacementCode, id],
      );

      if (duplicate.rows.length) {
        return res.status(400).json({
          success: false,
          message: "Placement code already exists",
        });
      }
    }

    if (!candidate_id || !client_id || !region_id || !job_title || !employment_type || !billing_type || !currency || !start_date) {
      return res.status(400).json({
        success: false,
        message:
          "Candidate, client, region, job title, employment type, billing type, currency and start date are required",
      });
    }

    if (!canActOnEntity(req, region_id)) {
      return res.status(403).json({ success: false, message: "Not authorized to assign placements to this region" });
    }

    if (!isIn(placement_status || old.rows[0].placement_status, VALID_PLACEMENT_STATUS)) {
      return res.status(400).json({
        success: false,
        message: `Invalid placement status. Allowed: ${VALID_PLACEMENT_STATUS.join(", ")}`,
      });
    }
    if (!isIn(billing_type, VALID_BILLING_TYPE)) {
      return res.status(400).json({
        success: false,
        message: `Invalid billing type. Allowed: ${VALID_BILLING_TYPE.join(", ")}`,
      });
    }
    if (!isIn(employment_type, VALID_EMPLOYMENT_TYPE)) {
      return res.status(400).json({
        success: false,
        message: `Invalid employment type. Allowed: ${VALID_EMPLOYMENT_TYPE.join(", ")}`,
      });
    }
    if (invoice_cycle && !isIn(invoice_cycle, VALID_INVOICE_CYCLE)) {
      return res.status(400).json({
        success: false,
        message: `Invalid invoice cycle. Allowed: ${VALID_INVOICE_CYCLE.join(", ")}`,
      });
    }
    if (payment_terms && !isIn(payment_terms, VALID_PAYMENT_TERMS)) {
      return res.status(400).json({
        success: false,
        message: `Invalid payment terms. Allowed: ${VALID_PAYMENT_TERMS.join(", ")}`,
      });
    }

    const result = await pool.query(
      `UPDATE placements SET
        placement_code=$1,
        candidate_id=$2,
        region_id=$3,
        client_id=$4,
        end_client_name=$5,
        vendor_name=$6,
        recruiter_id=$7,
        account_manager_id=$8,
        job_title=$9,
        employment_type=$10,
        placement_status=$11,
        billing_type=$12,
        bill_rate=$13,
        pay_rate=$14,
        currency=$15,
        expected_hours_per_month=$16,
        monthly_billing_amount=$17,
        one_time_fee_amount=$18,
        invoice_cycle=$19,
        payment_terms=$20,
        custom_payment_terms_days=$21,
        po_number=$22,
        sow_number=$23,
        tax_applicable=$24,
        tax_percent=$25,
        start_date=$26,
        end_date=$27,
        notes=$28,
        updated_at=NOW()
      WHERE id=$29
      RETURNING *`,
      [
        finalPlacementCode,
        candidate_id,
        region_id,
        client_id,
        toNullable(end_client_name),
        toNullable(vendor_name),
        toNullable(recruiter_id),
        toNullable(account_manager_id),
        job_title,
        normalizeUpper(employment_type),
        normalizeUpper(placement_status || old.rows[0].placement_status || "ACTIVE"),
        normalizeUpper(billing_type),
        toNumberOrZero(bill_rate),
        toNumberOrZero(pay_rate),
        normalizeUpper(currency),
        toNumberOrZero(expected_hours_per_month),
        toNumberOrZero(monthly_billing_amount),
        toNumberOrZero(one_time_fee_amount),
        normalizeUpper(toNullable(invoice_cycle) || old.rows[0].invoice_cycle || "MONTHLY"),
        normalizeUpper(toNullable(payment_terms) || old.rows[0].payment_terms || "NET_30"),
        toNullable(custom_payment_terms_days),
        toNullable(po_number),
        toNullable(sow_number),
        tax_applicable === true || tax_applicable === "true",
        toNumberOrZero(tax_percent),
        start_date,
        toNullable(end_date),
        toNullable(notes),
        id,
      ],
    );

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "UPDATE",
      entityType: "placements",
      entityId: Number(id),
      oldValues: old.rows[0],
      newValues: result.rows[0],
      ipAddress: req.ip,
    });

    return res.json({
      success: true,
      message: "Placement updated",
      data: result.rows[0],
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).json({
        success: false,
        message: "Placement code already exists",
      });
    }
    if (err.code === "23502") {
      return res.status(400).json({
        success: false,
        message: "Missing required placement field",
      });
    }
    if (err.code === "23503") {
      return res.status(400).json({
        success: false,
        message: "Invalid candidate/client/region/user reference",
      });
    }
    if (err.code === "23514") {
      return res.status(400).json({
        success: false,
        message: "Invalid placement value for status, employment type, billing type, invoice cycle or payment terms",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

const deletePlacement = async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await pool.query("SELECT region_id FROM placements WHERE id = $1", [id]);
    if (!existing.rows.length || !canActOnEntity(req, existing.rows[0].region_id)) {
      return res.status(404).json({ success: false, message: "Placement not found" });
    }

    const deps = await pool.query(
      `SELECT (SELECT COUNT(*) FROM invoices WHERE placement_id = $1)::int AS invoices_count`,
      [id],
    );

    if ((deps.rows[0]?.invoices_count || 0) > 0) {
      return res.status(400).json({
        success: false,
        message: "Cannot delete placement linked to invoices",
      });
    }

    const result = await pool.query(
      "DELETE FROM placements WHERE id = $1 RETURNING *",
      [id],
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Placement not found",
      });
    }

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "DELETE",
      entityType: "placements",
      entityId: Number(id),
      oldValues: result.rows[0],
      ipAddress: req.ip,
    });

    return res.json({
      success: true,
      message: "Placement deleted",
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

const getPlacementOverview = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const pRes = await pool.query(`${baseQuery} WHERE p.id = $1`, [id]);
    if (!pRes.rows.length || !canActOnEntity(req, pRes.rows[0].region_id))
      return res.status(404).json({ success: false, message: "Placement not found" });
    const placement = { ...pRes.rows[0], projected_monthly_revenue: calcProjectedRevenue(pRes.rows[0]) };

    const invoices = await pool.query(
      `SELECT id, invoice_number, invoice_date, due_date, total_amount, payment_received_amount,
              balance_outstanding, invoice_status, currency
         FROM invoices WHERE placement_id = $1 ORDER BY invoice_date DESC, id DESC LIMIT 100`, [id]);

    const summary = await pool.query(
      `SELECT COALESCE(SUM(total_amount),0) AS invoiced, COALESCE(SUM(payment_received_amount),0) AS collected,
              COALESCE(SUM(balance_outstanding),0) AS outstanding, COUNT(*)::int AS invoice_count
         FROM invoices WHERE placement_id = $1`, [id]);

    return res.json({ success: true, data: { placement, summary: summary.rows[0], invoices: invoices.rows } });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

module.exports = {
  getAllPlacements,
  getPlacementById,
  getPlacementOverview,
  createPlacement,
  updatePlacement,
  deletePlacement,
};
