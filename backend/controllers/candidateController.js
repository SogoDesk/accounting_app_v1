const pool = require("../config/db");
const { auditLog } = require("../middleware/auditMiddleware");
const { generateCandidateCode } = require("../utils/codeGenerator");

const toNullable = (value) => {
  if (value === undefined || value === null || value === "") return null;
  return value;
};

const getAllCandidates = async (req, res) => {
  try {
    const { status, search, entityId, page = 1, limit = 100 } = req.query;
    const conditions = [];
    const values = [];
    let idx = 1;

    if (status) {
      conditions.push(`c.status = $${idx++}`);
      values.push(status);
    }

    // Candidates now carry their own region (migration 018), so the top-nav
    // region switcher scopes them directly.
    if (entityId) {
      conditions.push(`c.region_id = $${idx++}`);
      values.push(Number(entityId));
    }

    if (search) {
      conditions.push(`(
        c.full_name ILIKE $${idx}
        OR c.email ILIKE $${idx}
        OR c.candidate_code ILIKE $${idx}
        OR c.job_title ILIKE $${idx}
      )`);
      values.push(`%${search}%`);
      idx++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await pool.query(
      `SELECT c.*, r.region_name
       FROM candidates c
       LEFT JOIN regions r ON c.region_id = r.id
       ${where}
       ORDER BY c.id DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...values, Number(limit), (Number(page) - 1) * Number(limit)],
    );

    return res.json({ success: true, data: result.rows });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

const getCandidateById = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM candidates WHERE id = $1 LIMIT 1`,
      [req.params.id],
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Candidate not found",
      });
    }

    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

const createCandidate = async (req, res) => {
  try {
    const {
      candidate_code,
      full_name,
      job_title,
      email,
      phone,
      country,
      skills,
      notes,
      status,
      tax_id,
      is_1099,
      w9_on_file,
      work_authorization,
      work_auth_expiry,
      insurance_expiry,
      region_id,
    } = req.body;

    if (!full_name) {
      return res.status(400).json({
        success: false,
        message: "Candidate name is required",
      });
    }

    let finalCandidateCode = null;

    if (candidate_code && String(candidate_code).trim()) {
      const requestedCode = String(candidate_code).trim().toUpperCase();

      const existingCode = await pool.query(
        `SELECT id FROM candidates WHERE candidate_code = $1 LIMIT 1`,
        [requestedCode],
      );

      if (existingCode.rows.length) {
        return res.status(400).json({
          success: false,
          message: "Candidate code already exists",
        });
      }

      finalCandidateCode = requestedCode;
    } else {
      finalCandidateCode = await generateCandidateCode(pool, full_name);
    }

    const result = await pool.query(
      `INSERT INTO candidates (
        candidate_code,
        full_name,
        job_title,
        email,
        phone,
        country,
        skills,
        notes,
        status,
        tax_id,
        is_1099,
        w9_on_file,
        work_authorization,
        work_auth_expiry,
        insurance_expiry,
        region_id,
        created_by
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING *`,
      [
        finalCandidateCode,
        full_name,
        toNullable(job_title),
        toNullable(email),
        toNullable(phone),
        toNullable(country),
        toNullable(skills),
        toNullable(notes),
        status || "ACTIVE",
        toNullable(tax_id),
        Boolean(is_1099),
        Boolean(w9_on_file),
        toNullable(work_authorization),
        toNullable(work_auth_expiry),
        toNullable(insurance_expiry),
        region_id ? Number(region_id) : null,
        req.user?.id || null,
      ],
    );

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "CREATE",
      entityType: "candidates",
      entityId: result.rows[0].id,
      newValues: result.rows[0],
      ipAddress: req.ip,
    });

    return res.status(201).json({
      success: true,
      message: "Candidate created",
      data: result.rows[0],
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).json({
        success: false,
        message: "Candidate code or email already exists",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

const updateCandidate = async (req, res) => {
  try {
    const { id } = req.params;

    const old = await pool.query("SELECT * FROM candidates WHERE id = $1", [
      id,
    ]);
    if (!old.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Candidate not found",
      });
    }

    const {
      candidate_code,
      full_name,
      job_title,
      email,
      phone,
      country,
      skills,
      notes,
      status,
      tax_id,
      is_1099,
      w9_on_file,
      work_authorization,
      work_auth_expiry,
      insurance_expiry,
      region_id,
    } = req.body;

    let finalCandidateCode = String(
      candidate_code || old.rows[0].candidate_code || "",
    )
      .trim()
      .toUpperCase();

    if (!finalCandidateCode) {
      finalCandidateCode = await generateCandidateCode(pool, full_name);
    } else {
      const duplicate = await pool.query(
        `SELECT id FROM candidates WHERE candidate_code = $1 AND id <> $2 LIMIT 1`,
        [finalCandidateCode, id],
      );

      if (duplicate.rows.length) {
        return res.status(400).json({
          success: false,
          message: "Candidate code already exists",
        });
      }
    }

    const result = await pool.query(
      `UPDATE candidates
       SET candidate_code=$1,
           full_name=COALESCE($2, full_name),
           job_title=$3,
           email=$4,
           phone=$5,
           country=$6,
           skills=$7,
           notes=$8,
           status=COALESCE($9, status),
           tax_id=$10,
           is_1099=$11,
           w9_on_file=$12,
           work_authorization=$13,
           work_auth_expiry=$14,
           insurance_expiry=$15,
           region_id=COALESCE($16, region_id),
           updated_at=NOW()
       WHERE id=$17
       RETURNING *`,
      [
        finalCandidateCode,
        full_name,
        toNullable(job_title),
        toNullable(email),
        toNullable(phone),
        toNullable(country),
        toNullable(skills),
        toNullable(notes),
        status,
        toNullable(tax_id),
        Boolean(is_1099),
        Boolean(w9_on_file),
        toNullable(work_authorization),
        toNullable(work_auth_expiry),
        toNullable(insurance_expiry),
        region_id ? Number(region_id) : null,
        id,
      ],
    );

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "UPDATE",
      entityType: "candidates",
      entityId: Number(id),
      oldValues: old.rows[0],
      newValues: result.rows[0],
      ipAddress: req.ip,
    });

    return res.json({
      success: true,
      message: "Candidate updated",
      data: result.rows[0],
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).json({
        success: false,
        message: "Candidate code or email already exists",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

const deleteCandidate = async (req, res) => {
  try {
    const { id } = req.params;

    const deps = await pool.query(
      `SELECT (SELECT COUNT(*) FROM placements WHERE candidate_id = $1)::int AS placements_count`,
      [id],
    );

    if ((deps.rows[0]?.placements_count || 0) > 0) {
      return res.status(400).json({
        success: false,
        message: "Cannot delete candidate with linked placements",
      });
    }

    const result = await pool.query(
      "DELETE FROM candidates WHERE id = $1 RETURNING *",
      [id],
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Candidate not found",
      });
    }

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "DELETE",
      entityType: "candidates",
      entityId: Number(id),
      oldValues: result.rows[0],
      ipAddress: req.ip,
    });

    return res.json({
      success: true,
      message: "Candidate deleted",
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

const getCandidateOverview = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const cRes = await pool.query(`SELECT c.*, r.region_name FROM candidates c LEFT JOIN regions r ON c.region_id = r.id WHERE c.id = $1 LIMIT 1`, [id]);
    if (!cRes.rows.length) return res.status(404).json({ success: false, message: "Candidate not found" });

    const placements = await pool.query(
      `SELECT pl.id, pl.placement_code, pl.job_title, pl.placement_status, pl.bill_rate, pl.pay_rate, pl.currency,
              cl.id AS client_id, cl.client_name
         FROM placements pl JOIN clients cl ON pl.client_id = cl.id
        WHERE pl.candidate_id = $1 ORDER BY pl.start_date DESC LIMIT 100`, [id]);

    const summary = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM placements WHERE candidate_id = $1) AS placement_count,
         (SELECT COUNT(*)::int FROM placements WHERE candidate_id = $1 AND placement_status = 'ACTIVE') AS active_count,
         COALESCE((SELECT SUM(i.total_amount) FROM invoices i JOIN placements p ON i.placement_id = p.id WHERE p.candidate_id = $1), 0) AS invoiced,
         COALESCE((SELECT SUM(i.payment_received_amount) FROM invoices i JOIN placements p ON i.placement_id = p.id WHERE p.candidate_id = $1), 0) AS collected,
         COALESCE((SELECT SUM(i.balance_outstanding) FROM invoices i JOIN placements p ON i.placement_id = p.id WHERE p.candidate_id = $1), 0) AS outstanding`,
      [id]);

    // Invoices across all of this candidate's placements (for the profile's
    // Invoices table + clickable view modal).
    const invoices = await pool.query(
      `SELECT i.id, i.invoice_number, i.invoice_date, i.due_date, i.total_amount,
              i.balance_outstanding, i.invoice_status, i.currency,
              pl.placement_code, cl.client_name
         FROM invoices i
         JOIN placements pl ON i.placement_id = pl.id
         LEFT JOIN clients cl ON pl.client_id = cl.id
        WHERE pl.candidate_id = $1
        ORDER BY i.invoice_date DESC, i.id DESC LIMIT 200`, [id]);

    return res.json({ success: true, data: { candidate: cRes.rows[0], summary: summary.rows[0], placements: placements.rows, invoices: invoices.rows } });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

module.exports = {
  getAllCandidates,
  getCandidateById,
  getCandidateOverview,
  createCandidate,
  updateCandidate,
  deleteCandidate,
};
