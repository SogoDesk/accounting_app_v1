import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../../services/api'
import { useDefaultEntityId } from '../../context/EntityContext'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const money = (n) => {
  const v = Number(n || 0)
  if (!v) return '—'
  try { return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(v) }
  catch { return Math.round(v).toLocaleString() }
}

export default function MonthlySummaryPage() {
  const [ready, setReady] = useState(true)
  const [message, setMessage] = useState('')
  const [rowsRaw, setRowsRaw] = useState([])
  const [summary, setSummary] = useState(null)
  const [regions, setRegions] = useState([])
  const [year, setYear] = useState(new Date().getFullYear())
  const [entityId, setEntityId] = useState(useDefaultEntityId())
  const [loading, setLoading] = useState(true)
  const [reportCcy, setReportCcy] = useState('USD')

  const [catMap, setCatMap] = useState({})
  useEffect(() => {
    api.get('/regions').then((r) => setRegions(r.data.data || [])).catch(() => {})
    api.get('/expenses/categories', { params: { all: 'true' } }).then((r) => {
      const map = {}; (r.data.data || []).forEach((c) => { map[c.name] = c.id }); setCatMap(map)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    setLoading(true)
    const params = { year }; if (entityId) params.entityId = entityId
    api.get('/expenses/reports/by-category', { params })
      .then((r) => { setReady(r.data.ready !== false); setMessage(r.data.message || ''); setRowsRaw(r.data.data || []); setReportCcy(r.data.currency || 'USD') })
      .catch(() => {})
      .finally(() => setLoading(false))
    api.get('/expenses/reports/summary', { params: entityId ? { entityId } : {} }).then((r) => setSummary(r.data.data || null)).catch(() => {})
  }, [year, entityId])

  // build category -> [12 months] matrix
  const { matrix, monthTotals, grand } = useMemo(() => {
    const m = new Map()
    const mt = Array(12).fill(0)
    rowsRaw.forEach((r) => {
      const cat = r.category || 'Uncategorised'
      if (!m.has(cat)) m.set(cat, Array(12).fill(0))
      const idx = Number(r.month) - 1
      if (idx >= 0 && idx < 12) { m.get(cat)[idx] += Number(r.total || 0); mt[idx] += Number(r.total || 0) }
    })
    const rows = [...m.entries()].map(([cat, vals]) => ({ cat, vals, ytd: vals.reduce((s, v) => s + v, 0) }))
      .sort((a, b) => b.ytd - a.ytd)
    return { matrix: rows, monthTotals: mt, grand: mt.reduce((s, v) => s + v, 0) }
  }, [rowsRaw])

  const years = []
  for (let y = new Date().getFullYear() + 1; y >= 2023; y--) years.push(y)

  return (
    <div className="dashboard-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Monthly Summary</h1>
          <p className="page-subtitle">Expenses by category and month for the year — fixed and variable combined. Amounts in {reportCcy}{entityId ? '' : ' (all entities, consolidated)'}.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <select className="filter-select" value={entityId} onChange={(e) => setEntityId(e.target.value)}>
            <option value="">All entities</option>
            {regions.map((r) => <option key={r.id} value={r.id}>{r.region_name}</option>)}
          </select>
          <select className="filter-select" value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      {!ready ? (
        <div className="table-card glass-card" style={{ padding: 24 }}>
          <h3 style={{ marginTop: 0 }}>Expenses not enabled yet</h3>
          <p className="text-muted">{message || 'Apply migration 003 and restart the backend.'}</p>
        </div>
      ) : (
        <>
          {summary && (
            <div className="stats-grid stats-grid-three" style={{ marginBottom: 16 }}>
              <div className="stat-card"><div className="text-muted text-sm">Fixed ({summary.currency || reportCcy})</div><div className="fw-bold" style={{ fontSize: 22 }}>{money(summary.fixed)}</div></div>
              <div className="stat-card"><div className="text-muted text-sm">Variable ({summary.currency || reportCcy})</div><div className="fw-bold" style={{ fontSize: 22 }}>{money(summary.variable)}</div></div>
              <div className="stat-card"><div className="text-muted text-sm">Total ({summary.currency || reportCcy})</div><div className="fw-bold" style={{ fontSize: 22 }}>{money(summary.total)}</div></div>
            </div>
          )}

          <div className="table-card glass-card">
            <div className="table-wrap" style={{ overflowX: 'auto' }}>
              <table className="saas-table" style={{ minWidth: 900 }}>
                <thead>
                  <tr>
                    <th style={{ position: 'sticky', left: 0, background: 'var(--surface)' }}>Category</th>
                    {MONTHS.map((mo) => <th key={mo} style={{ textAlign: 'right' }}>{mo}</th>)}
                    <th style={{ textAlign: 'right' }}>YTD</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? <tr><td colSpan={14} className="empty-row">Loading…</td></tr>
                  : matrix.length === 0 ? <tr><td colSpan={14} className="empty-row">No expenses recorded for {year}.</td></tr>
                  : matrix.map((row) => (
                    <tr key={row.cat}>
                      <td className="fw-bold" style={{ position: 'sticky', left: 0, background: 'var(--surface)' }}>{catMap[row.cat] ? <Link to={`/expenses/categories/${catMap[row.cat]}`} state={{ from: '/expenses/summary', label: 'Monthly Summary' }} style={{ color: 'var(--primary)', textDecoration: 'none' }}>{row.cat}</Link> : row.cat}</td>
                      {row.vals.map((v, i) => <td key={i} className="td-mono" style={{ textAlign: 'right', color: v ? 'var(--text)' : 'var(--text3)' }}>{money(v)}</td>)}
                      <td className="td-mono fw-bold" style={{ textAlign: 'right' }}>{money(row.ytd)}</td>
                    </tr>
                  ))}
                </tbody>
                {matrix.length > 0 && (
                  <tfoot>
                    <tr>
                      <td className="fw-bold" style={{ position: 'sticky', left: 0, background: 'var(--surface)' }}>Total</td>
                      {monthTotals.map((v, i) => <td key={i} className="td-mono fw-bold" style={{ textAlign: 'right' }}>{money(v)}</td>)}
                      <td className="td-mono fw-bold" style={{ textAlign: 'right' }}>{money(grand)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
