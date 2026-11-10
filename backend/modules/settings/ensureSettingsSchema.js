const pool = require("../../config/db");

// Idempotent, lazily-applied schema for the Settings module. Mirrors the
// ensureAttachmentsSchema / ensureApSchema pattern: safe to call on every
// request; the create/seed work only does anything the first time. This is the
// runtime guarantee behind migration 014_settings.sql (which records the same
// DDL for review) so the Settings screens work even before the migration is run
// by hand.
let _ready = false;

// Canonical list of access modules used by the role-permission matrix. Keep in
// sync with the frontend catalog (frontend/src/data/permissions.js).
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

// Seed permissions that reproduce the app's existing menu visibility exactly, so
// switching the UI to a permission-driven menu changes nothing on day one. Keyed
// by role_name (the four seeded roles). Anything not listed here is left to the
// hardcoded fallback in the frontend ACL.
const DEFAULT_ROLE_PERMISSIONS = {
  SUPER_ADMIN: PERMISSION_KEYS,
  FINANCE_ADMIN: [
    "dashboard", "clients", "invoices", "payments", "vendors", "bills",
    "vendorPayments", "approvals", "expenses", "accounting", "banking",
    "candidates", "placements", "timesheets", "regions", "settings",
  ],
  ACCOUNT_MANAGER: ["dashboard", "clients", "invoices", "candidates", "placements"],
  RECRUITER: ["dashboard", "candidates", "placements"],
};

// Numbering defaults mirror the hardcoded prefixes in utils/codeGenerator so the
// live behaviour is unchanged until a user edits them.
const NUMBERING_DEFAULTS = [
  { doc_type: "invoice", label: "Invoices", prefix: "INV", padding: 6, include_year: true },
  { doc_type: "bill", label: "Vendor Bills", prefix: "BILL", padding: 6, include_year: true },
  { doc_type: "payment", label: "Customer Payments", prefix: "PAY", padding: 6, include_year: true },
  { doc_type: "vpay", label: "Vendor Payments", prefix: "VPAY", padding: 6, include_year: true },
];

const ensureSettingsSchema = async (db = pool) => {
  if (_ready) return true;

  // --- Document numbering config ------------------------------------------
  await db.query(`
    CREATE TABLE IF NOT EXISTS document_numbering_config (
      doc_type      text PRIMARY KEY,
      label         text NOT NULL,
      prefix        text NOT NULL,
      padding       integer NOT NULL DEFAULT 6,
      include_year  boolean NOT NULL DEFAULT true,
      updated_at    timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT document_numbering_padding_check CHECK (padding BETWEEN 1 AND 12)
    )
  `);
  for (const n of NUMBERING_DEFAULTS) {
    await db.query(
      `INSERT INTO document_numbering_config (doc_type, label, prefix, padding, include_year)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (doc_type) DO NOTHING`,
      [n.doc_type, n.label, n.prefix, n.padding, n.include_year],
    );
  }

  // --- Reusable tax rates --------------------------------------------------
  await db.query(`
    CREATE TABLE IF NOT EXISTS tax_rates (
      id           serial PRIMARY KEY,
      name         text NOT NULL,
      rate_percent numeric(6,3) NOT NULL DEFAULT 0,
      region_id    integer REFERENCES regions(id) ON DELETE SET NULL,
      is_default   boolean NOT NULL DEFAULT false,
      status       text NOT NULL DEFAULT 'ACTIVE',
      created_at   timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tax_rates_status_check CHECK (status IN ('ACTIVE','INACTIVE')),
      CONSTRAINT tax_rates_rate_check CHECK (rate_percent >= 0 AND rate_percent <= 100)
    )
  `);

  // --- Role permission matrix ---------------------------------------------
  // roles.is_system marks the four seeded roles (cannot be deleted).
  await db.query(`ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false`);
  await db.query(
    `UPDATE roles SET is_system = true
      WHERE role_name IN ('SUPER_ADMIN','FINANCE_ADMIN','ACCOUNT_MANAGER','RECRUITER')`,
  );
  await db.query(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id        integer NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission_key text NOT NULL,
      PRIMARY KEY (role_id, permission_key)
    )
  `);

  // Seed default permissions ONCE per role (only if the role has none yet), so
  // re-runs never clobber a user's later edits.
  for (const [roleName, keys] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    const { rows } = await db.query(`SELECT id FROM roles WHERE role_name = $1`, [roleName]);
    if (!rows.length) continue;
    const roleId = rows[0].id;
    const existing = await db.query(
      `SELECT 1 FROM role_permissions WHERE role_id = $1 LIMIT 1`, [roleId],
    );
    if (existing.rows.length) continue;
    for (const key of keys) {
      await db.query(
        `INSERT INTO role_permissions (role_id, permission_key) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [roleId, key],
      );
    }
  }

  _ready = true;
  return true;
};

module.exports = { ensureSettingsSchema, PERMISSION_KEYS, NUMBERING_DEFAULTS };
