export const ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  FINANCE_ADMIN: 'FINANCE_ADMIN',
  ACCOUNT_MANAGER: 'ACCOUNT_MANAGER',
  RECRUITER: 'RECRUITER',
}

const FINANCE_TEAM = [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.FINANCE_ADMIN]
const SUPER_ONLY = [ROLES.SUPER_ADMIN]
const USER_AUDIT_TEAM = [ROLES.SUPER_ADMIN, ROLES.ADMIN]
// Delete is allowed for finance admins on operational finance modules (full CRUD),
// but Regions and user/role administration stay super-admin only.
const FINANCE_DELETE = [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.FINANCE_ADMIN]

export const PAGE_ACCESS = {
  dashboard: [],
  regions: FINANCE_TEAM,
  clients: [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.FINANCE_ADMIN, ROLES.ACCOUNT_MANAGER],
  vendors: FINANCE_TEAM,
  candidates: [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.FINANCE_ADMIN, ROLES.ACCOUNT_MANAGER, ROLES.RECRUITER],
  placements: FINANCE_TEAM,
  invoices: FINANCE_TEAM,
  payments: FINANCE_TEAM,
  bills: FINANCE_TEAM,
  vendorPayments: FINANCE_TEAM,
  banking: FINANCE_TEAM,
  approvals: FINANCE_TEAM,
  expenses: FINANCE_TEAM,
  accounting: FINANCE_TEAM,
  users: USER_AUDIT_TEAM,
  auditLogs: USER_AUDIT_TEAM,
  // Settings hub: any finance-tier user can reach it; individual tabs self-gate
  // (Users/Audit → admins, Roles & Permissions → super admin only).
  settings: FINANCE_TEAM,
}

export const ACTION_ACCESS = {
  regions: { manage: FINANCE_TEAM, delete: SUPER_ONLY },
  clients: { manage: FINANCE_TEAM, delete: FINANCE_DELETE },
  vendors: { manage: FINANCE_TEAM, delete: FINANCE_DELETE },
  candidates: { manage: FINANCE_TEAM, delete: FINANCE_DELETE },
  placements: { manage: FINANCE_TEAM, delete: FINANCE_DELETE },
  invoices: { manage: FINANCE_TEAM, delete: FINANCE_DELETE },
  payments: { manage: FINANCE_TEAM, delete: FINANCE_DELETE },
  bills: { manage: FINANCE_TEAM, delete: FINANCE_DELETE },
  vendorPayments: { manage: FINANCE_TEAM, delete: FINANCE_DELETE },
  users: { manage: SUPER_ONLY, delete: SUPER_ONLY },
}

export const hasAnyRole = (roleName, allowed = []) => {
  if (!allowed || allowed.length === 0) return true
  return allowed.includes(String(roleName || ''))
}
