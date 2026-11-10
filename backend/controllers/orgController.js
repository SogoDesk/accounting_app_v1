const pool = require("../config/db");

async function ready(db = pool) {
  const { rows } = await db.query("SELECT to_regclass('public.org_units') AS t");
  return rows[0].t !== null;
}

// GET /api/org-units  -> flat list (ordered by path) + nested tree
const listOrgUnits = async (req, res) => {
  try {
    if (!(await ready())) {
      return res.json({ success: true, ready: false, message: "Org hierarchy not enabled. Apply migration 004.", data: [], tree: [] });
    }
    // Row-level RBAC: restrict to org units the caller can reach (self + descendants
    // of their grants). allowedLocationIds is exactly that expanded set.
    const params = [];
    let scopeSql = "";
    if (req.scopeEnforced && Array.isArray(req.allowedLocationIds)) {
      params.push(req.allowedLocationIds);
      scopeSql = `WHERE o.id = ANY($1)`;
    }
    const { rows } = await pool.query(
      `SELECT o.id, o.parent_id, o.unit_type, o.code, o.name, o.is_legal_entity,
              o.functional_currency, o.region_id, o.path, o.depth, o.status
         FROM org_units o ${scopeSql} ORDER BY o.path`, params);

    // build a nested tree
    const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] }]));
    const tree = [];
    byId.forEach((node) => {
      if (node.parent_id && byId.has(node.parent_id)) byId.get(node.parent_id).children.push(node);
      else tree.push(node);
    });
    return res.json({ success: true, ready: true, data: rows, tree });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

module.exports = { listOrgUnits };
