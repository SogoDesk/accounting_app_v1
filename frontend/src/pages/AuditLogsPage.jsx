import { Fragment, useEffect, useMemo, useState } from 'react'
import api from '../services/api'
import { SkeletonRows } from '../components/ui/index.jsx'
import StatCard from '../components/common/StatCard'
import { useToast } from '../context/ToastContext'

export default function AuditLogsPage() {
  const toast = useToast()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [pagination, setPagination] = useState({ total: 0, page: 1, pages: 1, limit: 50 })
  const [filters, setFilters] = useState({ entity_type: '', action: '', page: 1 })
  const [expanded, setExpanded] = useState(null)

  const load = async () => {
    try {
      setLoading(true)
      const params = new URLSearchParams()
      if (filters.entity_type) params.set('entity_type', filters.entity_type)
      if (filters.action) params.set('action', filters.action)
      params.set('page', filters.page)
      params.set('limit', 50)
      const r = await api.get(`/audit-logs?${params}`)
      setRows(r.data.data || [])
      setPagination(r.data.pagination || {})
    } catch { toast.error('Failed to load audit logs') } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [filters])

  const setFilter = (k, v) => setFilters(f => ({ ...f, [k]: v, page: 1 }))

  const ACTION_COLORS = { LOGIN: 'badge-cyan', CREATE: 'badge-green', UPDATE: 'badge-yellow', DELETE: 'badge-red', CHANGE_PASSWORD: 'badge-blue' }
  const auditStats = useMemo(() => {
    const actionGroups = new Set(rows.map((row) => String(row.action || '').toUpperCase()).filter(Boolean))
    const entityGroups = new Set(rows.map((row) => String(row.entity_type || '').toLowerCase()).filter(Boolean))
    return { visible: rows.length, actionGroups: actionGroups.size, entityGroups: entityGroups.size }
  }, [rows])

  return (
    <div className="dashboard-page audit-logs-page">
      <div className="page-header">
        <div><div className="page-title">Audit Logs</div><div className="page-subtitle">Complete activity trail — every create, update and delete is logged</div></div>
      </div>

      <div className="table-card glass-card">
        <div className="table-toolbar">
          <select className="filter-select" value={filters.entity_type} onChange={e => setFilter('entity_type', e.target.value)}>
            <option value="">All Entities</option>
            {['users','clients','candidates','placements','invoices','payments','regions'].map(e => <option key={e} value={e}>{e}</option>)}
          </select>
          <select className="filter-select" value={filters.action} onChange={e => setFilter('action', e.target.value)}>
            <option value="">All Actions</option>
            {['LOGIN','CREATE','UPDATE','DELETE','CHANGE_PASSWORD'].map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <button
            type="button"
            className="secondary-btn"
            onClick={() => setFilters({ entity_type: '', action: '', page: 1 })}
          >
            Reset
          </button>
          <span className="text-muted text-sm" style={{ marginLeft: 'auto' }}>
            {pagination.total} total entries
          </span>
        </div>
        <div className="stats-grid stats-grid-three audit-logs-stats-grid">
          <StatCard
            label="Visible Logs"
            value={auditStats.visible.toLocaleString('en-US')}
            hint="Entries currently visible with filters"
          />
          <StatCard
            label="Action Types"
            value={auditStats.actionGroups.toLocaleString('en-US')}
            hint="Unique event actions"
            tone="info"
          />
          <StatCard
            label="Entity Types"
            value={auditStats.entityGroups.toLocaleString('en-US')}
            hint="Unique entities tracked"
            tone="success"
          />
        </div>
        <div className="table-wrap">
          <table className="saas-table">
            <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Entity</th><th>Entity ID</th><th>IP Address</th><th>Details</th></tr></thead>
            <tbody>
              {loading ? <SkeletonRows cols={7} rows={10} /> : rows.length === 0
                ? <tr className="empty-row"><td colSpan={7}>No logs found</td></tr>
                : rows.map(r => (
                  <Fragment key={r.id}>
                    <tr>
                      <td className="td-muted text-sm td-mono">{new Date(r.created_at).toLocaleString()}</td>
                      <td><div style={{ fontSize: 13 }}><div className="fw-bold">{r.user_email || '—'}</div></div></td>
                      <td><span className={`badge ${ACTION_COLORS[r.action] || 'badge-gray'}`}>{r.action}</span></td>
                      <td><span className="badge badge-gray">{r.entity_type}</span></td>
                      <td className="td-mono text-sm">{r.entity_id || '—'}</td>
                      <td className="td-muted text-sm td-mono">{r.ip_address || '—'}</td>
                      <td>
                        {(r.old_values || r.new_values) && (
                          <button className="btn btn-sm btn-ghost" onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                            {expanded === r.id ? 'Hide' : 'View'} diff
                          </button>
                        )}
                      </td>
                    </tr>
                    {expanded === r.id && (
                      <tr style={{ background: 'var(--surface2)' }}>
                        <td colSpan={7} style={{ padding: '12px 16px' }}>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                            {r.old_values && (
                              <div>
                                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text3)', marginBottom: 6 }}>Before</div>
                                <pre style={{ fontSize: 11, background: 'var(--surface)', padding: 12, borderRadius: 8, border: '1px solid var(--border)', overflow: 'auto', maxHeight: 200, color: 'var(--text)' }}>
                                  {JSON.stringify(JSON.parse(typeof r.old_values === 'string' ? r.old_values : JSON.stringify(r.old_values)), null, 2)}
                                </pre>
                              </div>
                            )}
                            {r.new_values && (
                              <div>
                                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text3)', marginBottom: 6 }}>After</div>
                                <pre style={{ fontSize: 11, background: 'var(--surface)', padding: 12, borderRadius: 8, border: '1px solid var(--border)', overflow: 'auto', maxHeight: 200, color: 'var(--text)' }}>
                                  {JSON.stringify(JSON.parse(typeof r.new_values === 'string' ? r.new_values : JSON.stringify(r.new_values)), null, 2)}
                                </pre>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {pagination.pages > 1 && (
          <div className="pagination">
            <button className="page-btn" disabled={filters.page <= 1} onClick={() => setFilter('page', filters.page - 1)}>‹</button>
            {Array.from({ length: Math.min(7, pagination.pages) }, (_, i) => {
              const p = i + Math.max(1, filters.page - 3)
              if (p > pagination.pages) return null
              return <button key={p} className={`page-btn${filters.page === p ? ' active' : ''}`} onClick={() => setFilter('page', p)}>{p}</button>
            })}
            <button className="page-btn" disabled={filters.page >= pagination.pages} onClick={() => setFilter('page', filters.page + 1)}>›</button>
            <span className="page-info">Page {filters.page} of {pagination.pages} ({pagination.total} entries)</span>
          </div>
        )}
      </div>
    </div>
  )
}
