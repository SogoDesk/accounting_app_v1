const pool = require("../config/db");
const { ensureSettingsSchema, PERMISSION_KEYS } = require("../modules/settings/ensureSettingsSchema");
const { auditLog } = require("../middleware/auditMiddleware");

// Role name is used directly by authorize() and the JWT, so keep it a safe,
// uppercase token. Callers pass a display-ish name; we normalise it.
const normRoleName = (v) =>
  String(v || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

const getAllRoles = async (_req, res) => {
  try {
    await ensureSettingsSchema();
    const result = await pool.query(
      `SELECT r.id, r.role_name, r.description, r.status, r.is_system,
              COUNT(DISTINCT u.id)::int AS user_count,
              COALESCE(ARRAY_AGG(DISTINCT rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS permissions
         FROM roles r
         LEFT JOIN users u ON u.role_id = r.id
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
        WHERE r.status = 'ACTIVE'
        GROUP BY r.id
        ORDER BY r.is_system DESC, r.id`,
    );
    return res.json({ success: true, data: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

const createRole = async (req, res) => {
  try {
    await ensureSettingsSchema();
    const role_name = normRoleName(req.body.role_name);
    const description = String(req.body.description || "").trim() || null;
    const permissions = Array.isArray(req.body.permissions)
      ? req.body.permissions.filter((k) => PERMISSION_KEYS.includes(k))
      : [];
    if (!role_name) return res.status(400).json({ success: false, message: "Role name required" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const ins = await client.query(
        `INSERT INTO roles (role_name, description, status, is_system)
         VALUES ($1, $2, 'ACTIVE', false) RETURNING id, role_name, description, status, is_system`,
        [role_name, description],
      );
      const role = ins.rows[0];
      for (const key of permissions) {
        await client.query(
          `INSERT INTO role_permissions (role_id, permission_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [role.id, key],
        );
      }
      await client.query("COMMIT");
      await auditLog({
        userId: req.user?.id, userEmail: req.user?.email, action: "CREATE",
        entityType: "roles", entityId: role.id, newValues: { ...role, permissions }, ipAddress: req.ip,
      });
      return res.status(201).json({ success: true, message: "Role created", data: { ...role, permissions } });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err.code === "23505") return res.status(400).json({ success: false, message: "A role with that name already exists" });
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

const updateRole = async (req, res) => {
  try {
    await ensureSettingsSchema();
    const { id } = req.params;
    const existing = await pool.query(`SELECT id, role_name, is_system FROM roles WHERE id = $1`, [id]);
    if (!existing.rows.length) return res.status(404).json({ success: false, message: "Role not found" });
    const role = existing.rows[0];

    const description = String(req.body.description || "").trim() || null;
    const permissions = Array.isArray(req.body.permissions)
      ? req.body.permissions.filter((k) => PERMISSION_KEYS.includes(k))
      : null;
    // System role names are immutable (authorize() depends on them); custom roles can be renamed.
    const nextName = !role.is_system && req.body.role_name ? normRoleName(req.body.role_name) : role.role_name;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE roles SET role_name = $1, description = $2, updated_at = now() WHERE id = $3`,
        [nextName, description, id],
      );
      if (permissions) {
        await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [id]);
        for (const key of permissions) {
          await client.query(
            `INSERT INTO role_permissions (role_id, permission_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [id, key],
          );
        }
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    await auditLog({
      userId: req.user?.id, userEmail: req.user?.email, action: "UPDATE",
      entityType: "roles", entityId: Number(id), newValues: { role_name: nextName, description, permissions }, ipAddress: req.ip,
    });
    return res.json({ success: true, message: "Role updated" });
  } catch (err) {
    if (err.code === "23505") return res.status(400).json({ success: false, message: "A role with that name already exists" });
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

const deleteRole = async (req, res) => {
  try {
    await ensureSettingsSchema();
    const { id } = req.params;
    const existing = await pool.query(`SELECT id, is_system FROM roles WHERE id = $1`, [id]);
    if (!existing.rows.length) return res.status(404).json({ success: false, message: "Role not found" });
    if (existing.rows[0].is_system) {
      return res.status(400).json({ success: false, message: "Built-in roles cannot be deleted" });
    }
    const inUse = await pool.query(`SELECT 1 FROM users WHERE role_id = $1 LIMIT 1`, [id]);
    if (inUse.rows.length) {
      return res.status(400).json({ success: false, message: "Role is assigned to users — reassign them first" });
    }
    await pool.query(`DELETE FROM roles WHERE id = $1`, [id]);
    await auditLog({
      userId: req.user?.id, userEmail: req.user?.email, action: "DELETE",
      entityType: "roles", entityId: Number(id), ipAddress: req.ip,
    });
    return res.json({ success: true, message: "Role deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

module.exports = { getAllRoles, createRole, updateRole, deleteRole };
