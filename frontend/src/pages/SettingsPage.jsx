import { useMemo, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { ROLES } from '../utils/acl'
import { Card } from '../components/ui'
import api from '../services/api'
import { PERMISSION_LABELS } from '../data/permissions'
import RegionsPage from './RegionsPage'
import UsersPage from './UsersPage'
import AuditLogsPage from './AuditLogsPage'
import CurrenciesTab from './settings/CurrenciesTab'
import NumberingTab from './settings/NumberingTab'
import NotificationsTab from './settings/NotificationsTab'
import EmailTemplatesTab from './settings/EmailTemplatesTab'
import TaxTab from './settings/TaxTab'
import RolesTab from './settings/RolesTab'
import './SettingsPage.css'

const FINANCE = [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.FINANCE_ADMIN]
const ADMINS = [ROLES.SUPER_ADMIN, ROLES.ADMIN]

// Each tab: key (URL segment), label, gating roles, and how it renders.
const TABS = [
  { key: 'organization', label: 'Organization', roles: FINANCE, render: () => <RegionsPage /> },
  { key: 'currencies', label: 'Currencies & Rates', roles: FINANCE, render: () => <CurrenciesTab /> },
  { key: 'numbering', label: 'Numbering', roles: FINANCE, render: () => <NumberingTab /> },
  { key: 'tax', label: 'Tax & Rates', roles: FINANCE, render: () => <TaxTab /> },
  { key: 'email-templates', label: 'Email Templates', roles: FINANCE, render: () => <EmailTemplatesTab /> },
  { key: 'notifications', label: 'Notifications', roles: FINANCE, render: () => <NotificationsTab /> },
  { key: 'users', label: 'Users', roles: ADMINS, render: () => <UsersPage /> },
  { key: 'roles', label: 'Roles & Permissions', roles: [ROLES.SUPER_ADMIN], render: () => <RolesTab /> },
  { key: 'audit', label: 'Audit Logs', roles: ADMINS, render: () => <AuditLogsPage /> },
]

/* ---- Inline icons (stroked 24x24, currentColor) ---------------------- */
const I = {
  back: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>,
  plus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>,
  audit: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M9 12l2 2 4-4" /><circle cx="12" cy="12" r="9" /></svg>,
  caret: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5 9-11" /></svg>,
  lock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>,
  download: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12M7 11l5 5 5-5M5 21h14" /></svg>,
  kebab: <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="5" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="12" cy="19" r="1.7" /></svg>,
  globe: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18" /></svg>,
  fx: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8h13l-3-3M20 16H7l3 3" /></svg>,
  hash: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 3L7 21M17 3l-2 18M4 8.5h16M3 15.5h16" /></svg>,
  percent: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M19 5L5 19" /><circle cx="7.5" cy="7.5" r="2.5" /><circle cx="16.5" cy="16.5" r="2.5" /></svg>,
  bell: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" /></svg>,
  users: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9.5" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13A4 4 0 0 1 16 11" /></svg>,
}

/* ---- Representative hub content (see summary note) ------------------- */
const CARDS = [
  {
    icon: I.globe, title: 'Organisation & regions', note: '3 regions · 1 group entity', to: 'organization',
    rows: [
      { k: 'US — East', v: 'USD · active', mono: true },
      { k: 'UK — London', v: 'GBP · active', mono: true },
      { k: 'IN — Hyderabad', v: 'INR · active', mono: true },
    ],
  },
  {
    icon: I.fx, title: 'Currencies & rates', note: 'Daily feed · exchangerate-api', to: 'currencies',
    rows: [
      { k: 'Group currency', v: 'USD', mono: true },
      { k: 'GBP → USD', v: '1.2710', mono: true },
      { k: 'INR → USD', v: '0.0120', mono: true },
      { k: 'Last sync', v: '12 Dec 25 06:00', mono: true },
    ],
  },
  {
    icon: I.hash, title: 'Document numbering', note: 'Per-year sequences', to: 'numbering',
    rows: [
      { k: 'Invoice', v: 'INV-{YYYY}-{####}', mono: true },
      { k: 'Bill', v: 'BILL-{YYYY}-{####}', mono: true },
      { k: 'Payment', v: 'PAY-{YYYY}-{####}', mono: true },
      { k: 'Journal', v: 'JE-{YYYY}-{####}', mono: true },
    ],
  },
  {
    icon: I.percent, title: 'Tax & rates', note: '4 rates configured', to: 'tax',
    rows: [
      { k: 'US Sales Tax', v: '0.00%', mono: true },
      { k: 'UK VAT — standard', v: '20.00%', mono: true },
      { k: 'IN GST', v: '18.00%', mono: true },
      { k: 'Default on invoices', v: 'None' },
    ],
  },
  {
    icon: I.bell, title: 'Notifications', note: 'Invoice reminders on', to: 'notifications',
    rows: [
      { k: 'Before due', v: '3 days', mono: true },
      { k: 'On due date', v: 'Enabled' },
      { k: 'After due', v: '7, 14, 30 days', mono: true },
      { k: 'Send from', v: 'books@sogodesk.com' },
    ],
  },
  {
    icon: I.users, title: 'Users', note: '9 active users', to: 'users',
    rows: [
      { k: 'SUPER_ADMIN', v: '2', mono: true },
      { k: 'FINANCE_ADMIN', v: '3', mono: true },
      { k: 'ACCOUNT_MANAGER', v: '2', mono: true },
      { k: 'RECRUITER', v: '2', mono: true },
    ],
  },
]

// Relative "time ago" from an ISO timestamp.
function timeAgo(iso) {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30); if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}

