const pool = require("../config/db");

// =============================================================================
// permit(moduleKey, ...legacyRoles) — permission-aware route guard.
//
// Enforces the Settings → Roles & Permissions matrix on module routes:
//   • If the caller's role has a permission set defined (row(s) in
//     role_permissions), access is allowed iff that set includes `moduleKey`.
//     This makes both GRANTING (custom roles) and REVOKING (remove a module
//     from any role) take effect on the backend, not just the menu.
//   • If the role has NO permission set (or the table can't be read yet), it
//     falls back to the legacy role-name check — identical to authorize(...) —
//     so nothing breaks before the schema/seed exists.
//
// Destructive deletes and user/role administration deliberately keep a hard
// authorize('SUPER_ADMIN') floor at the route layer and are NOT converted to
// permit(), so a coarse module grant can never confer delete/admin power.
// =============================================================================

const roleName = (req) => String(req.user?.role || "");

// Effective permission keys for a role, or null when none are defined. Resilient
// by design: any DB error (e.g. table not yet created) yields null so the caller
// falls back to the legacy role check instead of failing the request.
const permsForRole = async (name) => {
  try {
    const { rows } = await pool.query(
      `SELECT rp.permission_key
         FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
        WHERE r.role_name = $1`,
      [name],
    );
    return rows.length ? rows.map((r) => r.permission_key) : null;
  } catch (_e) {
    return null;
  }
};

const permit = (moduleKey, ...legacyRoles) => {
  const legacy = legacyRoles.map((r) => String(r).toUpperCase());
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, message: "Unauthorized. User not authenticated." });
      }
      const role = roleName(req);
      const perms = await permsForRole(role);
      const allowed =
        perms === null
          ? legacy.includes(role.toUpperCase())
          : perms.includes(moduleKey);
      if (!allowed) {
        return res.status(403).json({
          success: false,
          message: "Forbidden. You do not have permission to perform this action.",
        });
      }
      return next();
    } catch (error) {
      return res.status(500).json({ success: false, message: "Authorization error.", error: error.message });
    }
  };
};

module.exports = { permit, permsForRole };
