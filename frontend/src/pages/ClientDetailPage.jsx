import { useEffect, useMemo, useState } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import api, { downloadFile } from '../services/api'
import {
  PanelHeader,
  DataTable,
  StatusChip,
  Select,
  Input,
  Textarea,
  Modal,
  SkeletonRows,
  fmt,
  fmtDateDisplay,
  customerLabel,
} from '../components/ui/index.jsx'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'
import { ACTION_ACCESS, hasAnyRole } from '../utils/acl'
import InvoiceViewModal from '../components/InvoiceViewModal'
import PaymentReceiptViewModal from '../components/PaymentReceiptViewModal'
import './DetailPage.css'

const toNum = (v) => { const n = Number(v || 0); return Number.isNaN(n) ? 0 : n }
const DUE_SOON_WINDOW_DAYS = 15

// Initials for the avatar — first letters of the first two words.
const initialsOf = (name = '') => String(name).trim().split(/\s+/).slice(0, 2)
  .map((w) => w[0]).join('').toUpperCase() || '?'

const daysBetween = (dateStr) => {
  const d = new Date(String(dateStr).slice(0, 10))
  if (Number.isNaN(d.getTime())) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((d - today) / 86400000)
}

// Derived display status for an invoice, mirroring the invoices list:
// open + dated → Overdue / Due; otherwise its stored status.
const invoiceStatusMeta = (inv) => {
  const stored = String(inv.invoice_status || '').toUpperCase()
  const open = toNum(inv.balance_outstanding) > 0 && !['PAID', 'CANCELLED'].includes(stored)
  if (open && inv.due_date) {
    const diff = daysBetween(inv.due_date)
    if (diff != null && diff < 0) return { label: `Overdue ${Math.abs(diff)} days`, tone: 'danger' }
    if (diff != null && diff <= DUE_SOON_WINDOW_DAYS) return { label: `Due in ${diff} days`, tone: 'warn' }
  }
  if (stored === 'PAID') return { label: 'Paid', tone: 'success' }
  if (stored === 'CANCELLED') return { label: 'Cancelled', tone: 'neutral' }
  if (stored === 'PARTIALLY_PAID') return { label: 'Partially paid', tone: 'warn' }
  if (!stored) return { label: 'Draft', tone: 'neutral' }
  return { label: stored.replace(/_/g, ' ').toLowerCase(), tone: 'accent' }
}

const MoneyBagIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 3h6l-1.5 3h-3L9 3Z" />
    <path d="M12 6c-3.5 3-6 5.5-6 9a6 6 0 0 0 12 0c0-3.5-2.5-6-6-9Z" />
    <path d="M12 12v4M10.5 13.5h3" />
  </svg>
)

const EMPTY_FORM = {
  client_name: '', region_id: '', currency: 'USD', client_code: '',
  billing_address: '', tax_identifier: '', credit_limit: '0',
  default_payment_terms: 'NET_30', default_invoice_cycle: 'MONTHLY',
  primary_contact_name: '', primary_contact_email: '', primary_contact_phone: '',
  status: 'ACTIVE',
}

