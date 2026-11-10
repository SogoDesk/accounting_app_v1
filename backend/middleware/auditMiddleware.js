const pool = require("../config/db");

const auditLog = async ({ userId, userEmail, action, entityType, entityId, oldValues, newValues, ipAddress }) => {
  try {
    await pool.query(
      `INSERT INTO audit_logs (user_id, user_email, action, entity_type, entity_id, old_values, new_values, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        userId || null,
        userEmail || null,
        action,
        entityType,
        entityId || null,
        oldValues ? JSON.stringify(oldValues) : null,
        newValues ? JSON.stringify(newValues) : null,
        ipAddress || null,
      ]
    );
  } catch (err) {
    console.error("Audit log error:", err.message);
  }
};

module.exports = { auditLog };
