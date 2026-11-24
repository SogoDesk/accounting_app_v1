
const pool = require("../../config/db");
const {
  getTenantId,
  getTenantClient,
} = require("../../config/tenantContext");

// Permission keys used by the application.
const PERMISSION_KEYS = [
  "dashboard",
  "clients",
  "invoices",
  "payments",
  "vendors",
  "bills",
  "vendorPayments",
  "approvals",
  "expenses",
  "accounting",
  "banking",
  "candidates",
  "placements",
  "timesheets",
  "regions",
  "users",
  "auditLogs",
  "settings",
];

const DEFAULT_ROLE_PERMISSIONS = {
  SUPER_ADMIN: PERMISSION_KEYS,
  FINANCE_ADMIN: [
    "dashboard", "clients", "invoices", "payments",
    "vendors", "bills", "vendorPayments", "approvals",
    "expenses", "accounting", "banking", "candidates",
    "placements", "timesheets", "regions", "settings",
  ],
  ACCOUNT_MANAGER: [
    "dashboard", "clients", "invoices", "candidates", "placements",
  ],
  RECRUITER: [
    "dashboard", "candidates", "placements",
  ],
};

const NUMBERING_DEFAULTS = [
  {
    doc_type: "invoice",
    label: "Invoices",
    prefix: "INV",
    padding: 6,
    include_year: true,
  },
  {
    doc_type: "bill",
    label: "Vendor Bills",
    prefix: "BILL",
    padding: 6,
    include_year: true,
  },
  {
    doc_type: "payment",
    label: "Customer Payments",
    prefix: "PAY",
    padding: 6,
    include_year: true,
  },
  {
    doc_type: "vpay",
    label: "Vendor Payments",
    prefix: "VPAY",
    padding: 6,
    include_year: true,
  },
];

const readyTenants = new Set();
const initializingTenants = new Map();

const getValidTenantId = () => {
  const tenantId = Number(getTenantId());

  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new Error("Valid tenant context is required for settings initialization.");
  }

  return tenantId;
};

const getTenantDb = (db) => {
  const tenantDb = db || getTenantClient();

  if (!tenantDb) {
    throw new Error("Tenant database connection is required for settings initialization.");
  }

  return tenantDb;
};

const initializeTenantSettings = async (db, tenantId) => {
  await db.query(
    `UPDATE roles
        SET is_system = true
      WHERE tenant_id = $1
        AND role_name = ANY($2::text[])`,
    [tenantId, Object.keys(DEFAULT_ROLE_PERMISSIONS)]
  );

  for (const item of NUMBERING_DEFAULTS) {
    await db.query(
      `INSERT INTO document_numbering_config
       (tenant_id, doc_type, label, prefix, padding, include_year)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, doc_type) DO NOTHING`,
      [
        tenantId,
        item.doc_type,
        item.label,
        item.prefix,
        item.padding,
        item.include_year,
      ]
    );
  }

  for (const [roleName, permissionKeys] of Object.entries(
    DEFAULT_ROLE_PERMISSIONS
  )) {
    const roleResult = await db.query(
      `SELECT id
         FROM roles
        WHERE tenant_id = $1
          AND role_name = $2
        LIMIT 1`,
      [tenantId, roleName]
    );

    if (!roleResult.rows.length) continue;

    const roleId = roleResult.rows[0].id;

    const existing = await db.query(
      `SELECT 1
         FROM role_permissions
        WHERE tenant_id = $1
          AND role_id = $2
        LIMIT 1`,
      [tenantId, roleId]
    );

    if (existing.rows.length) continue;

    for (const permissionKey of permissionKeys) {
      await db.query(
        `INSERT INTO role_permissions
         (role_id, permission_key, tenant_id)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [roleId, permissionKey, tenantId]
      );
    }
  }
};

const ensureSettingsSchema = async (db) => {
  const tenantId = getValidTenantId();
  const tenantDb = getTenantDb(db);

  if (readyTenants.has(tenantId)) return true;

  if (initializingTenants.has(tenantId)) {
    return initializingTenants.get(tenantId);
  }

  const initialization = (async () => {
    await initializeTenantSettings(tenantDb, tenantId);
    readyTenants.add(tenantId);
    return true;
  })();

  initializingTenants.set(tenantId, initialization);

  try {
    return await initialization;
  } finally {
    initializingTenants.delete(tenantId);
  }
};

module.exports = {
  ensureSettingsSchema,
  PERMISSION_KEYS,
  NUMBERING_DEFAULTS,
};