export default function ClientDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const { user } = useAuth()
  const canManageInvoices = hasAnyRole(user?.roleName, ACTION_ACCESS.invoices.manage)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('transactions')
  const [typeFilter, setTypeFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [regions, setRegions] = useState([])
  const [editOpen, setEditOpen] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [viewInvoiceId, setViewInvoiceId] = useState(null)
  const [viewPaymentId, setViewPaymentId] = useState(null)

  const loadOverview = () => {
    setLoading(true)
    setError('')
    return api.get(`/clients/${id}/overview`)
      .then((r) => setData(r.data.data))
      .catch((e) => setError(e.response?.data?.message || e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { loadOverview() }, [id])
  useEffect(() => { api.get('/regions').then((r) => setRegions(r.data?.data || r.data || [])).catch(() => {}) }, [])

  const regionById = useMemo(() => {
    const map = {}
    regions.forEach((r) => { map[String(r.id)] = r })
    return map
  }, [regions])

  const setField = (key, value) => {
    setForm((prev) => {
      const next = { ...prev, [key]: value }
      if (key === 'region_id') {
        const region = regionById[String(value)]
        if (region?.default_currency) next.currency = region.default_currency
      }
      return next
    })
  }

  const openEdit = () => {
    const c = data.client
    setForm({
      ...EMPTY_FORM,
      ...c,
      region_id: c.region_id ? String(c.region_id) : '',
      credit_limit: c.credit_limit != null ? String(c.credit_limit) : '0',
      currency: c.currency || c.region_currency || 'USD',
    })
    setEditOpen(true)
  }

  const saveEdit = async () => {
    if (!form.client_name || !form.region_id || !form.currency) {
      toast.error('Name, region and currency are required')
      return
    }
    setSaving(true)
    try {
      await api.put(`/clients/${id}`, form)
      toast.success(`${customerLabel()} updated`)
      setEditOpen(false)
      await loadOverview()
    } catch (e) {
      toast.error(e.response?.data?.message || 'Update failed')
    } finally {
      setSaving(false)
    }
  }

  const ccy = data?.client?.currency || 'USD'

  // Unified transaction feed: invoices and payments merged and date-sorted.
  const txns = useMemo(() => {
    if (!data) return []
    const invoiceRows = (data.invoices || []).map((inv) => {
      const meta = invoiceStatusMeta(inv)
      return {
        key: `inv-${inv.id}`,
        id: inv.id,
        kind: 'invoice',
        dateRaw: String(inv.invoice_date || '').slice(0, 10),
        type: 'Invoice',
        no: inv.invoice_number,
        memo: inv.due_date ? `Due ${fmtDateDisplay(inv.due_date)}` : '—',
        amount: toNum(inv.total_amount),
        currency: inv.currency || ccy,
        statusLabel: meta.label,
        statusTone: meta.tone,
        open: toNum(inv.balance_outstanding) > 0,
      }
    })
    const paymentRows = (data.payments || []).map((p) => ({
      key: `pay-${p.id}`,
      id: p.id,
      kind: 'payment',
      dateRaw: String(p.payment_date || '').slice(0, 10),
      type: 'Payment',
      no: p.reference_number || p.invoice_number || '—',
      memo: `Payment received${p.payment_mode ? ` · ${String(p.payment_mode).replace(/_/g, ' ')}` : ''}${p.invoice_number ? ` · ${p.invoice_number}` : ''}`,
      amount: toNum(p.amount_received),
      currency: p.currency || ccy,
      statusLabel: 'Received',
      statusTone: 'success',
      open: false,
    }))
    return [...invoiceRows, ...paymentRows].sort((a, b) => (a.dateRaw < b.dateRaw ? 1 : a.dateRaw > b.dateRaw ? -1 : 0))
  }, [data, ccy])

  const filteredTxns = useMemo(() => txns.filter((t) => {
    if (typeFilter === 'invoices' && t.kind !== 'invoice') return false
    if (typeFilter === 'payments' && t.kind !== 'payment') return false
    if (statusFilter === 'open' && !t.open) return false
    if (statusFilter === 'paid' && !(t.kind === 'invoice' && !t.open)) return false
    if (statusFilter === 'overdue' && !(t.statusTone === 'danger')) return false
    return true
  }), [txns, typeFilter, statusFilter])

  const txnTotal = useMemo(() => filteredTxns.reduce((sum, t) => sum + t.amount, 0), [filteredTxns])

  const aging = useMemo(() => {
    const s = data?.summary || {}
    const rows = [
      { label: 'Current', value: toNum(s.current_bucket), color: 'var(--success)' },
      { label: '1–30', value: toNum(s.d30), color: '#2bb0a6' },
      { label: '31–60', value: toNum(s.d60), color: '#d99a1c' },
      { label: '61–90', value: toNum(s.d90), color: '#e0679b' },
      { label: '90+', value: toNum(s.d90p), color: 'var(--danger)' },
    ]
    const max = Math.max(...rows.map((r) => r.value), 1)
    return { rows, max }
  }, [data])

  if (loading) {
    return (
      <div className="dashboard-page client-detail">
        <div className="cd-header sg-card is-skeleton" />
        <div className="cd-panel sg-card"><table className="sg-skel-table"><tbody><SkeletonRows cols={6} rows={5} /></tbody></table></div>
      </div>
    )
  }
  if (error || !data) {
    return (
      <div className="dashboard-page client-detail">
        <div className="cd-back"><Link to="/clients" className="cd-backlink">← Back to {customerLabel().toLowerCase()}s</Link></div>
        <div className="cd-panel sg-card" style={{ padding: 28, textAlign: 'center', color: 'var(--muted)' }}>{error || 'Not found'}</div>
      </div>
    )
  }

  const c = data.client
  const s = data.summary
  const overdue = toNum(s.overdue)

  const txnColumns = [
    { key: 'date', header: 'Date', width: 108, render: (r) => fmtDateDisplay(r.dateRaw), sortAccessor: (r) => r.dateRaw },
    { key: 'type', header: 'Type', width: 108, render: (r) => <StatusChip tone={r.kind === 'payment' ? 'success' : 'accent'}>{r.type}</StatusChip>, sortAccessor: (r) => r.type },
    { key: 'no', header: 'No.', width: 120, mono: true, render: (r) => {
      if (r.kind === 'invoice' && r.id) return <button type="button" className="cd-linkbtn" title="View invoice details" onClick={() => setViewInvoiceId(r.id)}>{r.no}</button>
      if (r.kind === 'payment' && r.id) return <button type="button" className="cd-linkbtn" title="View receipt details" onClick={() => setViewPaymentId(r.id)}>{r.no}</button>
      return r.no
    } },
    { key: 'memo', header: 'Memo', render: (r) => <span className="cd-memo">{r.memo}</span> },
    { key: 'amount', header: 'Amount', align: 'right', mono: true, render: (r) => fmt(r.amount, r.currency), sortAccessor: (r) => r.amount },
    { key: 'status', header: 'Status', width: 148, render: (r) => <StatusChip tone={r.statusTone}>{r.statusLabel}</StatusChip>, sortAccessor: (r) => r.statusLabel },
  ]

  const placementColumns = [
    { key: 'placement_code', header: 'Code', width: 130, mono: true, primary: true, render: (r) => <Link to={`/placements/${r.id}`} className="cd-link">{r.placement_code}</Link> },
    { key: 'job_title', header: 'Role', render: (r) => r.job_title || '—' },
    { key: 'candidate_name', header: 'Candidate', render: (r) => <span className="cd-muted">{r.candidate_name || '—'}</span> },
    { key: 'bill_rate', header: 'Bill rate', align: 'right', mono: true, render: (r) => (r.bill_rate ? fmt(r.bill_rate, r.currency || ccy) : '—') },
    { key: 'placement_status', header: 'Status', width: 130, render: (r) => <StatusChip tone={String(r.placement_status).toUpperCase() === 'ACTIVE' ? 'success' : 'neutral'}>{r.placement_status}</StatusChip>, sortAccessor: (r) => r.placement_status },
  ]

  const detailFields = [
    { label: `${customerLabel()} code`, value: c.client_code },
    { label: 'Region', value: c.region_name },
    { label: 'Currency', value: ccy },
    { label: 'Payment terms', value: String(c.default_payment_terms || '—').replace(/_/g, ' ') },
    { label: 'Invoice cycle', value: String(c.default_invoice_cycle || '—').replace(/_/g, ' ') },
    { label: 'Credit limit', value: fmt(c.credit_limit, ccy) },
    { label: 'Tax identifier', value: c.tax_identifier || '—' },
    { label: 'Primary contact', value: c.primary_contact_name || '—' },
    { label: 'Contact email', value: c.primary_contact_email || '—' },
    { label: 'Contact phone', value: c.primary_contact_phone || '—' },
  ]

  return (
    <div className="dashboard-page client-detail">
      <div className="cd-back"><Link to="/clients" className="cd-backlink">← Back to {customerLabel().toLowerCase()}s</Link></div>

      {/* Identity + contact + financial summary */}
      <div className="cd-header sg-card">
        <div className="cd-identity">
          <div className="cd-avatar">{initialsOf(c.client_name)}</div>
          <div className="cd-identity-body">
            <h1 className="cd-name">{c.client_name}</h1>
            <div className="cd-sub">{[c.client_code, c.region_name].filter(Boolean).join(' · ')}</div>
            <StatusChip tone={String(c.status).toUpperCase() === 'ACTIVE' ? 'success' : 'neutral'}>{c.status}</StatusChip>
            <div className="cd-quick">
              <button type="button" className="cd-editbtn" onClick={openEdit} title="Edit details">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                Edit
              </button>
              <button type="button" className="cd-quickbtn" onClick={() => navigate('/invoices')} title="New invoice">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3v4h4" /><path d="M6 3h8l4 4v14H6z" /><path d="M12 11v6M9 14h6" /></svg>
              </button>
              <button type="button" className="cd-quickbtn" onClick={() => navigate('/payments')} title="Record payment">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 10h18M7 15h3" /></svg>
              </button>
              <button type="button" className="cd-quickbtn" onClick={() => downloadFile(`/reports/exports/client-statement?client_id=${c.id}`, `statement-${c.client_code || c.id}.csv`)} title="Export statement">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12m0 0 4-4m-4 4-4-4" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>
              </button>
            </div>
          </div>
        </div>

        <div className="cd-contact">
          <div className="cd-field">
            <span className="cd-flabel">Email</span>
            <span className="cd-fvalue">{c.primary_contact_email || <span className="cd-empty">No email on file</span>}</span>
          </div>
          <div className="cd-field">
            <span className="cd-flabel">Phone</span>
            <span className="cd-fvalue">{c.primary_contact_phone || <span className="cd-empty">No phone on file</span>}</span>
          </div>
          <div className="cd-field">
            <span className="cd-flabel">Billing address</span>
            <span className="cd-fvalue">{c.billing_address || <span className="cd-empty">No address on file</span>}</span>
          </div>
          <div className="cd-field">
            <span className="cd-flabel">Terms</span>
            <span className="cd-fvalue">{String(c.default_payment_terms || '—').replace(/_/g, ' ')} · {String(c.default_invoice_cycle || '—').replace(/_/g, ' ')}</span>
          </div>
        </div>

        <div className="cd-summary">
          <div className="cd-summary-head"><MoneyBagIcon /> Financial summary</div>
          <div className="cd-summary-item">
            <div className="cd-summary-row"><span className="cd-dot cd-dot-amber" /> Open balance</div>
            <div className="cd-summary-val">{fmt(s.outstanding, ccy)}</div>
          </div>
          <div className="cd-summary-item">
            <div className="cd-summary-row"><span className="cd-dot cd-dot-red" /> Overdue payment</div>
            <div className={`cd-summary-val${overdue > 0 ? ' is-danger' : ''}`}>{fmt(overdue, ccy)}</div>
          </div>
        </div>
      </div>

      {/* Tabbed panel */}
      <div className="cd-panel sg-card">
        <PanelHeader
          title={c.client_name}
          tabs={[
            { key: 'transactions', label: 'Transaction List', count: txns.length },
            { key: 'placements', label: 'Placements', count: (data.placements || []).length },
            { key: 'details', label: 'Customer Details' },
          ]}
          activeTab={tab}
          onTab={setTab}
        />

        {tab === 'transactions' && (
          <>
            <div className="cd-filters">
              <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                <option value="all">All transactions</option>
                <option value="invoices">Invoices only</option>
                <option value="payments">Payments only</option>
              </Select>
              <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="all">All statuses</option>
                <option value="open">Open</option>
                <option value="paid">Paid</option>
                <option value="overdue">Overdue</option>
              </Select>
            </div>
            <DataTable
              columns={txnColumns}
              rows={filteredTxns}
              getRowId={(r) => r.key}
              paginate
              pageLabel="transactions"
              defaultSort={{ key: 'date', dir: 'desc' }}
              empty="No transactions for this customer"
              footer={[
                { colSpan: 4, align: 'left', render: () => `Total · ${filteredTxns.length} transaction${filteredTxns.length === 1 ? '' : 's'}` },
                { colSpan: 1, align: 'right', mono: true, render: () => fmt(txnTotal, ccy) },
                { colSpan: 1, render: () => null },
              ]}
            />
          </>
        )}

        {tab === 'placements' && (
          <DataTable
            columns={placementColumns}
            rows={data.placements || []}
            getRowId={(r) => r.id}
            paginate
            pageLabel="placements"
            empty="No placements for this customer"
          />
        )}

        {tab === 'details' && (
          <div className="cd-details">
            <div className="cd-details-grid">
              {detailFields.map((f) => (
                <div key={f.label} className="cd-field">
                  <span className="cd-flabel">{f.label}</span>
                  <span className="cd-fvalue">{f.value}</span>
                </div>
              ))}
            </div>
            <div className="cd-aging">
              <div className="cd-aging-head">Receivables aging</div>
              {aging.rows.map((r) => (
                <div key={r.label} className="cd-age-row">
                  <span className="cd-age-label">{r.label}</span>
                  <span className="cd-age-track"><span className="cd-age-fill" style={{ width: `${Math.max(2, Math.round((r.value / aging.max) * 100))}%`, background: r.color }} /></span>
                  <span className="cd-age-val">{fmt(r.value, ccy)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <InvoiceViewModal
        invoiceId={viewInvoiceId}
        onClose={() => setViewInvoiceId(null)}
        canEdit={canManageInvoices}
        onEdit={(inv) => navigate(`/invoices?edit=${inv.id}`)}
      />

      <PaymentReceiptViewModal
        paymentId={viewPaymentId}
        onClose={() => setViewPaymentId(null)}
      />

      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={`Edit ${customerLabel().toLowerCase()} details`}
        maxWidth={720}
        footer={(
          <div className="cd-modal-actions">
            <button type="button" className="secondary-btn" onClick={() => setEditOpen(false)}>Cancel</button>
            <button type="button" className="primary-btn" onClick={saveEdit} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
          </div>
        )}
      >
        <div className="cd-form-grid">
          <Input label={`${customerLabel()} name`} required value={form.client_name} onChange={(e) => setField('client_name', e.target.value)} />
          <Select label="Region" required value={form.region_id} onChange={(e) => setField('region_id', e.target.value)}>
            <option value="">Select region</option>
            {regions.map((r) => <option key={r.id} value={String(r.id)}>{r.region_name}</option>)}
          </Select>
          <Input label="Currency" value={form.currency} readOnly hint="Set by the region" />
          <Select label="Status" value={form.status} onChange={(e) => setField('status', e.target.value)}>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </Select>
          <Input label="Primary contact" value={form.primary_contact_name || ''} onChange={(e) => setField('primary_contact_name', e.target.value)} />
          <Input label="Contact email" type="email" value={form.primary_contact_email || ''} onChange={(e) => setField('primary_contact_email', e.target.value)} />
          <Input label="Phone" value={form.primary_contact_phone || ''} onChange={(e) => setField('primary_contact_phone', e.target.value)} />
          <Input label="Tax identifier" value={form.tax_identifier || ''} onChange={(e) => setField('tax_identifier', e.target.value)} />
          <Select label="Payment terms" value={form.default_payment_terms} onChange={(e) => setField('default_payment_terms', e.target.value)}>
            <option value="NET_15">Net 15</option>
            <option value="NET_30">Net 30</option>
            <option value="NET_45">Net 45</option>
          </Select>
          <Select label="Invoice cycle" value={form.default_invoice_cycle} onChange={(e) => setField('default_invoice_cycle', e.target.value)}>
            <option value="WEEKLY">Weekly</option>
            <option value="BIWEEKLY">Bi-Weekly</option>
            <option value="MONTHLY">Monthly</option>
          </Select>
          <Input label="Credit limit" type="number" value={form.credit_limit} onChange={(e) => setField('credit_limit', e.target.value)} />
          <div className="cd-form-full">
            <Textarea label="Billing address" rows={2} value={form.billing_address || ''} onChange={(e) => setField('billing_address', e.target.value)} />
          </div>
        </div>
      </Modal>
    </div>
  )
}
