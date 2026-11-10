import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import api from '../services/api'
import InvoiceViewModal from '../components/InvoiceViewModal'

const toNum = (v) => { const n = Number(v || 0); return Number.isNaN(n) ? 0 : n }
const money = (n, ccy = 'USD') => { try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: ccy, maximumFractionDigits: 0 }).format(toNum(n)) } catch { return `${ccy} ${Math.round(toNum(n)).toLocaleString()}` } }
const day = (v) => String(v || '').slice(0, 10)

const TONE = {
  PAID: { bg: 'var(--success-soft)', fg: 'var(--success)' },
  SENT: { bg: 'var(--primary-soft)', fg: 'var(--primary-text)' },
  GENERATED: { bg: 'var(--primary-soft)', fg: 'var(--primary-text)' },
  OVERDUE: { bg: 'var(--danger-soft)', fg: 'var(--danger)' },
  PARTIALLY_PAID: { bg: 'var(--warning-soft)', fg: 'var(--warning)' },
  DRAFT: { bg: 'var(--surface3)', fg: 'var(--text2)' },
}
const pill = (s) => TONE[String(s || '').toUpperCase()] || TONE.DRAFT

export default function CandidateDetailPage() {
  const { id } = useParams()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [viewInvoiceId, setViewInvoiceId] = useState(null)

  useEffect(() => {
    setLoading(true)
    api.get(`/candidates/${id}/overview`).then((r) => setData(r.data.data)).catch((e) => setError(e.response?.data?.message || e.message)).finally(() => setLoading(false))
  }, [id])

  if (loading) return <div className="dashboard-page"><div className="table-card glass-card" style={{ padding: 24 }}><span className="text-muted">Loading…</span></div></div>
  if (error || !data) return <div className="dashboard-page"><div className="table-card glass-card" style={{ padding: 24 }}><span className="text-muted">{error || 'Not found'}</span></div></div>

  const c = data.candidate, s = data.summary
  const ccy = data.placements[0]?.currency || 'USD'

  return (
    <div className="dashboard-page">
      <div style={{ marginBottom: 8 }}><Link to="/candidates" className="db-link">← Back to candidates</Link></div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{c.full_name}</h1>
          <p className="page-subtitle">{c.candidate_code ? `${c.candidate_code} · ` : ''}{c.job_title || 'Candidate'}{c.country ? ` · ${c.country}` : ''}{c.email ? ` · ${c.email}` : ''}</p>
        </div>
        <span className="badge badge-gray">{c.status}</span>
      </div>

      <div className="stats-grid stats-grid-four" style={{ marginBottom: 16 }}>
        <div className="stat-card"><div className="text-muted text-sm">Active placements</div><div className="fw-bold" style={{ fontSize: 24 }}>{s.active_count}</div></div>
        <div className="stat-card"><div className="text-muted text-sm">Total placements</div><div className="fw-bold" style={{ fontSize: 24 }}>{s.placement_count}</div></div>
        <div className="stat-card"><div className="text-muted text-sm">Invoiced</div><div className="fw-bold" style={{ fontSize: 24 }}>{money(s.invoiced, ccy)}</div></div>
        <div className="stat-card"><div className="text-muted text-sm">Outstanding</div><div className="fw-bold" style={{ fontSize: 24 }}>{money(s.outstanding, ccy)}</div></div>
      </div>

      {c.skills && (
        <div className="table-card glass-card" style={{ marginBottom: 16, padding: '12px 16px' }}>
          <div className="text-muted text-sm" style={{ marginBottom: 4 }}>Skills</div>
          <div style={{ fontSize: 13 }}>{c.skills}</div>
        </div>
      )}

      <div className="table-card glass-card">
        <div className="table-toolbar"><strong>Placements</strong><span className="text-muted text-sm">{s.placement_count} total</span></div>
        <div className="table-wrap">
          <table className="saas-table">
            <thead><tr><th>Code</th><th>Role</th><th>Client</th><th style={{ textAlign: 'right' }}>Bill rate</th><th style={{ textAlign: 'right' }}>Pay rate</th><th>Status</th></tr></thead>
            <tbody>
              {data.placements.length === 0 ? <tr><td colSpan={6} className="empty-row">No placements.</td></tr>
              : data.placements.map((p) => (
                <tr key={p.id}>
                  <td className="td-mono"><Link to={`/placements/${p.id}`} style={{ color: 'var(--primary)', textDecoration: 'none' }}>{p.placement_code}</Link></td>
                  <td>{p.job_title}</td>
                  <td><Link to={`/clients/${p.client_id}`} style={{ color: 'var(--primary)', textDecoration: 'none' }}>{p.client_name}</Link></td>
                  <td className="td-mono" style={{ textAlign: 'right' }}>{money(p.bill_rate, p.currency)}</td>
                  <td className="td-mono" style={{ textAlign: 'right' }}>{money(p.pay_rate, p.currency)}</td>
                  <td><span className="badge badge-gray">{p.placement_status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="table-card glass-card" style={{ marginTop: 16 }}>
        <div className="table-toolbar"><strong>Invoices</strong><span className="text-muted text-sm">{(data.invoices || []).length} total</span></div>
        <div className="table-wrap">
          <table className="saas-table">
            <thead><tr><th>Invoice</th><th>Placement</th><th>Client</th><th>Date</th><th style={{ textAlign: 'right' }}>Total</th><th style={{ textAlign: 'right' }}>Outstanding</th><th>Status</th></tr></thead>
            <tbody>
              {(data.invoices || []).length === 0 ? <tr><td colSpan={7} className="empty-row">No invoices yet.</td></tr>
              : data.invoices.map((inv) => { const t = pill(inv.invoice_status); return (
                <tr key={inv.id}>
                  <td className="td-mono"><button type="button" className="cd-linkbtn" title="View invoice details" onClick={() => setViewInvoiceId(inv.id)}>{inv.invoice_number}</button></td>
                  <td className="td-mono">{inv.placement_code || '—'}</td>
                  <td>{inv.client_name || '—'}</td>
                  <td>{day(inv.invoice_date)}</td>
                  <td className="td-mono" style={{ textAlign: 'right' }}>{money(inv.total_amount, inv.currency)}</td>
                  <td className="td-mono" style={{ textAlign: 'right' }}>{money(inv.balance_outstanding, inv.currency)}</td>
                  <td><span className="badge" style={{ background: t.bg, color: t.fg }}>{String(inv.invoice_status).replace(/_/g, ' ').toLowerCase()}</span></td>
                </tr>
              ) })}
            </tbody>
          </table>
        </div>
      </div>

      <InvoiceViewModal invoiceId={viewInvoiceId} onClose={() => setViewInvoiceId(null)} />
    </div>
  )
}
