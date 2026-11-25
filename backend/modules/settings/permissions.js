// Permission keys a role can be granted. Roles, their permissions and the
// numbering defaults are seeded per tenant by services/tenants/provisionTenant.js
// and, for tenant #1, by database/migrations/pgm/0002_seed_reference.sql.
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

module.exports = { PERMISSION_KEYS };
