// Access modules for the role-permission matrix. Keep in sync with the backend
// (backend/modules/settings/ensureSettingsSchema.js PERMISSION_KEYS).
export const PERMISSION_LABELS = {
  dashboard: 'Dashboard',
  clients: 'Clients',
  invoices: 'Invoices',
  payments: 'Payments',
  vendors: 'Vendors',
  bills: 'Bills',
  vendorPayments: 'Vendor Payments',
  approvals: 'Approvals',
  expenses: 'Expenses',
  accounting: 'Accounting',
  banking: 'Banking & Reconciliation',
  candidates: 'Candidates',
  placements: 'Placements',
  timesheets: 'Timesheets',
  regions: 'Regions',
  users: 'Users',
  auditLogs: 'Audit Logs',
  settings: 'Settings (config)',
}

// Grouped for a readable permission matrix in the Roles tab.
export const PERMISSION_GROUPS = [
  { label: 'General', keys: ['dashboard'] },
  { label: 'Sales', keys: ['clients', 'invoices', 'payments'] },
  { label: 'Purchases', keys: ['vendors', 'bills', 'vendorPayments', 'approvals'] },
  { label: 'Money', keys: ['expenses', 'accounting', 'banking'] },
  { label: 'Workforce', keys: ['candidates', 'placements', 'timesheets'] },
  { label: 'Administration', keys: ['regions', 'users', 'auditLogs', 'settings'] },
]

export const ALL_PERMISSION_KEYS = PERMISSION_GROUPS.flatMap((g) => g.keys)
