const pool = require("../config/db");

const getAuditLogs = async (req, res) => {
  try {
    const {
      entity_type,
      entity_id,
      user_id,
      action,
      page = 1,
      limit = 50,
    } = req.query;
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

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const offset = (Number(page) - 1) * Number(limit);

    const count = await pool.query(
      `SELECT COUNT(*) FROM audit_logs ${where}`,
      values,
    );

    const result = await pool.query(
      `SELECT *
       FROM audit_logs
       ${where}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...values, Number(limit), offset],
    );

    return res.json({
      success: true,
      data: result.rows,
      pagination: {
        total: Number(count.rows[0].count),
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(Number(count.rows[0].count) / Number(limit)),
      },
    });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

module.exports = {
  getAuditLogs,
};
