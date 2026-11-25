
const pool = require("../../config/db");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { createInvite } = require("./inviteService");
const { seedEmailDefaults } = require("../../modules/email/defaultTemplates");

// Must stay compatible with the login page, which lowercases the code and
// accepts only letters, digits and inner hyphens.
const TENANT_CODE_RE = /^[A-Z0-9](?:[A-Z0-9-]{0,48}[A-Z0-9])$/;

const DEFAULT_ROLES = [
  {
    role_name: "SUPER_ADMIN",
    description: "System Administrator",
    permissions: [
      "dashboard", "clients", "invoices", "payments", "vendors",
      "bills", "vendorPayments", "approvals", "expenses",
      "accounting", "banking", "candidates", "placements",
      "timesheets", "regions", "users", "auditLogs", "settings"
    ]
  },
  {
    role_name: "FINANCE_ADMIN",
    description: "Finance and billing access",
    permissions: [
      "dashboard", "clients", "invoices", "payments", "vendors",
      "bills", "vendorPayments", "approvals", "expenses",
      "accounting", "banking", "candidates", "placements",
      "timesheets", "regions", "settings"
    ]
  },
  {
    role_name: "ACCOUNT_MANAGER",
    description: "Client and placement management",
    permissions: [
      "dashboard", "clients", "invoices", "candidates", "placements"
    ]
  },
  {
    role_name: "RECRUITER",
    description: "Candidate and placement view",
    permissions: ["dashboard", "candidates", "placements"]
  }
];

const NUMBERING_DEFAULTS = [
  { doc_type: "bill", label: "Vendor Bills", prefix: "BILL" },
  { doc_type: "intercompany_invoice", label: "Inter-company Invoices", prefix: "IC" },
  { doc_type: "invoice", label: "Invoices", prefix: "INV" },
  { doc_type: "payment", label: "Customer Payments", prefix: "PAY" },
  { doc_type: "vpay", label: "Vendor Payments", prefix: "VPAY" }
];

const copyChartOfAccounts = async (db, sourceAccounts, tenantId) => {
  const accountMap = new Map();

  // First pass: create accounts without parent relationships.
  for (const account of sourceAccounts) {
    const result = await db.query(
      `INSERT INTO chart_of_accounts
        (account_code, account_name, account_type,
         normal_balance, parent_id, is_control, is_active, tenant_id)
       VALUES ($1, $2, $3, $4, NULL, $5, $6, $7)
       RETURNING id`,
      [
        account.account_code,
        account.account_name,
        account.account_type,
        account.normal_balance,
        account.is_control,
        account.is_active,
        tenantId
      ]
    );

    accountMap.set(account.id, result.rows[0].id);
  }

  // Second pass: restore parent-child relationships.
  for (const account of sourceAccounts) {
    if (account.parent_id !== null) {
      const newParentId = accountMap.get(account.parent_id);

      if (!newParentId) {
        throw new Error(
          `Parent account not found for ${account.account_code}`
        );
      }

      await db.query(
        `UPDATE chart_of_accounts
         SET parent_id = $1
         WHERE id = $2 AND tenant_id = $3`,
        [newParentId, accountMap.get(account.id), tenantId]
      );
    }
  }
};

const createTenantRoles = async (db, tenantId) => {
  const roleIds = {};

  for (const role of DEFAULT_ROLES) {
    const result = await db.query(
      `INSERT INTO roles
        (role_name, description, status, is_system, tenant_id)
       VALUES ($1, $2, 'ACTIVE', true, $3)
       RETURNING id`,
      [role.role_name, role.description, tenantId]
    );

    const roleId = result.rows[0].id;
    roleIds[role.role_name] = roleId;

    for (const permission of role.permissions) {
      await db.query(
        `INSERT INTO role_permissions
          (role_id, permission_key, tenant_id)
         VALUES ($1, $2, $3)`,
        [roleId, permission, tenantId]
      );
    }
  }

  return roleIds;
};

// Create the fiscal year containing today, starting on `startMonth` (1-12),
// with 12 monthly accounting periods.
const createFiscalYear = async (db, tenantId, startMonth = 1) => {
  const now = new Date();
  const month = now.getMonth() + 1;
  const startYear = month >= startMonth ? now.getFullYear() : now.getFullYear() - 1;
  const pad = (n) => String(n).padStart(2, "0");
  const startDate = `${startYear}-${pad(startMonth)}-01`;
  const label = startMonth === 1
    ? String(startYear)
    : `${startYear}-${String(startYear + 1).slice(-2)}`;

  const result = await db.query(
    `INSERT INTO fiscal_years
      (year_label, start_date, end_date, status, tenant_id)
     VALUES ($1, $2::date, ($2::date + INTERVAL '1 year - 1 day')::date, 'OPEN', $3)
     RETURNING id`,
    [label, startDate, tenantId]
  );

  const fiscalYearId = result.rows[0].id;

  await db.query(
    `INSERT INTO accounting_periods
      (fiscal_year_id, period_no, period_label,
       start_date, end_date, status, tenant_id)
     SELECT
       $1,
       n,
       to_char($2::date + (n - 1) * INTERVAL '1 month', 'Mon YYYY'),
       ($2::date + (n - 1) * INTERVAL '1 month')::date,
       ($2::date + n * INTERVAL '1 month' - INTERVAL '1 day')::date,
       'OPEN',
       $3
     FROM generate_series(1, 12) AS n`,
    [fiscalYearId, startDate, tenantId]
  );

  return { label, startDate };
};

