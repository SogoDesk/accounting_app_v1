// =============================================================================
// scopeMiddleware — row-level RBAC scoping (Blueprint Step 2 / audit §3.4)
//
// Runs after authenticate. Expands the caller's org-unit grants (cascading to
// descendants) via user_allowed_locations() and attaches:
//   req.allowedLocationIds  — bigint[] of org_units the user can reach
//   req.allowedEntityIds    — int[]   of owning entities (== regions.id) the
//                             user can see/act on. Use as `entity_id = ANY($n)`.
//   req.allowedAccessByLocation — Map(locationId -> 'VIEW'|'EDIT'|'POST'|'ADMIN')
//   req.scopeEnforced       — true when scoping data was loaded; false means the
//                             RBAC tables are not migrated yet (fail-open so the
//                             app keeps working pre-rollout of migration 005).
//
// Controllers append `AND entity_id = ANY($n)` with req.allowedEntityIds when
// scopeEnforced is true, and reject writes whose target entity/location is not
// in the allowed set. Never trust a body-supplied region_id/location_id.
// =============================================================================

const pool = require("../config/db");

async function rbacReady(db = pool) {
  const { rows } = await db.query(
    "SELECT to_regclass('public.user_org_access') AS t",
  );
  return rows[0].t !== null;
}

const scopeAccess = async (req, res, next) => {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    // Graceful pre-migration behaviour: if RBAC isn't installed, don't enforce.
    if (!(await rbacReady())) {
      req.allowedLocationIds = null;
      req.allowedEntityIds = null;
      req.allowedAccessByLocation = new Map();
      req.scopeEnforced = false;
      return next();
    }

    const { rows } = await pool.query(
      `SELECT ual.org_unit_id, ual.access, e.region_id AS entity_id
         FROM user_allowed_locations($1) ual
         LEFT JOIN org_units e ON e.id = owning_entity_id(ual.org_unit_id)`,
      [req.user.id],
    );

    const locationIds = new Set();
    const entityIds = new Set();
    const accessByLocation = new Map();
    for (const r of rows) {
      locationIds.add(Number(r.org_unit_id));
      accessByLocation.set(Number(r.org_unit_id), r.access);
      if (r.entity_id != null) entityIds.add(Number(r.entity_id));
    }

    req.allowedLocationIds = [...locationIds];
    req.allowedEntityIds = [...entityIds];
    req.allowedAccessByLocation = accessByLocation;
    req.scopeEnforced = true;
    return next();
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Scope resolution failed",
      error: error.message,
    });
  }
};

// Helper for controllers: may the caller write/post to this entity (region id)?
const canActOnEntity = (req, entityId) => {
  if (!req.scopeEnforced) return true; // pre-migration fail-open
  if (!Array.isArray(req.allowedEntityIds)) return true;
  return req.allowedEntityIds.includes(Number(entityId));
};

// Helper: may the caller POST/ADMIN to this specific location (org_unit id)?
const canPostToLocation = (req, locationId) => {
  if (!req.scopeEnforced) return true;
  const access = req.allowedAccessByLocation.get(Number(locationId));
  return access === "POST" || access === "ADMIN";
};

module.exports = { scopeAccess, canActOnEntity, canPostToLocation };
