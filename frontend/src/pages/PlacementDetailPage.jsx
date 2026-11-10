import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import api from '../services/api'
import { BILLING_TYPE_LABELS, billingFamily, placementMargin } from '../data/billingTypes'
import InvoiceViewModal from '../components/InvoiceViewModal'

const toNum = (v) => { const n = Number(v || 0); return Number.isNaN(n) ? 0 : n }
const money = (n, ccy = 'USD') => { try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: ccy, maximumFractionDigits: 0 }).format(toNum(n)) } catch { return `${ccy} ${Math.round(toNum(n)).toLocaleString()}` } }
const rate = (n, ccy = 'USD') => { try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: ccy, maximumFractionDigits: 2 }).format(toNum(n)) } catch { return `${ccy} ${toNum(n).toFixed(2)}` } }
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

export default function PlacementDetailPage() {
  const { id } = useParams()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [viewInvoiceId, setViewInvoiceId] = useState(null)

  useEffect(() => {
    setLoading(true)
    api.get(`/placements/${id}/overview`).then((r) => setData(r.data.data)).catch((e) => setError(e.response?.data?.message || e.message)).finally(() => setLoading(false))
  }, [id])

  if (loading) return <div className="dashboard-page"><div className="table-card glass-card" style={{ padding: 24 }}><span className="text-muted">Loading…</span></div></div>
  if (error || !data) return <div className="dashboard-page"><div className="table-card glass-card" style={{ padding: 24 }}><span className="text-muted">{error || 'Not found'}</span></div></div>

  const p = data.placement, s = data.summary
  const ccy = p.currency || 'USD'
  const m = placementMargin(p)
  const marginPct = m.pct
  const marginSub = billingFamily(p.billing_type) === 'RATE'
    ? `${rate(m.unitMargin, ccy)}/unit`
    : `${money(m.margin, ccy)}${m.isFee ? ' fee' : '/mo'}`

  return (
    <div className="dashboard-page">
      <div style={{ marginBottom: 8 }}><Link to="/placements" className="db-link">← Back to placements</Link></div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{p.job_title}</h1>
          <p className="page-subtitle">
            {p.placement_code ? `${p.placement_code} · ` : ''}{p.candidate_name} ·{' '}
            <Link to={`/clients/${p.client_id}`} style={{ color: 'var(--primary)', textDecoration: 'none' }}>{p.client_name}</Link>
            {' '}· {p.employment_type} · {p.region_name}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Link to="/timesheets" className="secondary-btn" style={{ textDecoration: 'none' }}>⏱ Timesheets</Link>
          <span className="badge badge-gray">{p.placement_status}</span>
        </div>
      </div>

      <div className="stats-grid stats-grid-four" style={{ marginBottom: 16 }}>
        <div className="stat-card"><div className="text-muted text-sm">Bill rate</div><div className="fw-bold" style={{ fontSize: 24 }}>{rate(p.bill_rate, ccy)}</div><div className="text-muted text-sm">{BILLING_TYPE_LABELS[p.billing_type] || p.billing_type}</div></div>
        <div className="stat-card"><div className="text-muted text-sm">Pay rate</div><div className="fw-bold" style={{ fontSize: 24 }}>{rate(p.pay_rate, ccy)}</div></div>
        <div className="stat-card"><div className="text-muted text-sm">Gross margin</div><div className="fw-bold" style={{ fontSize: 24, color: marginPct >= 0 ? 'var(--success)' : 'var(--danger)' }}>{marginPct}%</div><div className="text-muted text-sm">{marginSub}</div></div>
        <div className="stat-card"><div className="text-muted text-sm">Outstanding</div><div className="fw-bold" style={{ fontSize: 24 }}>{money(s.outstanding, ccy)}</div></div>
      </div>

      <div className="db-two-eq" style={{ marginBottom: 16 }}>
        <div className="table-card glass-card">
          <div className="table-toolbar"><strong>Billing</strong></div>
          <div style={{ padding: '4px 16px 12px' }}>
            <div className="db-stat"><span className="db-stat-k">Invoiced</span><span className="db-stat-v">{money(s.invoiced, ccy)}</span></div>
            <div className="db-stat"><span className="db-stat-k">Collected</span><span className="db-stat-v" style={{ color: 'var(--success)' }}>{money(s.collected, ccy)}</span></div>
            <div className="db-stat"><span className="db-stat-k">Outstanding</span><span className="db-stat-v">{money(s.outstanding, ccy)}</span></div>
            <div className="db-stat"><span className="db-stat-k">Invoices</span><span className="db-stat-v">{s.invoice_count}</span></div>
          </div>
        </div>
        <div className="table-card glass-card">
          <div className="table-toolbar"><strong>Details</strong></div>
          <div style={{ padding: '4px 16px 12px' }}>
            <div className="db-stat"><span className="db-stat-k">Candidate</span><span className="db-stat-v">{p.candidate_name}</span></div>
            <div className="db-stat"><span className="db-stat-k">Invoice cycle</span><span className="db-stat-v">{p.invoice_cycle}</span></div>
            <div className="db-stat"><span className="db-stat-k">Payment terms</span><span className="db-stat-v">{p.payment_terms}</span></div>
            <div className="db-stat"><span className="db-stat-k">Start date</span><span className="db-stat-v">{day(p.start_date)}</span></div>
          </div>
        </div>
      </div>

      <div className="table-card glass-card">
        <div className="table-toolbar"><strong>Invoices</strong><span className="text-muted text-sm">{s.invoice_count} total</span></div>
        <div className="table-wrap">
          <table className="saas-table">
            <thead><tr><th>Invoice</th><th>Date</th><th>Due</th><th style={{ textAlign: 'right' }}>Total</th><th style={{ textAlign: 'right' }}>Outstanding</th><th>Status</th></tr></thead>
            <tbody>
              {data.invoices.length === 0 ? <tr><td colSpan={6} className="empty-row">No invoices yet.</td></tr>
              : data.invoices.map((inv) => { const t = pill(inv.invoice_status); return (
                <tr key={inv.id}>
                  <td className="td-mono"><button type="button" className="cd-linkbtn" title="View invoice details" onClick={() => setViewInvoiceId(inv.id)}>{inv.invoice_number}</button></td><td>{day(inv.invoice_date)}</td><td>{day(inv.due_date)}</td>
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
