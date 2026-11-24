
const pool = require("../config/db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { auditLog } = require("../middleware/auditMiddleware");
const { runWithTenant } = require("../config/tenantContext");

// LOGIN
const login = async (req, res) => {
  try {
    const { email, password, tenant } = req.body;

    // 1. Validate input
    if (!email || !password || !tenant) {
      return res.status(400).json({
        success: false,
        message: "Company code, email and password are required",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedTenant = String(tenant).trim().toLowerCase();

    // 2. Find company using company code
    const tenantResult = await pool.query(
      `SELECT id, tenant_name, tenant_code, status
       FROM tenants
       WHERE LOWER(tenant_code) = $1
       LIMIT 1`,
      [normalizedTenant]
    );

    if (!tenantResult.rows.length) {
      return res.status(401).json({
        success: false,
        message: "Invalid company code",
      });
    }

    const tenantInfo = tenantResult.rows[0];

    if (tenantInfo.status !== "ACTIVE") {
      return res.status(403).json({
        success: false,
        message: "Company account is inactive",
      });
    }

    // 3. users / roles / audit_logs have FORCED row-level security, so the
    //    rest of login must run on a connection tagged with this tenant.
    return await withTenantConnection(tenantInfo.id, () =>
      completeLogin(req, res, tenantInfo, normalizedEmail, password)
    );
  } catch (err) {
    console.error("[AUTH][LOGIN]", err);

    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

// Run fn with pool.query routed to a dedicated client whose app.tenant_id is
// set (same mechanism as tenantMiddleware, for routes that run before it).
const withTenantConnection = async (tenantId, fn) => {
  const client = await pool.connect();
  let releaseErr;
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, false)", [
      String(tenantId),
    ]);
    return await runWithTenant(client, tenantId, fn);
  } finally {
    try {
      await client.query("SELECT set_config('app.tenant_id', '', false)");
    } catch (err) {
      releaseErr = err; // destroy the connection rather than reuse it tagged
    }
    client.release(releaseErr);
  }
};

const completeLogin = async (req, res, tenantInfo, normalizedEmail, password) => {
    // Find user inside the selected company
    const result = await pool.query(
      `SELECT *
       FROM users
       WHERE LOWER(email) = $1
         AND tenant_id = $2
       LIMIT 1`,
      [normalizedEmail, tenantInfo.id]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const user = result.rows[0];

    // 4. Check user status
    if (user.status !== "ACTIVE") {
      return res.status(401).json({
        success: false,
        message: "Account is inactive",
      });
    }

    // 5. Check password hash
    if (!user.password_hash) {
      return res.status(500).json({
        success: false,
        message: "Account password setup is invalid",
      });
    }

    // 6. Verify password
    const isPasswordValid = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    // 7. Find user's role in the selected company
    const roleResult = await pool.query(
      `SELECT id, role_name
       FROM roles
       WHERE id = $1 AND tenant_id = $2`,
      [user.role_id, tenantInfo.id]
    );

    if (!roleResult.rows.length) {
      return res.status(403).json({
        success: false,
        message: "User role not found",
      });
    }

    const role = roleResult.rows[0];

    // 8. Generate JWT token
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: role.role_name,
        tenant_id: user.tenant_id,
      },
      process.env.JWT_SECRET,
      { expiresIn: "12h" }
    );

    // 9. Record login in audit log
    await auditLog({
      tenantId: user.tenant_id,
      userId: user.id,
      userEmail: user.email,
      action: "LOGIN",
      entityType: "users",
      entityId: user.id,
      ipAddress: req.ip,
    });

    // 10. Send successful login response
    return res.json({
      success: true,
      message: "Login successful",
      data: {
        token,
        user: {
          id: user.id,
          fullName: user.full_name,
          email: user.email,
          roleName: role.role_name,
          roleId: role.id,
          tenant_id: user.tenant_id,
        },
        tenant: {
          id: tenantInfo.id,
          name: tenantInfo.tenant_name,
          slug: tenantInfo.tenant_code,
          code: tenantInfo.tenant_code,
        },
      },
    });
};

// GET LOGGED-IN USER
const getMe = async (req, res) => {
  try {
    const userId = req.user?.id;
    const tenantId = req.user?.tenant_id;

    if (!userId || !tenantId) {
      return res.status(401).json({
        success: false,
        message: "Invalid user information",
      });
    }

    const result = await pool.query(
  `SELECT
     u.id,
     u.full_name,
     u.email,
     u.role_id,
     u.tenant_id,
     u.is_platform_admin,
     r.role_name,
     t.tenant_name,
     t.tenant_code
   FROM users u
   LEFT JOIN roles r
     ON r.id = u.role_id
    AND r.tenant_id = u.tenant_id
   LEFT JOIN tenants t
     ON t.id = u.tenant_id
   WHERE u.id = $1
     AND u.tenant_id = $2
   LIMIT 1`,
  [userId, tenantId]
);

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const user = result.rows[0];
return res.json({
  success: true,
  data: {
    user: {
      id: user.id,
      fullName: user.full_name,
      email: user.email,
      roleId: user.role_id,
      roleName: user.role_name,
      tenant_id: user.tenant_id,
      is_platform_admin: user.is_platform_admin === true,
    },
    tenant: {
      id: user.tenant_id,
      name: user.tenant_name,
      slug: user.tenant_code,
      code: user.tenant_code,
    },
  },
});
  } catch (err) {
    console.error("[AUTH][GET_ME]", err);

    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

// CHANGE PASSWORD
const changePassword = async (req, res) => {
  try {
    const userId = req.user?.id;
    const tenantId = req.user?.tenant_id;
    const { currentPassword, newPassword } = req.body;

    if (!userId || !tenantId) {
      return res.status(401).json({
        success: false,
        message: "Invalid user information",
      });
    }

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Current password and new password are required",
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: "New password must contain at least 8 characters",
      });
    }

    const result = await pool.query(
      `SELECT password_hash
       FROM users
       WHERE id = $1 AND tenant_id = $2
       LIMIT 1`,
      [userId, tenantId]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const user = result.rows[0];

    const isPasswordValid = await bcrypt.compare(
      currentPassword,
      user.password_hash
    );

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: "Current password is incorrect",
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await pool.query(
      `UPDATE users
       SET password_hash = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND tenant_id = $3`,
      [hashedPassword, userId, tenantId]
    );

    return res.json({
      success: true,
      message: "Password changed successfully",
    });

  } catch (err) {
    console.error("[AUTH][CHANGE_PASSWORD]", err);

    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

// EXPORT FUNCTIONS AT THE VERY BOTTOM
module.exports = {
  login,
  getMe,
  changePassword,
};
