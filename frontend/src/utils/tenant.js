// =============================================================================
// Tenant resolution (multi-tenant SaaS)
//
// A tenant is identified by a short slug ("acme"). It is resolved, in order:
//   1. From the subdomain, when VITE_ROOT_DOMAIN is set and the app is served
//      as <slug>.<root-domain>  (e.g. acme.sogodesk.com -> "acme").
//   2. From the company code the user typed on the login page (persisted).
//
// The slug is sent on every request as the X-Tenant header. The backend must
// treat the JWT's tenant_id as authoritative once logged in — the header is
// only used to pick the tenant at login / for public pre-login endpoints.
// =============================================================================

const STORAGE_KEY = 'tenant'
const ROOT_DOMAIN = (import.meta.env.VITE_ROOT_DOMAIN || '').toLowerCase().trim()
const RESERVED = new Set(['www', 'app', 'api', 'admin'])

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export const normalizeSlug = (value) => String(value || '').trim().toLowerCase()

export const isValidSlug = (value) => SLUG_RE.test(normalizeSlug(value))

/** Slug from the hostname, or '' when not on a tenant subdomain. */
export function getSubdomainTenant() {
  if (!ROOT_DOMAIN || typeof window === 'undefined') return ''
  const host = window.location.hostname.toLowerCase()
  if (host === ROOT_DOMAIN || !host.endsWith(`.${ROOT_DOMAIN}`)) return ''
  const sub = host.slice(0, -(ROOT_DOMAIN.length + 1))
  if (sub.includes('.') || RESERVED.has(sub) || !isValidSlug(sub)) return ''
  return sub
}

/** Stored tenant object { id, slug, name, logoUrl } or null. */
export function getStoredTenant() {
  try {
    const t = JSON.parse(localStorage.getItem(STORAGE_KEY))
    return t && typeof t === 'object' && t.slug ? t : null
  } catch {
    return null
  }
}

export function setStoredTenant(tenant) {
  try {
    if (tenant?.slug) localStorage.setItem(STORAGE_KEY, JSON.stringify(tenant))
    else localStorage.removeItem(STORAGE_KEY)
  } catch { /* storage unavailable */ }
}

export const clearStoredTenant = () => setStoredTenant(null)

/** The slug to send with requests: subdomain wins over the stored value. */
export function getTenantSlug() {
  return getSubdomainTenant() || getStoredTenant()?.slug || ''
}

/** True when the hostname already pins the tenant (hide the company field). */
export const tenantFromHost = () => !!getSubdomainTenant()
