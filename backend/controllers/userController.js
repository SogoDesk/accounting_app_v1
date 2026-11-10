const bcrypt = require("bcryptjs");
const pool = require("../config/db");
const { auditLog } = require("../middleware/auditMiddleware");

const toNullable = (value) => {
  if (value === undefined || value === null || value === "") return null;
  return value;
};

const getAllUsers = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         u.id,
         u.full_name,
         u.email,
         u.phone,
         u.status,
         u.last_login_at,
         u.created_at,
         r.role_name,
         r.id AS role_id
       FROM users u
       JOIN roles r ON u.role_id = r.id
       ORDER BY u.id DESC`,
    );

    return res.json({ success: true, data: result.rows });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

const createUser = async (req, res) => {
  try {
    const { full_name, email, password, role_id, phone, status } = req.body;

    if (!full_name || !email || !password || !role_id) {
      return res
        .status(400)
        .json({ success: false, message: "Required fields missing" });
    }

    const hash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (full_name,email,password_hash,role_id,phone,status)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id,full_name,email,phone,status,role_id,created_at`,
      [
        full_name,
        email.toLowerCase().trim(),
        hash,
        role_id,
        toNullable(phone),
        status || "ACTIVE",
      ],
    );

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "CREATE",
      entityType: "users",
      entityId: result.rows[0].id,
      newValues: { ...result.rows[0], password: "[REDACTED]" },
      ipAddress: req.ip,
    });

    return res.status(201).json({
      success: true,
      message: "User created",
      data: result.rows[0],
    });
  } catch (err) {
    if (err.code === "23505") {
      return res
        .status(400)
        .json({ success: false, message: "Email already exists" });
    }

    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { full_name, email, role_id, phone, status, password } = req.body;

    const old = await pool.query(
      "SELECT id, full_name, email, phone, status, role_id FROM users WHERE id=$1",
      [id],
    );

    if (!old.rows.length) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    let hash = null;
    if (password) {
      hash = await bcrypt.hash(password, 12);
    }

    const query = hash
      ? `UPDATE users
         SET full_name=$1,email=$2,role_id=$3,phone=$4,status=$5,password_hash=$6,updated_at=NOW()
         WHERE id=$7
         RETURNING id,full_name,email,phone,status,role_id`
      : `UPDATE users
         SET full_name=$1,email=$2,role_id=$3,phone=$4,status=$5,updated_at=NOW()
         WHERE id=$6
         RETURNING id,full_name,email,phone,status,role_id`;

    const params = hash
      ? [
          full_name,
          email.toLowerCase().trim(),
          role_id,
          toNullable(phone),
          status,
          hash,
          id,
        ]
      : [
          full_name,
          email.toLowerCase().trim(),
          role_id,
          toNullable(phone),
          status,
          id,
        ];

    const result = await pool.query(query, params);

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "UPDATE",
      entityType: "users",
      entityId: Number(id),
      oldValues: old.rows[0],
      newValues: result.rows[0],
      ipAddress: req.ip,
    });

    return res.json({
      success: true,
      message: "User updated",
      data: result.rows[0],
    });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    if (Number(id) === Number(req.user?.id)) {
      return res.status(400).json({
        success: false,
        message: "You cannot delete your own account",
      });
    }

    const result = await pool.query(
      "DELETE FROM users WHERE id=$1 RETURNING id,full_name,email,phone,status,role_id",
      [id],
    );

    if (!result.rows.length) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "DELETE",
      entityType: "users",
      entityId: Number(id),
      oldValues: result.rows[0],
      ipAddress: req.ip,
    });

    return res.json({ success: true, message: "User deleted" });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

module.exports = {
  getAllUsers,
  createUser,
  updateUser,
  deleteUser,
};
