import { useEffect, useMemo, useState } from 'react'
import { Link, useParams, useLocation } from 'react-router-dom'
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts'
import api from '../../services/api'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const toNum = (v) => { const n = Number(v || 0); return Number.isNaN(n) ? 0 : n }
const money = (n, ccy = 'USD') => { try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: ccy, maximumFractionDigits: 0 }).format(toNum(n)) } catch { return `${ccy} ${Math.round(toNum(n)).toLocaleString()}` } }
const compact = (n) => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(toNum(n))
const day = (v) => String(v || '').slice(0, 10)

const ENTITY_COLORS = ['#00897b', '#26a69a', '#c8842a', '#4db6ac', '#9a5e15', '#80cbc4']
const STATUS_TONE = {
  RECORDED: { bg: 'var(--primary-soft)', fg: 'var(--primary-text)' },
  REIMBURSED: { bg: 'var(--success-soft)', fg: 'var(--success)' },
  CANCELLED: { bg: 'var(--danger-soft)', fg: 'var(--danger)' },
}

export default function CategoryDetailPage() {
  const { id } = useParams()
  const location = useLocation()
  // Return to whichever page opened this 360 view (falls back to Categories
  // for deep links / refreshes where there's no navigation state).
  const back = location.state?.from || '/expenses/categories'
  const backLabel = location.state?.label || 'categories'
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true)
    api.get(`/expenses/categories/${id}/overview`)
      .then((r) => setData(r.data.data))
      .catch((e) => setError(e.response?.data?.message || e.message))
      .finally(() => setLoading(false))
  }, [id])

  const ccy = data?.currency || 'USD'
  const entityMax = useMemo(() => Math.max(...(data?.byEntity || []).map((e) => toNum(e.total)), 1), [data])
  const trend = useMemo(() => (data?.byMonth || []).map((m) => ({ label: MONTHS[m.month - 1], total: toNum(m.total) })), [data])

  if (loading) return <div className="dashboard-page"><div className="table-card glass-card" style={{ padding: 24 }}><span className="text-muted">Loading…</span></div></div>
  if (error || !data) return <div className="dashboard-page"><div className="table-card glass-card" style={{ padding: 24 }}><span className="text-muted">{error || 'Not found'}</span></div></div>

  const cat = data.category, s = data.summary
  const tip = { borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 12 }

  return (
    <div className="dashboard-page">
      <div style={{ marginBottom: 8 }}><Link to={back} className="db-link">← Back to {backLabel}</Link></div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{cat.name}</h1>
          <p className="page-subtitle">
            {cat.account_code ? `Ledger ${cat.account_code} · ${cat.gl_account_name}` : 'No ledger account mapped'} · all amounts consolidated to {ccy}
          </p>
        </div>
        <span className="badge" style={{ background: cat.is_active ? 'var(--success-soft)' : 'var(--surface3)', color: cat.is_active ? 'var(--success)' : 'var(--text2)' }}>
          {cat.is_active ? 'active' : 'inactive'}
        </span>
      </div>

      <div className="stats-grid stats-grid-four" style={{ marginBottom: 16 }}>
        <div className="stat-card"><div className="text-muted text-sm">Total spend ({ccy})</div><div className="fw-bold" style={{ fontSize: 24 }}>{money(s.total, ccy)}</div></div>
        <div className="stat-card"><div className="text-muted text-sm">Expenses</div><div className="fw-bold" style={{ fontSize: 24 }}>{s.count.toLocaleString()}</div></div>
        <div className="stat-card"><div className="text-muted text-sm">Fixed</div><div className="fw-bold" style={{ fontSize: 24 }}>{money(s.fixed, ccy)}</div></div>
        <div className="stat-card"><div className="text-muted text-sm">Variable</div><div className="fw-bold" style={{ fontSize: 24 }}>{money(s.variable, ccy)}</div></div>
      </div>

      <div className="db-two" style={{ marginBottom: 16 }}>
        <div className="table-card glass-card">
          <div className="table-toolbar"><strong>Monthly trend</strong><span className="text-muted text-sm">{data.year} · {ccy}</span></div>
          <div style={{ height: 240, padding: '8px 8px 0' }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trend}>
                <defs>
                  <linearGradient id="catFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#00796b" stopOpacity={0.28} />
                    <stop offset="100%" stopColor="#00796b" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 12, fill: 'var(--text2)' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 12, fill: 'var(--text2)' }} axisLine={false} tickLine={false} tickFormatter={compact} width={44} />
                <Tooltip formatter={(v) => money(v, ccy)} contentStyle={tip} />
                <Area type="monotone" dataKey="total" name="Spend" stroke="#00796b" strokeWidth={2.5} fill="url(#catFill)" dot={{ r: 3, fill: '#00796b', strokeWidth: 0 }} activeDot={{ r: 5 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="table-card glass-card">
          <div className="table-toolbar"><strong>Spend by location</strong><span className="text-muted text-sm">consolidated {ccy}</span></div>
          <div className="db-age" style={{ padding: '8px 4px 12px' }}>
            {data.byEntity.length === 0 ? <div className="db-empty">No spend recorded.</div> : data.byEntity.map((e, i) => (
              <div key={e.name} className="db-age-row" style={{ gridTemplateColumns: '120px 1fr auto' }}>
                <span className="db-age-label" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.name}</span>
                <span className="db-age-track"><span className="db-age-fill" style={{ width: `${Math.max(2, Math.round((toNum(e.total) / entityMax) * 100))}%`, background: ENTITY_COLORS[i % ENTITY_COLORS.length] }} /></span>
                <span className="db-age-val">{money(e.total, ccy)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="table-card glass-card">
        <div className="table-toolbar">
          <strong>Recent expenses</strong>
          <Link to={`/expenses?categoryId=${cat.id}&type=`} className="db-link">View all in register →</Link>
        </div>
        <div className="table-wrap">
          <table className="saas-table">
            <thead><tr>
              <th>Date</th><th>Location</th><th>Description</th><th>Payee</th>
              <th style={{ textAlign: 'right' }}>Total</th><th>Status</th>
            </tr></thead>
            <tbody>
              {data.recent.length === 0 ? <tr><td colSpan={6} className="empty-row">No expenses in this category yet.</td></tr>
              : data.recent.map((r) => {
                const t = STATUS_TONE[r.status] || STATUS_TONE.RECORDED
                return (
                  <tr key={r.id}>
                    <td>{day(r.expense_date)}</td>
                    <td>{r.entity_name}{r.expense_type === 'FIXED' && <span className="badge badge-gray" style={{ marginLeft: 6 }}>fixed</span>}</td>
                    <td className="text-muted text-sm">{r.description}</td>
                    <td>{r.is_reimbursable ? `${r.paid_by || 'Staff'} (reimb.)` : (r.vendor_name || r.payment_method_name || '')}</td>
                    <td className="td-mono fw-bold" style={{ textAlign: 'right' }}>{money(r.total_amount, r.currency)}</td>
                    <td><span className="badge" style={{ background: t.bg, color: t.fg }}>{String(r.status).toLowerCase()}</span></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