const createCompanySettings = async (db, tenantId, currency) => {
  await db.query(
    `INSERT INTO company_settings (tenant_id, group_currency)
     VALUES ($1, $2)`,
    [tenantId, currency]
  );
};

const createDocumentNumbering = async (db, tenantId) => {
  for (const item of NUMBERING_DEFAULTS) {
    await db.query(
      `INSERT INTO document_numbering_config
        (tenant_id, doc_type, label, prefix, padding, include_year)
       VALUES ($1, $2, $3, $4, 6, true)`,
      [tenantId, item.doc_type, item.label, item.prefix]
    );
  }
};

const provisionTenant = async ({
  tenantName,
  tenantCode,
  adminName,
  adminEmail,
  currency = "USD",
  fiscalStartMonth = 1
}) => {
  if (!tenantName || !tenantCode || !adminName || !adminEmail) {
    throw new Error("All company and administrator fields are required.");
  }

  const email = String(adminEmail).trim().toLowerCase();
  const code = String(tenantCode).trim().toUpperCase();
  const ccy = String(currency || "USD").trim().toUpperCase();
  const startMonth = Number(fiscalStartMonth);

  if (!TENANT_CODE_RE.test(code)) {
    throw new Error(
      "Company code must be 2-50 letters, numbers or hyphens, and cannot start or end with a hyphen."
    );
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error("Administrator email is not valid.");
  }
  if (!/^[A-Z]{3}$/.test(ccy)) {
    throw new Error("Currency must be a 3-letter ISO code, e.g. USD.");
  }
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) {
    throw new Error("Fiscal year start month must be between 1 and 12.");
  }

  const db = await pool.connect();

  try {
    await db.query("BEGIN");

    // Create the tenant. The tenants table is platform-level.
    const tenantResult = await db.query(
      `INSERT INTO tenants (tenant_name, tenant_code)
       VALUES ($1, $2)
       RETURNING id, tenant_name, tenant_code, status`,
      [tenantName.trim(), code]
    );

    const tenant = tenantResult.rows[0];
    const tenantId = tenant.id;

    // Read the existing tenant's chart while its RLS context is active.
    await db.query(
      "SELECT set_config('app.tenant_id', $1, true)",
      ["1"]
    );

    const accountResult = await db.query(
      `SELECT id, account_code, account_name, account_type,
              normal_balance, parent_id, is_control, is_active
       FROM chart_of_accounts
       WHERE tenant_id = 1
       ORDER BY account_code`
    );

    if (accountResult.rows.length === 0) {
      throw new Error("Source tenant has no chart of accounts.");
    }

    // Switch RLS context to the new tenant.
    await db.query(
      "SELECT set_config('app.tenant_id', $1, true)",
      [String(tenantId)]
    );

    const roleIds = await createTenantRoles(db, tenantId);

    await copyChartOfAccounts(db, accountResult.rows, tenantId);

    const fiscalYear = await createFiscalYear(db, tenantId, startMonth);

    await createCompanySettings(db, tenantId, ccy);

    await createDocumentNumbering(db, tenantId);

    // Default email templates and reminder settings, in the same transaction.
    await seedEmailDefaults(db, tenantId);

    // Create the first tenant administrator. They are INACTIVE with an
    // unusable password until they accept the emailed invitation.
    const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);

    const userResult = await db.query(
      `INSERT INTO users
        (full_name, email, password_hash, role_id, tenant_id,
         status, is_platform_admin)
       VALUES ($1, $2, $3, $4, $5, 'INACTIVE', false)
       RETURNING id, full_name, email, role_id, tenant_id`,
      [
        adminName.trim(),
        email,
        passwordHash,
        roleIds.SUPER_ADMIN,
        tenantId
      ]
    );

    const admin = userResult.rows[0];
    const invite = await createInvite(db, { tenantId, userId: admin.id, email });

    await db.query("COMMIT");

    return { tenant, admin, invite, fiscalYear, currency: ccy };

  } catch (error) {
    await db.query("ROLLBACK");
    if (error.code === "23505") {
      if (String(error.constraint).includes("tenant_code")) {
        throw new Error(`Company code ${code} is already taken.`);
      }
      if (String(error.constraint).includes("email")) {
        throw new Error(`The email ${email} is already used by another account.`);
      }
    }
    throw error;
  } finally {
    db.release();
  }
};

module.exports = { provisionTenant, TENANT_CODE_RE };
