
const { getTenantClient } = require("../config/tenantContext");

const getAuditLogs = async (req, res) => {
  try {
    // Get the database connection for the current tenant.
    const db = getTenantClient();

    if (!db) {
      return res.status(401).json({
        success: false,
        message: "Tenant database connection not found.",
      });
    }

    const {
      entity_type,
      entity_id,
      user_id,
      action,
      page = 1,
      limit = 50,
    } = req.query;

    const currentPage = Math.max(1, Number(page) || 1);
    const pageLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    const offset = (currentPage - 1) * pageLimit;

    const conditions = [];
    const values = [];
    let idx = 1;

    if (entity_type) {
      conditions.push(`entity_type = $${idx++}`);
      values.push(entity_type);
    }

    if (entity_id) {
      conditions.push(`entity_id = $${idx++}`);
      values.push(Number(entity_id));
    }

    if (user_id) {
      conditions.push(`user_id = $${idx++}`);
      values.push(Number(user_id));
    }

    if (action) {
      conditions.push(`action = $${idx++}`);
      values.push(action);
    }

    const where = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    // RLS automatically restricts these queries to the current tenant.
    const count = await db.query(
      `SELECT COUNT(*) FROM audit_logs ${where}`,
      values
    );

    const result = await db.query(
      `SELECT *
       FROM audit_logs
       ${where}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...values, pageLimit, offset]
    );

    const total = Number(count.rows[0].count);

    return res.json({
      success: true,
      data: result.rows,
      pagination: {
        total,
        page: currentPage,
        limit: pageLimit,
        pages: Math.ceil(total / pageLimit),
      },
    });
  } catch (err) {
    console.error("Get audit logs error:", err);

    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

module.exports = {
  getAuditLogs,
};