// Turn an audit action + entity into a readable label / detail pair.
function fmtAudit(a) {
  const action = String(a.action || '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
  const entity = a.entity_type ? String(a.entity_type).replace(/_/g, ' ') : ''
  const id = a.entity_id != null ? ` #${a.entity_id}` : ''
  return { action, detail: entity ? `${entity}${id}`.trim() : '', who: a.user_email || 'System', ago: timeAgo(a.created_at) }
}

const fmtDate = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}

function SettingsHub() {
  const navigate = useNavigate()
  const go = (to) => () => navigate(`/settings/${to}`)

  const [roles, setRoles] = useState(null)     // [{ role_name, permissions:[] }]
  const [catalog, setCatalog] = useState(null) // [permission_key]
  const [audit, setAudit] = useState(null)      // [auditRow]
  const [fiscal, setFiscal] = useState(null)    // { fiscal_year, open_periods, ... }

  useEffect(() => {
    let alive = true
    Promise.all([
      api.get('/roles').then(r => r.data.data).catch(() => []),
      api.get('/settings/permission-catalog').then(r => r.data.data).catch(() => []),
      api.get('/audit-logs', { params: { limit: 6 } }).then(r => r.data.data).catch(() => []),
      api.get('/settings/fiscal').then(r => r.data.data).catch(() => null),
    ]).then(([rl, cat, au, fy]) => {
      if (!alive) return
      setRoles(rl || []); setCatalog(cat || []); setAudit(au || []); setFiscal(fy || null)
    })
    return () => { alive = false }
  }, [])

  // Build the module x role tick matrix from real data.
  const matrix = useMemo(() => {
    if (!roles || !catalog) return null
    const cols = roles.map(r => r.role_name)
    const permSets = roles.map(r => new Set(r.permissions || []))
    const rows = (catalog || []).map(key => ({
      key,
      label: PERMISSION_LABELS[key] || key,
      flags: permSets.map(set => set.has(key)),
    }))
    return { cols, rows }
  }, [roles, catalog])

  const auditRows = useMemo(() => (audit || []).slice(0, 6).map(fmtAudit), [audit])

  const fiscalRows = useMemo(() => {
    if (!fiscal || !fiscal.fiscal_year) return []
    const fyr = fiscal.fiscal_year
    const span = `${fmtDate(fyr.start_date)} — ${fmtDate(fyr.end_date)}`
    const open = (fiscal.open_periods || [])
    const openTxt = open.length ? (open.length > 4 ? `${open.slice(0, 3).join(', ')} +${open.length - 3} more` : open.join(', ')) : 'None'
    return [
      { k: 'Fiscal year', v: `FY ${fyr.year_label} · ${span}`, mono: true },
      { k: 'Open periods', v: openTxt, mono: true },
      { k: 'GL close status', v: fiscal.gl_close_status || '—' },
      { k: 'Ledger integrity', v: fiscal.ledger_integrity || '—' },
    ]
  }, [fiscal])

  return (
    <div className="set-hub">
      <div className="set-head">
        <button className="set-back" onClick={() => navigate(-1)} aria-label="Back">{I.back}</button>
        <div className="set-head-txt">
          <h1 className="set-title">Settings</h1>
          <p className="set-sub">
            Organisation, currencies, numbering, tax, notifications, users and the permission matrix.
            Changes take effect immediately.
          </p>
        </div>
        <div className="set-actions">
          <button className="set-btn" onClick={go('audit')}>{I.audit}Audit logs</button>
          <button className="set-btn set-btn-primary" onClick={go('organization')}>{I.plus}Add region</button>
        </div>
      </div>

      <div className="set-grid">
        {CARDS.map((c) => (
          <Card key={c.title} hover className="set-card" onClick={go(c.to)}>
            <div className="set-card-head">
              <span className="set-tile">{c.icon}</span>
              <div>
                <div className="set-card-title">{c.title}</div>
                <div className="set-card-note">{c.note}</div>
              </div>
              <span className="set-card-caret">{I.caret}</span>
            </div>
            <div className="set-kv">
              {c.rows.map((r) => (
                <div className="set-kv-row" key={r.k}>
                  <span className="set-kv-k">{r.k}</span>
                  <span className={`set-kv-v${r.mono ? ' mono' : ''}`}>{r.v}</span>
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>

      <div className="set-caption">{I.lock} Deletes and user administration always require SUPER_ADMIN.</div>

      <div className="set-lower">
        <Card pad>
          <div className="set-matrix-head">
            <span className="set-matrix-title">Roles &amp; permissions</span>
            <div className="set-matrix-tools">
              <button className="set-icon-btn" aria-label="Export">{I.download}</button>
              <button className="set-icon-btn" aria-label="More">{I.kebab}</button>
            </div>
          </div>
          <div className="set-matrix">
            {matrix === null ? (
              <div className="set-empty">Loading permissions…</div>
            ) : matrix.rows.length === 0 || matrix.cols.length === 0 ? (
              <div className="set-empty">No roles or permissions configured.</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th className="set-mod-col">Module</th>
                    {matrix.cols.map((r) => <th key={r}>{r.replace(/_/g, ' ')}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {matrix.rows.map((row) => (
                    <tr key={row.key}>
                      <td className="set-mod-col"><span className="set-mod-name">{row.label}</span></td>
                      {row.flags.map((on, i) => (
                        <td key={i} className="set-cell">
                          <span className={`set-tick ${on ? 'on' : 'off'}`}>{on ? I.check : null}</span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>

        <div className="set-rail">
          <Card pad>
            <div className="set-rail-head">
              <span className="set-rail-title">Audit log</span>
              <button className="set-link" onClick={go('audit')}>View all</button>
            </div>
            {audit === null ? (
              <div className="set-empty">Loading…</div>
            ) : auditRows.length === 0 ? (
              <div className="set-empty">No recent activity.</div>
            ) : auditRows.map((a, idx) => (
              <div className="set-audit-row" key={idx}>
                <div className="set-audit-main">
                  <div className="set-audit-action">{a.action}</div>
                  <div className="set-audit-detail">{a.detail}</div>
                </div>
                <div className="set-audit-meta">
                  <div className="set-audit-who">{a.who}</div>
                  <div className="set-audit-ago">{a.ago}</div>
                </div>
              </div>
            ))}
          </Card>

          <Card pad>
            <div className="set-rail-head" style={{ marginBottom: 10 }}>
              <span className="set-rail-title">Fiscal year</span>
            </div>
            {fiscal === null ? (
              <div className="set-empty">Loading…</div>
            ) : fiscalRows.length === 0 ? (
              <div className="set-empty">No fiscal year configured.</div>
            ) : (
              <div className="set-kv">
                {fiscalRows.map((r) => (
                  <div className="set-kv-row" key={r.k}>
                    <span className="set-kv-k">{r.k}</span>
                    <span className={`set-kv-v${r.mono ? ' mono' : ''}`}>{r.v}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}

export default function SettingsPage() {
  const { tab } = useParams()
  const navigate = useNavigate()
  const { hasRole } = useAuth()

  const allowed = useMemo(() => TABS.filter(t => hasRole(...t.roles)), [hasRole])

  if (allowed.length === 0) {
    return (
      <div className="dashboard-page"><div className="table-card glass-card" style={{ padding: 24 }}>
        <span className="text-muted">You don’t have access to any settings.</span>
      </div></div>
    )
  }

  // The `/settings` index renders the restyled hub. A specific `/settings/:tab`
  // preserves the existing tabbed sub-page behaviour (data fetching, routing).
  const active = allowed.find(t => t.key === tab)

  if (!tab || !active) {
    return (
      <div className="dashboard-page">
        <SettingsHub />
      </div>
    )
  }

  return (
    <div className="dashboard-page">
      <div className="settings-tabbar" role="tablist" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16, borderBottom: '1px solid var(--border)', paddingBottom: 2 }}>
        {allowed.map(t => (
          <button
            key={t.key}
            role="tab"
            aria-selected={t.key === active.key}
            className={`settings-tab${t.key === active.key ? ' is-active' : ''}`}
            onClick={() => navigate(`/settings/${t.key}`)}
            style={{
              background: t.key === active.key ? 'var(--primary-soft)' : 'transparent',
              color: t.key === active.key ? 'var(--primary-text)' : 'var(--text2)',
              border: 'none', borderBottom: t.key === active.key ? '2px solid var(--primary)' : '2px solid transparent',
              padding: '8px 14px', borderRadius: '8px 8px 0 0', cursor: 'pointer', fontWeight: 600, fontSize: 14,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div key={active.key} className="settings-tab-panel">
        {active.render()}
      </div>
    </div>
  )
}
