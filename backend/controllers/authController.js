const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const { auditLog } = require("../middleware/auditMiddleware");

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const result = await pool.query(
      `SELECT u.*, r.role_name
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE LOWER(u.email) = LOWER($1)
       LIMIT 1`,
      [normalizedEmail],
    );

    if (!result.rows.length) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

    const user = result.rows[0];

    if (user.status !== "ACTIVE") {
      return res
        .status(401)
        .json({ success: false, message: "Account is inactive" });
    }

    if (!user.password_hash || typeof user.password_hash !== "string") {
      console.error(
        `[AUTH][LOGIN] Missing/invalid password_hash for userId=${user.id}`,
      );
      return res.status(500).json({
        success: false,
        message: "Account password setup is invalid",
      });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    await pool.query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [
      user.id,
    ]);

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role_name,
      },
      process.env.JWT_SECRET,
      { expiresIn: "12h" },
    );

    await auditLog({
      userId: user.id,
      userEmail: user.email,
      action: "LOGIN",
      entityType: "users",
      entityId: user.id,
      ipAddress: req.ip,
    });

    return res.json({
      success: true,
      message: "Login successful",
      data: {
        token,
        user: {
          id: user.id,
          fullName: user.full_name,
          email: user.email,
          roleName: user.role_name,
          roleId: user.role_id,
        },
      },
    });
  } catch (err) {
    console.error("login error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const getMe = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         u.id,
         u.full_name,
         u.email,
         u.phone,
         u.status,
         u.last_login_at,
         r.role_name,
         r.id AS role_id
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE u.id = $1`,
      [req.user.id],
    );

    const u = result.rows[0];

    return res.json({
      success: true,
      data: {
        id: u.id,
        fullName: u.full_name,
        email: u.email,
        phone: u.phone,
        roleName: u.role_name,
        roleId: u.role_id,
        lastLoginAt: u.last_login_at,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const changePassword = async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({
        success: false,
        message: "Both passwords are required",
      });
    }

    if (new_password.length < 8) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 8 characters",
      });
    }

    const result = await pool.query(
      "SELECT password_hash FROM users WHERE id = $1",
      [req.user.id],
    );

    const valid = await bcrypt.compare(
      current_password,
      result.rows[0].password_hash,
    );

    if (!valid) {
      return res.status(400).json({
        success: false,
        message: "Current password is incorrect",
      });
    }

    const hash = await bcrypt.hash(new_password, 12);

    await pool.query(
      "UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2",
      [hash, req.user.id],
    );

    await auditLog({
      userId: req.user.id,
      userEmail: req.user.email,
      action: "CHANGE_PASSWORD",
      entityType: "users",
      entityId: req.user.id,
      ipAddress: req.ip,
    });

    return res.json({
      success: true,
      message: "Password changed successfully",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

module.exports = {
  login,
  getMe,
  changePassword,
};
